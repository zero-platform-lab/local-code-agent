// npx vitest run core/tools/__tests__/searchFilesTool.spec.ts
//
// search_files は **リポジトリ全体に正規表現をかけて中身を覗く** ツール。C0 が 0% で、
// 必須パラメータ欠落・承認拒否・例外といった経路が一度も試されていなかった。
//
// ここで固定する不変条件:
//   1. path / regex が欠けたら regexSearchFiles は 1 度も呼ばれない（無駄な走査をしない）
//   2. **承認を通らない限り検索結果をモデルへ返さない**（pushToolResult されない）。
//      検索自体はプレビュー生成のため承認前に走るが、結果の露出は承認後だけ。
//   3. agentignore は rooIgnoreController として regexSearchFiles に渡され、除外は
//      ripgrep 層で行われる（この tool は controller を素通しするだけ＝その事実を固定）
//   4. ワークスペース外パスは isOutsideWorkspace フラグで告知されるが、tool 自身は
//      ハードブロックしない（承認ゲートに委ねる）＝現状を characterization test で固定
//
// 本物の ripgrep は絶対に起動しない（regexSearchFiles を丸ごと贋物にする）。

import path from "path"

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ToolUse } from "../../../shared/tools"

vi.mock("../../../services/ripgrep", () => ({ regexSearchFiles: vi.fn(async () => "SEARCH_RESULTS") }))
vi.mock("../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: vi.fn(() => false) }))

import { regexSearchFiles } from "../../../services/ripgrep"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { SearchFilesTool } from "../SearchFilesTool"

const mockedSearch = vi.mocked(regexSearchFiles)
const mockedOutside = vi.mocked(isPathOutsideWorkspace)

function makeHost() {
	const ignoreController = { validateAccess: vi.fn(() => true) }
	const host = {
		cwd: path.join(path.sep, "repo"),
		stream: { didToolFailInCurrentTurn: false },
		mistakeTracker: { count: 0 },
		tokenUsageTracker: { recordToolError: vi.fn(), recordToolUsage: vi.fn() },
		sayAndCreateMissingParamError: vi.fn(async (_t: string, p: string) => `missing:${p}`),
		ask: vi.fn(async (..._a: unknown[]) => ({ response: "yesButtonClicked" as const })),
		rooIgnoreController: ignoreController,
	}
	return { host, ignoreController }
}

function makeCallbacks(approve = true) {
	return {
		askApproval: vi.fn(async (..._a: unknown[]) => approve),
		handleError: vi.fn(async (..._a: unknown[]) => {}),
		pushToolResult: vi.fn((..._a: unknown[]) => {}),
	}
}

const run = (params: Record<string, unknown>, host: unknown, cb: unknown) =>
	new SearchFilesTool().execute(params as never, host as never, cb as never)

beforeEach(() => {
	vi.clearAllMocks()
	mockedSearch.mockResolvedValue("SEARCH_RESULTS")
	mockedOutside.mockReturnValue(false)
})

describe("SearchFilesTool - 必須パラメータ", () => {
	it("path が欠けたら検索も承認も走らない", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks()

		await run({ path: "", regex: "TODO" }, host, cb)

		expect(mockedSearch).not.toHaveBeenCalled()
		expect(cb.askApproval).not.toHaveBeenCalled()
		expect(cb.pushToolResult).toHaveBeenCalledWith("missing:path")
		expect(host.mistakeTracker.count).toBe(1)
		expect(host.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("search_files")
		expect(host.stream.didToolFailInCurrentTurn).toBe(true)
		expect(host.sayAndCreateMissingParamError).toHaveBeenCalledWith("search_files", "path")
	})

	it("regex が欠けたら検索も承認も走らない", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks()

		await run({ path: "src", regex: "" }, host, cb)

		expect(mockedSearch).not.toHaveBeenCalled()
		expect(cb.askApproval).not.toHaveBeenCalled()
		expect(cb.pushToolResult).toHaveBeenCalledWith("missing:regex")
		expect(host.mistakeTracker.count).toBe(1)
		expect(host.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("search_files")
		expect(host.stream.didToolFailInCurrentTurn).toBe(true)
		expect(host.sayAndCreateMissingParamError).toHaveBeenCalledWith("search_files", "regex")
	})
})

describe("SearchFilesTool - 承認ゲート", () => {
	it("承認されたら結果をモデルへ返し、mistake カウンタを 0 に戻す", async () => {
		const { host, ignoreController } = makeHost()
		host.mistakeTracker.count = 3
		const cb = makeCallbacks(true)

		await run({ path: "src", regex: "TODO", file_pattern: "*.ts" }, host, cb)

		// cwd, 絶対パス, regex, filePattern, rooIgnoreController を素通ししていること
		expect(mockedSearch).toHaveBeenCalledWith(
			host.cwd,
			path.resolve(host.cwd, "src"),
			"TODO",
			"*.ts",
			ignoreController,
		)
		expect(cb.pushToolResult).toHaveBeenCalledWith("SEARCH_RESULTS")
		expect(host.mistakeTracker.count).toBe(0)
	})

	it("拒否されたら検索結果をモデルへ返さない（露出は承認後のみ）", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks(false)

		await run({ path: "src", regex: "SECRET" }, host, cb)

		// プレビュー生成のため検索自体は走るが、結果は push されない
		expect(mockedSearch).toHaveBeenCalledTimes(1)
		expect(cb.pushToolResult).not.toHaveBeenCalled()
	})

	it("file_pattern が null なら undefined として regexSearchFiles に渡す", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks(true)

		await run({ path: "src", regex: "TODO", file_pattern: null }, host, cb)

		expect(mockedSearch).toHaveBeenCalledWith(
			host.cwd,
			path.resolve(host.cwd, "src"),
			"TODO",
			undefined,
			host.rooIgnoreController,
		)
	})
})

describe("SearchFilesTool - ワークスペース外の告知", () => {
	it("外部パスは isOutsideWorkspace:true を承認メッセージに載せる（ハードブロックはしない）", async () => {
		const { host } = makeHost()
		mockedOutside.mockReturnValue(true)
		const cb = makeCallbacks(true)

		await run({ path: "../outside", regex: "TODO" }, host, cb)

		const msg = JSON.parse(cb.askApproval.mock.calls[0][1] as string)
		expect(msg.isOutsideWorkspace).toBe(true)
		// フラグを立てるだけで、承認されれば検索・露出は行う
		expect(cb.pushToolResult).toHaveBeenCalledWith("SEARCH_RESULTS")
	})
})

describe("SearchFilesTool - 例外処理", () => {
	it("regexSearchFiles が投げたら handleError に委ね、結果は push しない", async () => {
		const { host } = makeHost()
		const boom = new Error("ripgrep failed")
		mockedSearch.mockRejectedValue(boom)
		const cb = makeCallbacks(true)

		await run({ path: "src", regex: "TODO" }, host, cb)

		expect(cb.handleError).toHaveBeenCalledWith("searching files", boom)
		expect(cb.pushToolResult).not.toHaveBeenCalled()
	})
})

describe("SearchFilesTool - handlePartial", () => {
	const block = (params: Record<string, unknown>, partial = true): ToolUse<"search_files"> =>
		({ type: "tool_use", name: "search_files", params, partial }) as never

	it("path 指定ありでプレビューを ask する", async () => {
		const { host } = makeHost()

		await new SearchFilesTool().handlePartial(
			host as never,
			block({ path: "src", regex: "TODO", file_pattern: "*.ts" }),
		)

		expect(host.ask).toHaveBeenCalledWith("tool", expect.any(String), true)
		const msg = JSON.parse(host.ask.mock.calls[0][1] as string)
		expect(msg.tool).toBe("searchFiles")
		expect(msg.regex).toBe("TODO")
		expect(msg.filePattern).toBe("*.ts")
	})

	it("path/regex/file_pattern 未指定でも cwd を使い空文字で埋める", async () => {
		const { host } = makeHost()

		await new SearchFilesTool().handlePartial(host as never, block({}))

		const msg = JSON.parse(host.ask.mock.calls[0][1] as string)
		expect(msg.regex).toBe("")
		expect(msg.filePattern).toBe("")
		// path 未指定でも例外にならず ask される
		expect(host.ask).toHaveBeenCalledWith("tool", expect.any(String), true)
	})

	it("ask が投げても握りつぶす（partial 表示の失敗で本処理を止めない）", async () => {
		const { host } = makeHost()
		host.ask.mockRejectedValueOnce(new Error("ask blew up"))

		await expect(
			new SearchFilesTool().handlePartial(host as never, block({ path: "src", regex: "TODO" })),
		).resolves.toBeUndefined()
	})
})
