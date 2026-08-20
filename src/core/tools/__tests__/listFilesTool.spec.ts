// npx vitest run core/tools/__tests__/listFilesTool.spec.ts
//
// list_files は **ディレクトリの中身を列挙して** モデルへ渡すツール。C0 が 0% で、
// 必須パラメータ欠落・承認拒否・例外の経路が一度も試されていなかった。
//
// ここで固定する不変条件:
//   1. path が欠けたら listFiles は 1 度も呼ばれない（無駄な走査をしない）
//   2. **承認を通らない限り一覧をモデルへ返さない**（pushToolResult されない）
//   3. agentignore / protected の除外は formatFilesList に controller を渡して委譲する
//      （この tool は controller と showAgentIgnoredFiles を素通しする＝その事実を固定）
//   4. recursive フラグと listFilesTopLevel / listFilesRecursive の対応
//
// 本物の fs 走査（listFiles）は絶対に起動しない（丸ごと贋物にする）。

import path from "path"

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ToolUse } from "../../../shared/tools"

vi.mock("../../../services/glob/list-files", () => ({ listFiles: vi.fn(async () => [["a.ts", "b.ts"], false]) }))
vi.mock("../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: vi.fn(() => false) }))
vi.mock("../../prompts/responses", () => ({
	formatResponse: { formatFilesList: vi.fn(() => "FILE_LIST") },
}))

import { listFiles } from "../../../services/glob/list-files"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { formatResponse } from "../../prompts/responses"
import { ListFilesTool } from "../ListFilesTool"

const mockedList = vi.mocked(listFiles)
const mockedOutside = vi.mocked(isPathOutsideWorkspace)
const mockedFormat = vi.mocked(formatResponse.formatFilesList)

function makeHost(opts: { showAgentIgnoredFiles?: boolean; noState?: boolean } = {}) {
	const ignoreController = { validateAccess: vi.fn(() => true) }
	const protectedController = { isWriteProtected: vi.fn(() => false) }
	const host = {
		cwd: path.join(path.sep, "repo"),
		stream: { didToolFailInCurrentTurn: false },
		mistakeTracker: { count: 0 },
		tokenUsageTracker: { recordToolError: vi.fn(), recordToolUsage: vi.fn() },
		sayAndCreateMissingParamError: vi.fn(async (_t: string, p: string) => `missing:${p}`),
		ask: vi.fn(async (..._a: unknown[]) => ({ response: "yesButtonClicked" as const })),
		rooIgnoreController: ignoreController,
		rooProtectedController: protectedController,
		providerRef: {
			deref: vi.fn(() =>
				opts.noState
					? undefined
					: { getState: vi.fn(async () => ({ showAgentIgnoredFiles: opts.showAgentIgnoredFiles ?? false })) },
			),
		},
	}
	return { host, ignoreController, protectedController }
}

function makeCallbacks(approve = true) {
	return {
		askApproval: vi.fn(async (..._a: unknown[]) => approve),
		handleError: vi.fn(async (..._a: unknown[]) => {}),
		pushToolResult: vi.fn((..._a: unknown[]) => {}),
	}
}

const run = (params: Record<string, unknown>, host: unknown, cb: unknown) =>
	new ListFilesTool().execute(params as never, host as never, cb as never)

beforeEach(() => {
	vi.clearAllMocks()
	mockedList.mockResolvedValue([["a.ts", "b.ts"], false])
	mockedOutside.mockReturnValue(false)
	mockedFormat.mockReturnValue("FILE_LIST")
})

describe("ListFilesTool - 必須パラメータ", () => {
	it("path が欠けたら列挙も承認も走らない", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks()

		await run({ path: "" }, host, cb)

		expect(mockedList).not.toHaveBeenCalled()
		expect(cb.askApproval).not.toHaveBeenCalled()
		expect(cb.pushToolResult).toHaveBeenCalledWith("missing:path")
		expect(host.mistakeTracker.count).toBe(1)
		expect(host.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("list_files")
		expect(host.stream.didToolFailInCurrentTurn).toBe(true)
		expect(host.sayAndCreateMissingParamError).toHaveBeenCalledWith("list_files", "path")
	})
})

describe("ListFilesTool - 承認ゲート", () => {
	it("承認されたら一覧をモデルへ返し、mistake カウンタを 0 に戻す", async () => {
		const { host, ignoreController, protectedController } = makeHost({ showAgentIgnoredFiles: true })
		host.mistakeTracker.count = 5
		const cb = makeCallbacks(true)

		await run({ path: "src", recursive: true }, host, cb)

		const abs = path.resolve(host.cwd, "src")
		expect(mockedList).toHaveBeenCalledWith(abs, true, 200)
		expect(mockedFormat).toHaveBeenCalledWith(
			abs,
			["a.ts", "b.ts"],
			false,
			ignoreController,
			true,
			protectedController,
		)
		expect(cb.pushToolResult).toHaveBeenCalledWith("FILE_LIST")
		expect(host.mistakeTracker.count).toBe(0)

		const msg = JSON.parse(cb.askApproval.mock.calls[0][1] as string)
		expect(msg.tool).toBe("listFilesRecursive")
		expect(msg.content).toBe("FILE_LIST")
	})

	it("recursive 省略時は top-level 表示＆listFiles に false を渡す", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks(true)

		await run({ path: "src" }, host, cb)

		expect(mockedList).toHaveBeenCalledWith(path.resolve(host.cwd, "src"), false, 200)
		const msg = JSON.parse(cb.askApproval.mock.calls[0][1] as string)
		expect(msg.tool).toBe("listFilesTopLevel")
	})

	it("拒否されたら一覧をモデルへ返さない", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks(false)

		await run({ path: "src" }, host, cb)

		expect(cb.pushToolResult).not.toHaveBeenCalled()
	})

	it("provider state が取れないと showAgentIgnoredFiles は既定 false", async () => {
		const { host } = makeHost({ noState: true })
		const cb = makeCallbacks(true)

		await run({ path: "src" }, host, cb)

		// formatFilesList の 5 番目の引数（showAgentIgnoredFiles）が false
		expect(mockedFormat.mock.calls[0][4]).toBe(false)
	})
})

describe("ListFilesTool - ワークスペース外の告知", () => {
	it("外部パスは isOutsideWorkspace:true を承認メッセージに載せる", async () => {
		const { host } = makeHost()
		mockedOutside.mockReturnValue(true)
		const cb = makeCallbacks(true)

		await run({ path: "../outside" }, host, cb)

		const msg = JSON.parse(cb.askApproval.mock.calls[0][1] as string)
		expect(msg.isOutsideWorkspace).toBe(true)
	})
})

describe("ListFilesTool - 例外処理", () => {
	it("listFiles が投げたら handleError に委ね、結果は push しない", async () => {
		const { host } = makeHost()
		const boom = new Error("scan failed")
		mockedList.mockRejectedValue(boom)
		const cb = makeCallbacks(true)

		await run({ path: "src" }, host, cb)

		expect(cb.handleError).toHaveBeenCalledWith("listing files", boom)
		expect(cb.pushToolResult).not.toHaveBeenCalled()
	})
})

describe("ListFilesTool - handlePartial", () => {
	const block = (params: Record<string, unknown>, partial = true): ToolUse<"list_files"> =>
		({ type: "tool_use", name: "list_files", params, partial }) as never

	it("recursive='true'（大小無視）は listFilesRecursive で ask する", async () => {
		const { host } = makeHost()

		await new ListFilesTool().handlePartial(host as never, block({ path: "src", recursive: "TRUE" }))

		const msg = JSON.parse(host.ask.mock.calls[0][1] as string)
		expect(msg.tool).toBe("listFilesRecursive")
		expect(host.ask).toHaveBeenCalledWith("tool", expect.any(String), true)
	})

	it("recursive なし & path なしでも cwd を使い top-level で ask する", async () => {
		const { host } = makeHost()

		await new ListFilesTool().handlePartial(host as never, block({}))

		const msg = JSON.parse(host.ask.mock.calls[0][1] as string)
		expect(msg.tool).toBe("listFilesTopLevel")
		expect(host.ask).toHaveBeenCalledWith("tool", expect.any(String), true)
	})

	it("ask が投げても握りつぶす", async () => {
		const { host } = makeHost()
		host.ask.mockRejectedValueOnce(new Error("ask blew up"))

		await expect(new ListFilesTool().handlePartial(host as never, block({ path: "src" }))).resolves.toBeUndefined()
	})
})
