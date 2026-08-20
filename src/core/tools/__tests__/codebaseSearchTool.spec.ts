// npx vitest run core/tools/__tests__/codebaseSearchTool.spec.ts
//
// codebase_search は **埋め込み検索（内部で Qdrant / OpenAI 等の外部サービス）へ問い合わせる**
// ツール。C0 が 0% で、承認拒否・設定不備・例外の経路が一度も試されていなかった。
//
// ここで固定する不変条件（外部接続に関わる最重要点）:
//   1. **利用者が拒否したら searchIndex は 1 度も呼ばれない**。CodeIndexManager にすら触れず、
//      埋め込み/Qdrant への接続は発生しない（承認ゲートの不変条件）
//   2. **設定不備（feature 無効 / 未設定）のとき searchIndex を呼ばない**＝無確認で外部へ出ない。
//      未設定は throw で止まり handleError に落ちる
//   3. workspace path が決められないときは検索に入らず handleError で止まる
//   4. query が欠けたら承認も検索も走らない
//
// 外部は全モック。CodeIndexManager.searchIndex は vi.fn で、**本物のネットワークには一切
// 出ない**（vitest.setup で nock.disableNetConnect も効いている）。

import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import type { ToolUse } from "../../../shared/tools"
import type { VectorStoreSearchResult } from "../../../services/code-index/interfaces"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: vi.fn() },
}))
vi.mock("../../../utils/path", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/path")>()),
	getWorkspacePath: vi.fn(() => "/repo"),
}))
vi.mock("../../prompts/responses", () => ({
	formatResponse: { toolDenied: vi.fn(() => "DENIED") },
}))

import { CodeIndexManager } from "../../../services/code-index/manager"
import { getWorkspacePath } from "../../../utils/path"
import { CodebaseSearchTool } from "../CodebaseSearchTool"

const mockedGetInstance = vi.mocked(CodeIndexManager.getInstance)
const mockedGetWorkspacePath = vi.mocked(getWorkspacePath)

/** manager 贋物。feature フラグと searchIndex の戻り値を差し替えられる。 */
function makeManager(opts: { enabled?: boolean; configured?: boolean; results?: VectorStoreSearchResult[] } = {}) {
	return {
		isFeatureEnabled: opts.enabled ?? true,
		isFeatureConfigured: opts.configured ?? true,
		searchIndex: vi.fn(async () => opts.results ?? []),
	}
}

function makeHost(opts: { cwd?: string; hasContext?: boolean } = {}) {
	const host = {
		cwd: opts.cwd ?? "/repo",
		stream: { didToolFailInCurrentTurn: false },
		mistakeTracker: { count: 0 },
		tokenUsageTracker: { recordToolError: vi.fn(), recordToolUsage: vi.fn() },
		sayAndCreateMissingParamError: vi.fn(async (_t: string, p: string) => `missing:${p}`),
		say: vi.fn(async (..._a: unknown[]) => undefined),
		ask: vi.fn(async (..._a: unknown[]) => ({ response: "yesButtonClicked" as const })),
		providerRef: {
			deref: vi.fn(() => ((opts.hasContext ?? true) ? { context: { fake: "ctx" } } : { context: undefined })),
		},
	}
	return host
}

function makeCallbacks(approve = true) {
	return {
		askApproval: vi.fn(async (..._a: unknown[]) => approve),
		handleError: vi.fn(async (..._a: unknown[]) => {}),
		pushToolResult: vi.fn((..._a: unknown[]) => {}),
	}
}

const run = (params: Record<string, unknown>, host: unknown, cb: unknown) =>
	new CodebaseSearchTool().execute(params as never, host as never, cb as never)

beforeEach(() => {
	vi.clearAllMocks()
	mockedGetWorkspacePath.mockReturnValue("/repo")
	;(vscode.workspace as any).asRelativePath = vi.fn((p: string) => `rel/${p}`)
})

describe("CodebaseSearchTool - 入口のガード", () => {
	it("workspace path を決められないと検索に入らず handleError で止まる", async () => {
		const host = makeHost({ cwd: "" })
		mockedGetWorkspacePath.mockReturnValue("")
		const cb = makeCallbacks(true)

		await run({ query: "foo" }, host, cb)

		expect(cb.handleError).toHaveBeenCalledWith("codebase_search", expect.any(Error))
		expect((cb.handleError.mock.calls[0][1] as Error).message).toContain("Could not determine workspace path")
		expect(cb.askApproval).not.toHaveBeenCalled()
		expect(mockedGetInstance).not.toHaveBeenCalled()
	})

	it("query が欠けたら承認も検索も走らない", async () => {
		const host = makeHost()
		const cb = makeCallbacks(true)

		await run({ query: "" }, host, cb)

		expect(cb.pushToolResult).toHaveBeenCalledWith("missing:query")
		expect(host.mistakeTracker.count).toBe(1)
		expect(host.stream.didToolFailInCurrentTurn).toBe(true)
		expect(host.sayAndCreateMissingParamError).toHaveBeenCalledWith("codebase_search", "query")
		expect(cb.askApproval).not.toHaveBeenCalled()
		expect(mockedGetInstance).not.toHaveBeenCalled()
	})
})

describe("CodebaseSearchTool - 承認ゲート（外部接続の不変条件）", () => {
	it("拒否したら CodeIndexManager にすら触れず、埋め込み/Qdrant へ接続しない", async () => {
		const host = makeHost()
		const manager = makeManager({ results: [] })
		mockedGetInstance.mockReturnValue(manager as never)
		const cb = makeCallbacks(false)

		await run({ query: "foo" }, host, cb)

		expect(cb.pushToolResult).toHaveBeenCalledWith("DENIED")
		expect(mockedGetInstance).not.toHaveBeenCalled()
		expect(manager.searchIndex).not.toHaveBeenCalled()
	})

	it("承認後に mistake カウンタを 0 に戻す", async () => {
		const host = makeHost()
		host.mistakeTracker.count = 4
		const manager = makeManager({ results: [] })
		mockedGetInstance.mockReturnValue(manager as never)
		const cb = makeCallbacks(true)

		await run({ query: "foo" }, host, cb)

		expect(host.mistakeTracker.count).toBe(0)
	})
})

describe("CodebaseSearchTool - 設定不備では外部へ出ない", () => {
	it("Extension context が無ければ throw → handleError（検索なし）", async () => {
		const host = makeHost({ hasContext: false })
		const cb = makeCallbacks(true)

		await run({ query: "foo" }, host, cb)

		expect(cb.handleError).toHaveBeenCalledWith("codebase_search", expect.any(Error))
		expect((cb.handleError.mock.calls[0][1] as Error).message).toContain("Extension context is not available")
	})

	it("CodeIndexManager が取得できなければ throw → handleError（検索なし）", async () => {
		const host = makeHost()
		mockedGetInstance.mockReturnValue(undefined)
		const cb = makeCallbacks(true)

		await run({ query: "foo" }, host, cb)

		expect((cb.handleError.mock.calls[0][1] as Error).message).toContain("CodeIndexManager is not available")
	})

	it("feature が無効なら searchIndex を呼ばずに throw する", async () => {
		const host = makeHost()
		const manager = makeManager({ enabled: false })
		mockedGetInstance.mockReturnValue(manager as never)
		const cb = makeCallbacks(true)

		await run({ query: "foo" }, host, cb)

		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect((cb.handleError.mock.calls[0][1] as Error).message).toContain("Code Indexing is disabled")
	})

	it("未設定（キー/URL 欠落）なら searchIndex を呼ばずに throw する", async () => {
		const host = makeHost()
		const manager = makeManager({ enabled: true, configured: false })
		mockedGetInstance.mockReturnValue(manager as never)
		const cb = makeCallbacks(true)

		await run({ query: "foo" }, host, cb)

		expect(manager.searchIndex).not.toHaveBeenCalled()
		expect((cb.handleError.mock.calls[0][1] as Error).message).toContain("not configured")
	})
})

describe("CodebaseSearchTool - 検索結果の整形", () => {
	const payloadResult = (over: Partial<VectorStoreSearchResult> = {}): VectorStoreSearchResult => ({
		id: "1",
		score: 0.9,
		payload: { filePath: "/repo/src/a.ts", codeChunk: "  const a = 1  ", startLine: 10, endLine: 12 },
		...over,
	})

	it("結果ゼロなら『見つからない』を返し、say はしない", async () => {
		const host = makeHost()
		const manager = makeManager({ results: [] })
		mockedGetInstance.mockReturnValue(manager as never)
		const cb = makeCallbacks(true)

		await run({ query: "foo" }, host, cb)

		expect(manager.searchIndex).toHaveBeenCalledWith("foo", undefined)
		expect(cb.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No relevant code snippets found"))
		expect(host.say).not.toHaveBeenCalled()
	})

	it("payload の無い/ filePath の無い結果は捨て、有効な結果だけ整形する", async () => {
		const host = makeHost()
		const results: VectorStoreSearchResult[] = [
			{ id: "no-payload", score: 0.5, payload: null },
			{ id: "no-filepath", score: 0.4, payload: { codeChunk: "x", startLine: 1, endLine: 2 } as never },
			payloadResult(),
		]
		const manager = makeManager({ results })
		mockedGetInstance.mockReturnValue(manager as never)
		const cb = makeCallbacks(true)

		await run({ query: "foo", path: "src" }, host, cb)

		// directoryPrefix が searchIndex へ渡る
		expect(manager.searchIndex).toHaveBeenCalledWith("foo", "src")

		// say に載る JSON では有効な 1 件だけ、codeChunk は trim、filePath は asRelativePath 変換
		const sayPayload = JSON.parse(host.say.mock.calls[0][1] as string)
		expect(host.say.mock.calls[0][0]).toBe("codebase_search_result")
		expect(sayPayload.content.results).toHaveLength(1)
		expect(sayPayload.content.results[0].filePath).toBe("rel//repo/src/a.ts")
		expect(sayPayload.content.results[0].codeChunk).toBe("const a = 1")

		// モデルへ返す本文にも整形済みの内容が載る
		const pushed = cb.pushToolResult.mock.calls[0][0] as string
		expect(pushed).toContain("Query: foo")
		expect(pushed).toContain("File path: rel//repo/src/a.ts")
		expect(pushed).toContain("Lines: 10-12")
		expect(pushed).toContain("const a = 1")
	})

	it("searchIndex が投げたら handleError に委ねる", async () => {
		const host = makeHost()
		const manager = makeManager()
		manager.searchIndex.mockRejectedValue(new Error("qdrant down"))
		mockedGetInstance.mockReturnValue(manager as never)
		const cb = makeCallbacks(true)

		await run({ query: "foo" }, host, cb)

		expect(cb.handleError).toHaveBeenCalledWith("codebase_search", expect.any(Error))
		expect((cb.handleError.mock.calls[0][1] as Error).message).toContain("qdrant down")
	})
})

describe("CodebaseSearchTool - handlePartial", () => {
	const block = (params: Record<string, unknown>, partial = true): ToolUse<"codebase_search"> =>
		({ type: "tool_use", name: "codebase_search", params, partial }) as never

	it("query/path を載せて ask する", async () => {
		const host = makeHost()

		await new CodebaseSearchTool().handlePartial(host as never, block({ query: "foo", path: "src" }))

		const msg = JSON.parse(host.ask.mock.calls[0][1] as string)
		expect(msg.tool).toBe("codebaseSearch")
		expect(msg.query).toBe("foo")
		expect(msg.path).toBe("src")
		expect(host.ask).toHaveBeenCalledWith("tool", expect.any(String), true)
	})

	it("ask が投げても握りつぶす", async () => {
		const host = makeHost()
		host.ask.mockRejectedValueOnce(new Error("ask blew up"))

		await expect(
			new CodebaseSearchTool().handlePartial(host as never, block({ query: "foo" })),
		).resolves.toBeUndefined()
	})
})
