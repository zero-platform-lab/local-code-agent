// npx vitest run activate/__tests__/registerCommands.invariants.spec.ts
//
// registerCommands は拡張のコマンド表面そのもの。C0 13.4% / 関数 20%（148 行が未実行）で、
// 「登録されたコマンドが実際に何をするか」がほぼ未検証だった。
//
// ここで固定するのは次の 4 点:
//   1. **宣言されたコマンドが 1 つ残らず、かつ 1 度だけ登録されること**
//      （二重登録は VS Code 側で例外になる）
//   2. **登録した Disposable が全部 context.subscriptions に載ること**＝
//      拡張の deactivate で確実に解除されること。dispose は各コマンド 1 回だけ
//   3. 各コマンドは「見えている provider が無ければ何もしない」で揃っていること
//      （provider 不在時に落ちると拡張ごと死ぬ）
//   4. openClineInNewTab のパネル生成手順（列の決定・アイコン・リスナ登録・
//      dispose 時のパネル解除）
//
// ClineProvider / ContextProxy / CodeIndexManager は生成コストが大きいので丸ごとモック。
// 既存の registerCommands.spec.ts（getVisibleProviderOrLog 専用）はそのまま残す。

import { describe, it, expect, vi, beforeEach } from "vitest"

import { commandIds, type CommandId } from "@openai-agent/types"

import { Package } from "../../shared/package"

// --- モック定義 -------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	registerCommand: vi.fn((_id: string, _cb: unknown) => ({ dispose: vi.fn() })),
	executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
	createWebviewPanel: vi.fn((..._args: unknown[]) => undefined as unknown),
	visibleTextEditors: [] as Array<{ viewColumn?: number }>,
	getVisibleInstance: vi.fn((..._args: unknown[]) => undefined as unknown),
	resolveWebviewView: vi.fn(async (..._args: unknown[]) => undefined),
	contextProxyGetInstance: vi.fn(async (..._args: unknown[]) => ({ proxy: true })),
	codeIndexGetInstance: vi.fn((..._args: unknown[]) => ({ indexer: true })),
	focusPanel: vi.fn(async (..._args: unknown[]) => undefined),
	handleNewTask: vi.fn(async (..._args: unknown[]) => undefined),
	importSettingsWithFeedback: vi.fn(async (..._args: unknown[]) => undefined),
	promptForCustomStoragePath: vi.fn(async (..._args: unknown[]) => undefined),
	getPanel: vi.fn((..._args: unknown[]) => undefined as unknown),
	getTabPanel: vi.fn((..._args: unknown[]) => undefined as unknown),
	getSidebarPanel: vi.fn((..._args: unknown[]) => undefined as unknown),
	setPanel: vi.fn((..._args: unknown[]) => undefined),
	delay: vi.fn(async (..._args: unknown[]) => undefined),
}))

vi.mock("vscode", () => ({
	commands: { registerCommand: mocks.registerCommand, executeCommand: mocks.executeCommand },
	window: {
		createWebviewPanel: mocks.createWebviewPanel,
		get visibleTextEditors() {
			return mocks.visibleTextEditors
		},
	},
	Uri: {
		joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/") }),
	},
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
}))

vi.mock("delay", () => ({ default: mocks.delay }))

vi.mock("../../core/webview/ClineProvider", () => {
	// クラス名を import 名（ClineProvider）と衝突させない。ssr 変換が factory 内の
	// 識別子を import バインディングへ書き換えてしまい TDZ エラーになるため。
	class MockClineProvider {
		static tabPanelId = "openai-agent.TabPanelProvider"
		static sideBarId = "openai-agent.SidebarProvider"
		static getVisibleInstance = mocks.getVisibleInstance
		resolveWebviewView = mocks.resolveWebviewView
		constructorArgs: unknown[]
		constructor(...args: unknown[]) {
			this.constructorArgs = args
		}
	}
	return { ClineProvider: MockClineProvider }
})

vi.mock("../../core/config/ContextProxy", () => ({
	ContextProxy: { getInstance: mocks.contextProxyGetInstance },
}))

vi.mock("../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: mocks.codeIndexGetInstance },
}))

vi.mock("../../utils/focusPanel", () => ({ focusPanel: mocks.focusPanel }))
vi.mock("../handleTask", () => ({ handleNewTask: mocks.handleNewTask }))
vi.mock("../../core/config/importExport", () => ({ importSettingsWithFeedback: mocks.importSettingsWithFeedback }))
vi.mock("../../utils/storage", () => ({ promptForCustomStoragePath: mocks.promptForCustomStoragePath }))

vi.mock("../webviewPanelRegistry", () => ({
	getPanel: mocks.getPanel,
	getTabPanel: mocks.getTabPanel,
	getSidebarPanel: mocks.getSidebarPanel,
	setPanel: mocks.setPanel,
}))

import { ClineProvider } from "../../core/webview/ClineProvider"
import { registerCommands, openClineInNewTab, getVisibleProviderOrLog, getPanel, setPanel } from "../registerCommands"

// --- テスト用ヘルパ ---------------------------------------------------------

function makeOutputChannel() {
	return { appendLine: vi.fn(), append: vi.fn(), dispose: vi.fn() }
}

function makeContext() {
	return {
		subscriptions: [] as Array<{ dispose: () => void }>,
		extensionUri: { fsPath: "/ext" },
	}
}

/** getVisibleInstance が返す provider の贋物。 */
function makeVisibleProvider() {
	return {
		removeClineFromStack: vi.fn(async () => undefined),
		refreshWorkspace: vi.fn(async () => undefined),
		postMessageToWebview: vi.fn(async (..._args: unknown[]) => undefined),
		getState: vi.fn(async () => ({ autonomyMode: "manual" })),
		setAutonomyMode: vi.fn(async (..._args: unknown[]) => undefined),
		providerSettingsManager: { psm: true },
		contextProxy: { cp: true },
		customModesManager: { cmm: true },
	}
}

/** registerCommands を走らせ、id → コールバックの対応表を返す。 */
function register(options?: { provider?: unknown }) {
	const context = makeContext()
	const outputChannel = makeOutputChannel()
	const provider = (options?.provider ?? {}) as never

	registerCommands({ context: context as never, outputChannel: outputChannel as never, provider })

	const handlers = new Map<string, (...args: any[]) => unknown>()
	for (const [id, callback] of mocks.registerCommand.mock.calls as Array<[string, (...a: any[]) => unknown]>) {
		handlers.set(id, callback)
	}

	return { context, outputChannel, handlers }
}

/** コマンド id（`<publisher-less name>.<id>` 形式）。 */
const qualified = (id: CommandId) => `${Package.name}.${id}`

beforeEach(() => {
	vi.clearAllMocks()
	mocks.visibleTextEditors = []
	mocks.registerCommand.mockImplementation(() => ({ dispose: vi.fn() }))
	mocks.getVisibleInstance.mockReturnValue(undefined)
	mocks.contextProxyGetInstance.mockResolvedValue({ proxy: true })
	// clearAllMocks は実装を消さないので、失敗を仕込むテストの影響が漏れないよう明示的に戻す
	mocks.focusPanel.mockResolvedValue(undefined)
	mocks.importSettingsWithFeedback.mockResolvedValue(undefined)
	mocks.promptForCustomStoragePath.mockResolvedValue(undefined)
	mocks.executeCommand.mockResolvedValue(undefined)
	mocks.delay.mockResolvedValue(undefined)
	mocks.getPanel.mockReturnValue(undefined)
	mocks.getTabPanel.mockReturnValue(undefined)
	mocks.getSidebarPanel.mockReturnValue(undefined)
})

// --- 1. 登録と解除の不変条件 --------------------------------------------------

describe("registerCommands - 登録と解除", () => {
	it("**宣言されたコマンドを 1 つ残らず、かつ 1 度だけ登録する**", async () => {
		const { handlers } = register()

		const registeredIds = mocks.registerCommand.mock.calls.map(([id]) => id as string)
		// 過不足なし
		expect(new Set(registeredIds)).toEqual(new Set(commandIds.map(qualified)))
		// 重複なし（VS Code は同一 id の二重登録で例外を投げる）
		expect(registeredIds).toHaveLength(new Set(registeredIds).size)
		expect(registeredIds).toHaveLength(commandIds.length)
		expect(handlers.size).toBe(commandIds.length)
	})

	it("**登録した Disposable が全部 subscriptions に載る（dispose で確実に解除される）**", async () => {
		const disposables = commandIds.map(() => ({ dispose: vi.fn() }))
		let index = 0
		mocks.registerCommand.mockImplementation(() => disposables[index++])

		const { context } = register()

		expect(context.subscriptions).toEqual(disposables)

		// 拡張の deactivate 相当
		for (const subscription of context.subscriptions) {
			subscription.dispose()
		}

		for (const disposable of disposables) {
			expect(disposable.dispose).toHaveBeenCalledTimes(1)
		}
	})

	it("2 回呼べば 2 セット登録される（呼び出し側が 1 度しか呼ばない前提）", async () => {
		// registerCommands 自身は冪等ではない。activate から 1 度だけ呼ぶ契約であることを
		// 明示的に固定しておく（将来 idempotent 化したらこのテストが落ちて気付ける）。
		const context = makeContext()
		const outputChannel = makeOutputChannel()
		const options = { context: context as never, outputChannel: outputChannel as never, provider: {} as never }

		registerCommands(options)
		registerCommands(options)

		expect(mocks.registerCommand).toHaveBeenCalledTimes(commandIds.length * 2)
		expect(context.subscriptions).toHaveLength(commandIds.length * 2)
	})

	it("パネルレジストリの再エクスポートが元の実装を指している", () => {
		expect(getPanel).toBe(mocks.getPanel)
		expect(setPanel).toBe(mocks.setPanel)
	})
})

// --- 2. provider が見えないときの振る舞い -------------------------------------

describe("registerCommands - 見えている provider が無いとき", () => {
	// provider を必要とするコマンドは「ログを出して何もしない」で揃っている必要がある。
	const providerDependent: CommandId[] = [
		"plusButtonClicked",
		"settingsButtonClicked",
		"historyButtonClicked",
		"importSettings",
		"acceptInput",
		"toggleAutoApprove",
		"cycleAutonomyMode",
		"setAutonomyModeManual",
		"setAutonomyModeAutoEdit",
		"setAutonomyModeAuto",
		"setAutonomyModePlan",
	]

	for (const id of providerDependent) {
		it(`${id} は落ちずに何もしない`, async () => {
			mocks.getVisibleInstance.mockReturnValue(undefined)
			const { handlers, outputChannel } = register()

			// 同期で返るコマンドと async なコマンドが混在しているので Promise に揃える
			await expect(Promise.resolve(handlers.get(qualified(id))!())).resolves.toBeUndefined()

			expect(outputChannel.appendLine).toHaveBeenCalledWith("Cannot find any visible Agent instances.")
			expect(mocks.importSettingsWithFeedback).not.toHaveBeenCalled()
		})
	}

	it("getVisibleProviderOrLog は見えている provider をそのまま返す", () => {
		const provider = makeVisibleProvider()
		mocks.getVisibleInstance.mockReturnValue(provider)
		const outputChannel = makeOutputChannel()

		expect(getVisibleProviderOrLog(outputChannel as never)).toBe(provider)
		expect(outputChannel.appendLine).not.toHaveBeenCalled()
	})
})

// --- 3. 各コマンドの中身 -----------------------------------------------------

describe("registerCommands - 各コマンドの振る舞い", () => {
	it("activationCompleted は何もしない", async () => {
		const { handlers } = register()

		expect(handlers.get(qualified("activationCompleted"))!()).toBeUndefined()
	})

	it("plusButtonClicked はスタックを空にしてチャットへ戻し、入力にフォーカスする", async () => {
		const provider = makeVisibleProvider()
		mocks.getVisibleInstance.mockReturnValue(provider)
		const { handlers } = register()

		await handlers.get(qualified("plusButtonClicked"))!()

		expect(provider.removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(provider.refreshWorkspace).toHaveBeenCalledTimes(1)
		expect(provider.postMessageToWebview.mock.calls.map(([m]) => m)).toEqual([
			{ type: "action", action: "chatButtonClicked" },
			{ type: "action", action: "focusInput" },
		])
	})

	it("settingsButtonClicked は設定表示と可視化通知の 2 本を送る", async () => {
		const provider = makeVisibleProvider()
		mocks.getVisibleInstance.mockReturnValue(provider)
		const { handlers } = register()

		await handlers.get(qualified("settingsButtonClicked"))!()

		expect(provider.postMessageToWebview.mock.calls.map(([m]) => m)).toEqual([
			{ type: "action", action: "settingsButtonClicked" },
			{ type: "action", action: "didBecomeVisible" },
		])
	})

	it("historyButtonClicked は履歴表示を送る", async () => {
		const provider = makeVisibleProvider()
		mocks.getVisibleInstance.mockReturnValue(provider)
		const { handlers } = register()

		await handlers.get(qualified("historyButtonClicked"))!()

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "historyButtonClicked" })
	})

	it("acceptInput は acceptInput を送る", async () => {
		const provider = makeVisibleProvider()
		mocks.getVisibleInstance.mockReturnValue(provider)
		const { handlers } = register()

		await handlers.get(qualified("acceptInput"))!()

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "acceptInput" })
	})

	it("toggleAutoApprove は toggleAutoApprove を送る", async () => {
		const provider = makeVisibleProvider()
		mocks.getVisibleInstance.mockReturnValue(provider)
		const { handlers } = register()

		await handlers.get(qualified("toggleAutoApprove"))!()

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "toggleAutoApprove" })
	})

	it("newTask は handleNewTask をそのまま使う", async () => {
		const { handlers } = register()

		expect(handlers.get(qualified("newTask"))).toBe(mocks.handleNewTask)
	})

	it("setCustomStoragePath は動的 import したプロンプトを呼ぶ", async () => {
		const { handlers } = register()

		await handlers.get(qualified("setCustomStoragePath"))!()

		expect(mocks.promptForCustomStoragePath).toHaveBeenCalledTimes(1)
	})

	it("importSettings は provider の各マネージャを束ねて渡す", async () => {
		const provider = makeVisibleProvider()
		mocks.getVisibleInstance.mockReturnValue(provider)
		const { handlers } = register()

		await handlers.get(qualified("importSettings"))!("/tmp/settings.json")

		expect(mocks.importSettingsWithFeedback).toHaveBeenCalledWith(
			{
				providerSettingsManager: provider.providerSettingsManager,
				contextProxy: provider.contextProxy,
				customModesManager: provider.customModesManager,
				provider,
			},
			"/tmp/settings.json",
		)
	})

	it("importSettings はファイルパス省略でも呼べる", async () => {
		const provider = makeVisibleProvider()
		mocks.getVisibleInstance.mockReturnValue(provider)
		const { handlers } = register()

		await handlers.get(qualified("importSettings"))!()

		expect(mocks.importSettingsWithFeedback).toHaveBeenCalledWith(expect.anything(), undefined)
	})

	it("cycleAutonomyMode は現在のモードの次へ進める", async () => {
		const provider = makeVisibleProvider()
		provider.getState.mockResolvedValue({ autonomyMode: "manual" })
		mocks.getVisibleInstance.mockReturnValue(provider)
		const { handlers } = register()

		await handlers.get(qualified("cycleAutonomyMode"))!()

		expect(provider.setAutonomyMode).toHaveBeenCalledTimes(1)
		// 何に進むかは nextAutonomyMode の責務。ここでは「manual のままではない」ことだけ見る
		expect(provider.setAutonomyMode.mock.calls[0][0]).not.toBe("manual")
	})

	const autonomyCases: Array<[CommandId, string]> = [
		["setAutonomyModeManual", "manual"],
		["setAutonomyModeAutoEdit", "autoEdit"],
		["setAutonomyModeAuto", "auto"],
		["setAutonomyModePlan", "plan"],
	]

	for (const [id, mode] of autonomyCases) {
		it(`${id} は ${mode} を直接設定する`, async () => {
			const provider = makeVisibleProvider()
			mocks.getVisibleInstance.mockReturnValue(provider)
			const { handlers } = register()

			await handlers.get(qualified(id))!()

			expect(provider.setAutonomyMode).toHaveBeenCalledWith(mode)
		})
	}
})

// --- 4. フォーカス系 ---------------------------------------------------------

describe("registerCommands - フォーカス系", () => {
	it("focusInput はサイドバーが前面のときだけ入力フォーカスを送る", async () => {
		const sidebar = { kind: "sidebar" }
		mocks.getSidebarPanel.mockReturnValue(sidebar)
		mocks.getPanel.mockReturnValue(sidebar)
		const provider = makeVisibleProvider()
		const { handlers } = register({ provider })

		await handlers.get(qualified("focusInput"))!()

		expect(mocks.focusPanel).toHaveBeenCalledWith(undefined, sidebar)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
	})

	it("タブが前面ならフォーカスメッセージは送らない", async () => {
		const sidebar = { kind: "sidebar" }
		const tab = { kind: "tab" }
		mocks.getSidebarPanel.mockReturnValue(sidebar)
		mocks.getTabPanel.mockReturnValue(tab)
		mocks.getPanel.mockReturnValue(tab)
		const provider = makeVisibleProvider()
		const { handlers } = register({ provider })

		await handlers.get(qualified("focusInput"))!()

		expect(mocks.focusPanel).toHaveBeenCalledWith(tab, sidebar)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("サイドバーが無ければフォーカスメッセージは送らない", async () => {
		mocks.getSidebarPanel.mockReturnValue(undefined)
		const provider = makeVisibleProvider()
		const { handlers } = register({ provider })

		await handlers.get(qualified("focusInput"))!()

		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("focusInput の失敗はログに落として握る", async () => {
		mocks.focusPanel.mockRejectedValue(new Error("no panel"))
		const { handlers, outputChannel } = register({ provider: makeVisibleProvider() })

		await expect(handlers.get(qualified("focusInput"))!()).resolves.toBeUndefined()

		expect(outputChannel.appendLine).toHaveBeenCalledWith("Error focusing input: Error: no panel")
	})

	it("focusPanel コマンドはパネルを前面に出すだけ", async () => {
		const tab = { kind: "tab" }
		mocks.getTabPanel.mockReturnValue(tab)
		const { handlers } = register()

		await handlers.get(qualified("focusPanel"))!()

		expect(mocks.focusPanel).toHaveBeenCalledWith(tab, undefined)
	})

	it("focusPanel の失敗もログに落として握る", async () => {
		mocks.focusPanel.mockRejectedValue(new Error("boom"))
		const { handlers, outputChannel } = register()

		await expect(handlers.get(qualified("focusPanel"))!()).resolves.toBeUndefined()

		expect(outputChannel.appendLine).toHaveBeenCalledWith("Error focusing panel: Error: boom")
	})
})

// --- 5. openClineInNewTab ----------------------------------------------------

describe("openClineInNewTab", () => {
	interface PanelStub {
		iconPath?: unknown
		webview: { postMessage: ReturnType<typeof vi.fn> }
		onDidChangeViewState: ReturnType<typeof vi.fn>
		onDidDispose: ReturnType<typeof vi.fn>
		visible: boolean
	}

	function stubPanel(): PanelStub {
		return {
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			visible: true,
		}
	}

	function openTab() {
		const panel = stubPanel()
		mocks.createWebviewPanel.mockReturnValue(panel)
		const context = makeContext()
		const outputChannel = makeOutputChannel()

		return {
			panel,
			context,
			outputChannel,
			run: () => openClineInNewTab({ context: context as never, outputChannel: outputChannel as never }),
		}
	}

	it("エディタが開いていなければ右に新しいグループを作り、2 列目に置く", async () => {
		mocks.visibleTextEditors = []
		const { panel, run } = openTab()

		const provider = await run()

		expect(mocks.executeCommand).toHaveBeenCalledWith("workbench.action.newGroupRight")
		expect(mocks.createWebviewPanel).toHaveBeenCalledWith(
			ClineProvider.tabPanelId,
			"Agent",
			2,
			expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
		)
		expect(provider).toBeInstanceOf(ClineProvider)
		expect(mocks.resolveWebviewView).toHaveBeenCalledWith(panel)
	})

	it("エディタが開いていれば最大列の 1 つ右に置き、新グループは作らない", async () => {
		mocks.visibleTextEditors = [{ viewColumn: 1 }, { viewColumn: 3 }]
		const { run } = openTab()

		await run()

		expect(mocks.executeCommand).not.toHaveBeenCalledWith("workbench.action.newGroupRight")
		expect(mocks.createWebviewPanel.mock.calls[0][2]).toBe(4)
	})

	it("列を持たないエディタしか無ければ 1 列目に置く", async () => {
		// viewColumn 未設定は 0 として扱われ、Math.max(0 + 1, 1) = 1
		mocks.visibleTextEditors = [{ viewColumn: undefined }]
		const { run } = openTab()

		await run()

		expect(mocks.createWebviewPanel.mock.calls[0][2]).toBe(1)
	})

	it("パネルをタブとして登録し、アイコンを設定し、最後にグループをロックする", async () => {
		const { panel, context, run } = openTab()

		await run()

		expect(mocks.setPanel).toHaveBeenCalledWith(panel, "tab")
		expect(panel.iconPath).toEqual({ fsPath: "/ext/assets/icons/icon-internal.svg" })
		expect(mocks.contextProxyGetInstance).toHaveBeenCalledWith(context)
		expect(mocks.codeIndexGetInstance).toHaveBeenCalledWith(context)
		expect(mocks.delay).toHaveBeenCalledWith(100)
		expect(mocks.executeCommand).toHaveBeenLastCalledWith("workbench.action.lockEditorGroup")
	})

	it("表示状態のリスナは可視化されたときだけ webview に通知する", async () => {
		const { panel, context, run } = openTab()

		await run()

		const [listener, thisArgs, subscriptions] = panel.onDidChangeViewState.mock.calls[0]
		expect(thisArgs).toBeNull()
		expect(subscriptions).toBe(context.subscriptions)

		listener({ webviewPanel: { visible: true, webview: panel.webview } })
		expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: "action", action: "didBecomeVisible" })

		panel.webview.postMessage.mockClear()
		listener({ webviewPanel: { visible: false, webview: panel.webview } })
		expect(panel.webview.postMessage).not.toHaveBeenCalled()
	})

	it("パネルを閉じたらタブ参照を外す", async () => {
		const { panel, context, run } = openTab()

		await run()

		const [listener, thisArgs, subscriptions] = panel.onDidDispose.mock.calls[0]
		expect(thisArgs).toBeNull()
		expect(subscriptions).toBe(context.subscriptions)

		mocks.setPanel.mockClear()
		listener()
		expect(mocks.setPanel).toHaveBeenCalledWith(undefined, "tab")
	})

	it("popoutButtonClicked / openInNewTab はどちらも新しいタブを開く", async () => {
		mocks.createWebviewPanel.mockReturnValue(stubPanel())
		const { handlers, context, outputChannel } = register()

		await handlers.get(qualified("popoutButtonClicked"))!()
		await handlers.get(qualified("openInNewTab"))!()

		expect(mocks.createWebviewPanel).toHaveBeenCalledTimes(2)
		// registerCommands に渡した context / outputChannel がそのまま使われる
		expect(mocks.contextProxyGetInstance).toHaveBeenCalledWith(context)
		expect(outputChannel.appendLine).not.toHaveBeenCalled()
	})
})
