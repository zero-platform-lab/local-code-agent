// npx vitest run activate/__tests__/registerTerminalActions.spec.ts
//
// registerTerminalActions はターミナル系 3 コマンドを登録する。
// 不変条件:
//   1. terminalAddToContext / terminalFixCommand / terminalExplainCommand を
//      それぞれ 1 度だけ登録し、Disposable を subscriptions に載せる
//   2. args.selection があればそれを、無ければ Terminal.getTerminalContents で本文を得る。
//      取得範囲は ADD_TO_CONTEXT だけ -1、それ以外は 1
//   3. 最終的に本文が空なら警告を出して何もしない（落ちない）

import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
	registerCommand: vi.fn((_id: string, _cb: unknown) => ({ dispose: vi.fn() })),
	getTerminalContents: vi.fn(async (..._args: unknown[]) => "" as unknown as string),
	handleTerminalAction: vi.fn(async (..._args: unknown[]) => undefined),
	showWarningMessage: vi.fn((..._args: unknown[]) => undefined),
	t: vi.fn((key: string) => key),
}))

vi.mock("vscode", () => ({
	commands: { registerCommand: mocks.registerCommand },
	window: { showWarningMessage: mocks.showWarningMessage },
}))

vi.mock("../../shared/package", () => ({ Package: { name: "openai-agent" } }))
vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: { handleTerminalAction: mocks.handleTerminalAction },
}))
vi.mock("../../integrations/terminal/Terminal", () => ({
	Terminal: { getTerminalContents: mocks.getTerminalContents },
}))
vi.mock("../../i18n", () => ({ t: mocks.t }))

import { registerTerminalActions } from "../registerTerminalActions"

function register() {
	const context = { subscriptions: [] as Array<{ dispose: () => void }> }
	registerTerminalActions(context as never)
	const handlers = new Map<string, (args: any) => Promise<void>>()
	for (const [id, cb] of mocks.registerCommand.mock.calls as Array<[string, (a: any) => Promise<void>]>) {
		handlers.set(id, cb)
	}
	return { context, handlers }
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.registerCommand.mockImplementation(() => ({ dispose: vi.fn() }))
	mocks.getTerminalContents.mockResolvedValue("")
})

describe("registerTerminalActions - 登録", () => {
	it("3 本のコマンドを 1 度だけ登録し、Disposable を subscriptions に載せる", () => {
		const disposables = [0, 1, 2].map(() => ({ dispose: vi.fn() }))
		let i = 0
		mocks.registerCommand.mockImplementation(() => disposables[i++])

		const { context } = register()

		expect(mocks.registerCommand.mock.calls.map(([id]) => id)).toEqual([
			"openai-agent.terminalAddToContext",
			"openai-agent.terminalFixCommand",
			"openai-agent.terminalExplainCommand",
		])
		expect(context.subscriptions).toEqual(disposables)
		for (const sub of context.subscriptions) sub.dispose()
		for (const d of disposables) expect(d.dispose).toHaveBeenCalledTimes(1)
	})
})

describe("registerTerminalActions - 本文の取得", () => {
	it("args.selection があればそれを使い、getTerminalContents は呼ばない", async () => {
		const { handlers } = register()

		await handlers.get("openai-agent.terminalFixCommand")!({ selection: "echo hi" })

		expect(mocks.getTerminalContents).not.toHaveBeenCalled()
		expect(mocks.handleTerminalAction).toHaveBeenCalledWith("terminalFixCommand", "TERMINAL_FIX", {
			terminalContent: "echo hi",
		})
	})

	it("ADD_TO_CONTEXT は selection 無しなら -1（全文）で取得する", async () => {
		mocks.getTerminalContents.mockResolvedValue("full buffer")
		const { handlers } = register()

		// args そのものが undefined でも args?.selection で安全に undefined になる
		await handlers.get("openai-agent.terminalAddToContext")!(undefined)

		expect(mocks.getTerminalContents).toHaveBeenCalledWith(-1)
		expect(mocks.handleTerminalAction).toHaveBeenCalledWith("terminalAddToContext", "TERMINAL_ADD_TO_CONTEXT", {
			terminalContent: "full buffer",
		})
	})

	it("ADD_TO_CONTEXT 以外は selection 無しなら 1（直近）で取得する", async () => {
		mocks.getTerminalContents.mockResolvedValue("last command")
		const { handlers } = register()

		await handlers.get("openai-agent.terminalExplainCommand")!({ selection: "" })

		expect(mocks.getTerminalContents).toHaveBeenCalledWith(1)
		expect(mocks.handleTerminalAction).toHaveBeenCalledWith("terminalExplainCommand", "TERMINAL_EXPLAIN", {
			terminalContent: "last command",
		})
	})

	it("取得しても本文が空なら警告を出して何もしない", async () => {
		mocks.getTerminalContents.mockResolvedValue("")
		const { handlers } = register()

		await handlers.get("openai-agent.terminalFixCommand")!({})

		expect(mocks.showWarningMessage).toHaveBeenCalledWith("common:warnings.no_terminal_content")
		expect(mocks.handleTerminalAction).not.toHaveBeenCalled()
	})
})
