// npx vitest run core/webview/__tests__/clineProviderRegistry.spec.ts
//
// 生きている ClineProvider の台帳と「見えているインスタンスへ配送する」ヘルパ。

vi.mock("vscode", () => ({
	commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
	window: {},
}))

vi.mock("delay", () => ({ default: vi.fn().mockResolvedValue(undefined) }))

vi.mock("../supportPromptActions", () => ({
	runCodeAction: vi.fn().mockResolvedValue(undefined),
	runTerminalAction: vi.fn().mockResolvedValue(undefined),
}))

import * as vscode from "vscode"

import {
	registerProvider,
	unregisterProvider,
	getVisibleProvider,
	getVisibleInstance,
	isActiveTask,
	handleCodeAction,
	handleTerminalAction,
	type RegisteredProvider,
} from "../clineProviderRegistry"
import { runCodeAction, runTerminalAction } from "../supportPromptActions"

function makeProvider(over: Partial<RegisteredProvider> = {}): RegisteredProvider {
	return {
		isVisible: vi.fn(() => true),
		getCurrentTask: vi.fn(() => undefined),
		...over,
	} as unknown as RegisteredProvider
}

describe("clineProviderRegistry", () => {
	const registered: RegisteredProvider[] = []

	const register = (provider: RegisteredProvider) => {
		registerProvider(provider)
		registered.push(provider)
		return provider
	}

	afterEach(() => {
		// モジュールレベルの Set を汚さないよう、登録したものは毎回外す。
		for (const provider of registered.splice(0)) {
			unregisterProvider(provider)
		}
		vi.clearAllMocks()
	})

	it("getVisibleProvider は見えている最新のインスタンスを返す", () => {
		register(makeProvider({ isVisible: vi.fn(() => false) }))
		const visible = register(makeProvider())

		expect(getVisibleProvider()).toBe(visible)
	})

	it("getVisibleInstance は見えていなければサイドバーへフォーカスして再試行する", async () => {
		const hidden = register(makeProvider({ isVisible: vi.fn(() => false) }))

		const result = await getVisibleInstance()

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(expect.stringContaining("SidebarProvider.focus"))
		expect(result).toBeUndefined()

		// フォーカス後に見えるようになった場合は返す。
		vi.mocked(hidden.isVisible).mockReturnValue(true)
		expect(await getVisibleInstance()).toBe(hidden)
	})

	it("isActiveTask は現在タスクの有無を返し、provider 不在なら false", async () => {
		expect(await isActiveTask()).toBe(false)

		const provider = register(makeProvider({ getCurrentTask: vi.fn(() => ({ taskId: "t" })) }))
		expect(await isActiveTask()).toBe(true)

		vi.mocked(provider.getCurrentTask).mockReturnValue(undefined)
		expect(await isActiveTask()).toBe(false)
	})

	it("handleCodeAction は見えている provider へ委譲し、不在なら何もしない", async () => {
		await handleCodeAction("explainCode" as never, "EXPLAIN" as never, {})
		expect(runCodeAction).not.toHaveBeenCalled()

		const provider = register(makeProvider())
		await handleCodeAction("explainCode" as never, "EXPLAIN" as never, { filePath: "a.ts" })
		expect(runCodeAction).toHaveBeenCalledWith(provider, "explainCode", "EXPLAIN", { filePath: "a.ts" })
	})

	it("handleTerminalAction は見えている provider へ委譲し、不在なら何もしない", async () => {
		await handleTerminalAction("terminalExplain" as never, "TERMINAL_EXPLAIN" as never, {})
		expect(runTerminalAction).not.toHaveBeenCalled()

		const provider = register(makeProvider())
		await handleTerminalAction("terminalExplain" as never, "TERMINAL_EXPLAIN" as never, { text: "ls" })
		expect(runTerminalAction).toHaveBeenCalledWith(provider, "terminalExplain", "TERMINAL_EXPLAIN", { text: "ls" })
	})
})
