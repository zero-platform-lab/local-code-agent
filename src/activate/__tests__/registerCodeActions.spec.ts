// npx vitest run activate/__tests__/registerCodeActions.spec.ts
//
// registerCodeActions は 4 つのコードアクション用コマンドを登録する。
// 不変条件:
//   1. explainCode / fixCode / improveCode / addToContext の 4 本を、それぞれ
//      1 度だけ登録し、Disposable を context.subscriptions に載せる（dispose で解除）
//   2. コードアクション経由（引数あり）とコマンドパレット経由（引数なし→エディタ文脈取得）の
//      両方で ClineProvider.handleCodeAction に正しいパラメータを渡す
//   3. コマンドパレット経由でエディタ文脈が無ければ何もしない（落ちない）

import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
	registerCommand: vi.fn((_id: string, _cb: unknown) => ({ dispose: vi.fn() })),
	handleCodeAction: vi.fn(async (..._args: unknown[]) => undefined),
	getEditorContext: vi.fn((..._args: unknown[]) => null as unknown),
}))

vi.mock("vscode", () => ({
	commands: { registerCommand: mocks.registerCommand },
}))

vi.mock("../../shared/package", () => ({ Package: { name: "openai-agent" } }))
vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: { handleCodeAction: mocks.handleCodeAction },
}))
vi.mock("../../integrations/editor/EditorUtils", () => ({
	EditorUtils: { getEditorContext: mocks.getEditorContext },
}))

import { registerCodeActions } from "../registerCodeActions"

function makeContext() {
	return { subscriptions: [] as Array<{ dispose: () => void }> }
}

/** registerCodeActions を走らせ、id → コールバックの対応表を返す。 */
function register() {
	const context = makeContext()
	registerCodeActions(context as never)
	const handlers = new Map<string, (...args: any[]) => Promise<void>>()
	for (const [id, cb] of mocks.registerCommand.mock.calls as Array<[string, (...a: any[]) => Promise<void>]>) {
		handlers.set(id, cb)
	}
	return { context, handlers }
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.registerCommand.mockImplementation(() => ({ dispose: vi.fn() }))
	mocks.getEditorContext.mockReturnValue(null)
})

describe("registerCodeActions - 登録", () => {
	it("4 本のコマンドをそれぞれ 1 度だけ登録し、Disposable を subscriptions に載せる", () => {
		const disposables = [0, 1, 2, 3].map(() => ({ dispose: vi.fn() }))
		let i = 0
		mocks.registerCommand.mockImplementation(() => disposables[i++])

		const { context } = register()

		const ids = mocks.registerCommand.mock.calls.map(([id]) => id)
		expect(ids).toEqual([
			"openai-agent.explainCode",
			"openai-agent.fixCode",
			"openai-agent.improveCode",
			"openai-agent.addToContext",
		])
		// 重複なし
		expect(new Set(ids).size).toBe(4)
		// 全 Disposable が subscriptions に載る
		expect(context.subscriptions).toEqual(disposables)

		for (const sub of context.subscriptions) sub.dispose()
		for (const d of disposables) expect(d.dispose).toHaveBeenCalledTimes(1)
	})
})

describe("registerCodeActions - コードアクション経由（引数あり）", () => {
	it("startLine/endLine/diagnostics を含む全引数を文字列化して渡す", async () => {
		const { handlers } = register()

		await handlers.get("openai-agent.explainCode")!("/f.ts", "code", 3, 7, [{ d: 1 }])

		expect(mocks.getEditorContext).not.toHaveBeenCalled()
		expect(mocks.handleCodeAction).toHaveBeenCalledWith("explainCode", "EXPLAIN", {
			filePath: "/f.ts",
			selectedText: "code",
			startLine: "3",
			endLine: "7",
			diagnostics: [{ d: 1 }],
		})
	})

	it("startLine/endLine/diagnostics が undefined ならキーごと省く", async () => {
		const { handlers } = register()

		// args.length === 2（> 1）でコードアクション経路に入るが、行番号・診断は未指定
		await handlers.get("openai-agent.fixCode")!("/f.ts", "code")

		expect(mocks.handleCodeAction).toHaveBeenCalledWith("fixCode", "FIX", {
			filePath: "/f.ts",
			selectedText: "code",
		})
	})
})

describe("registerCodeActions - コマンドパレット経由（引数なし）", () => {
	it("エディタ文脈が無ければ handleCodeAction を呼ばない", async () => {
		mocks.getEditorContext.mockReturnValue(null)
		const { handlers } = register()

		await handlers.get("openai-agent.improveCode")!()

		expect(mocks.getEditorContext).toHaveBeenCalledTimes(1)
		expect(mocks.handleCodeAction).not.toHaveBeenCalled()
	})

	it("エディタ文脈があればそれを展開して渡す", async () => {
		mocks.getEditorContext.mockReturnValue({
			filePath: "/ctx.ts",
			selectedText: "sel",
			startLine: 10,
			endLine: 12,
			diagnostics: [{ x: 1 }],
		})
		const { handlers } = register()

		await handlers.get("openai-agent.addToContext")!()

		expect(mocks.handleCodeAction).toHaveBeenCalledWith("addToContext", "ADD_TO_CONTEXT", {
			filePath: "/ctx.ts",
			selectedText: "sel",
			startLine: "10",
			endLine: "12",
			diagnostics: [{ x: 1 }],
		})
	})
})
