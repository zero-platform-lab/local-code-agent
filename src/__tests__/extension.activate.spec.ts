// npx vitest run __tests__/extension.activate.spec.ts
//
// activate/deactivate と checkWorktreeAutoOpen の分岐を網羅する。既存 extension.spec.ts は
// dotenvx の .env 有無だけを見ているので、こちらで残りの本体を固定する。
// 不変条件:
//   - 各種プロバイダ/コマンドの登録 Disposable がすべて context.subscriptions に載る（dispose で解除）
//   - workspaceFolders・globalState・環境変数の境界（未設定/設定済み/失敗）で activate が落ちない
//   - 差分ドキュメントプロバイダは base64 クエリを復号して返す
//   - worktree 自動オープンはパス一致時のみ発火し、失敗しても握りつぶす

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"

const mocks = vi.hoisted(() => ({
	initializeNetworkProxy: vi.fn(async () => undefined),
	migrateSettings: vi.fn(async () => undefined),
	initializeI18n: vi.fn(),
	formatLanguage: vi.fn(() => "en"),
	terminalInitialize: vi.fn(),
	terminalCleanup: vi.fn(),
	mcpCleanup: vi.fn(async () => undefined),
	codeIndexGetInstance: vi.fn((..._a: unknown[]) => null as unknown),
	contextProxyGetInstance: vi.fn(async () => ({ proxy: true })),
	autoImportSettings: vi.fn(async () => undefined),
	registerCommands: vi.fn(),
	registerCodeActions: vi.fn(),
	registerTerminalActions: vi.fn(),
	API: vi.fn().mockImplementation((...args: unknown[]) => ({ api: true, args })),
	providerInstance: {
		resolveWebviewView: vi.fn(),
		providerSettingsManager: { psm: true },
		contextProxy: { cp: true },
		customModesManager: { cmm: true },
	},
}))

function makeWatcher() {
	return {
		onDidChange: vi.fn(),
		onDidCreate: vi.fn(),
		onDidDelete: vi.fn(),
		dispose: vi.fn(),
	}
}

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), dispose: vi.fn() })),
		registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
		visibleTextEditors: [],
	},
	workspace: {
		workspaceFolders: undefined as unknown,
		getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, def?: unknown) => def) })),
		registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
		createFileSystemWatcher: vi.fn(() => makeWatcher()),
	},
	languages: {
		registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
	},
	commands: {
		executeCommand: vi.fn(async () => undefined),
	},
	env: { language: "ja" },
	Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }) },
	RelativePattern: vi.fn().mockImplementation((base: unknown, pattern: string) => ({ base, pattern })),
}))

vi.mock("../utils/networkProxy", () => ({ initializeNetworkProxy: mocks.initializeNetworkProxy }))
vi.mock("../utils/migrateSettings", () => ({ migrateSettings: mocks.migrateSettings }))
vi.mock("../utils/autoImportSettings", () => ({ autoImportSettings: mocks.autoImportSettings }))
vi.mock("../i18n", () => ({ initializeI18n: mocks.initializeI18n, t: (k: string) => k }))
vi.mock("../shared/package", () => ({
	Package: { name: "test-extension", outputChannel: "Test Output", version: "1.0.0" },
}))
vi.mock("../shared/language", () => ({ formatLanguage: mocks.formatLanguage }))
vi.mock("../core/config/ContextProxy", () => ({ ContextProxy: { getInstance: mocks.contextProxyGetInstance } }))
vi.mock("../integrations/editor/DiffViewProvider", () => ({ DIFF_VIEW_URI_SCHEME: "test-diff" }))
vi.mock("../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { initialize: mocks.terminalInitialize, cleanup: mocks.terminalCleanup },
}))
vi.mock("../services/mcp/McpServerManager", () => ({ McpServerManager: { cleanup: mocks.mcpCleanup } }))
vi.mock("../services/code-index/manager", () => ({ CodeIndexManager: { getInstance: mocks.codeIndexGetInstance } }))
vi.mock("../extension/api", () => ({ API: mocks.API }))
vi.mock("../activate", () => ({
	registerCommands: mocks.registerCommands,
	registerCodeActions: mocks.registerCodeActions,
	registerTerminalActions: mocks.registerTerminalActions,
	CodeActionProvider: class {
		static providedCodeActionKinds = ["quickfix"]
	},
}))
vi.mock("../core/webview/ClineProvider", () => {
	class MockClineProvider {
		static sideBarId = "test-extension.SidebarProvider"
		constructor() {
			return mocks.providerInstance as unknown as MockClineProvider
		}
	}
	return { ClineProvider: MockClineProvider }
})

import { activate, deactivate } from "../extension"

type GlobalStateData = Record<string, unknown>

function makeContext(opts?: { globalStateData?: GlobalStateData; throwOnKey?: string; throwValue?: unknown }) {
	const store = new Map<string, unknown>(Object.entries(opts?.globalStateData ?? {}))
	return {
		extensionPath: "/ext",
		extensionUri: { fsPath: "/ext" },
		subscriptions: [] as Array<{ dispose?: () => void }>,
		globalState: {
			get: vi.fn((key: string) => {
				if (opts?.throwOnKey === key) {
					throw "throwValue" in (opts ?? {}) ? opts!.throwValue : new Error(`globalState.get boom: ${key}`)
				}
				return store.has(key) ? store.get(key) : undefined
			}),
			update: vi.fn((key: string, value: unknown) => {
				store.set(key, value)
				return Promise.resolve()
			}),
		},
	} as unknown as import("vscode").ExtensionContext & { subscriptions: Array<{ dispose?: () => void }> }
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_SOCKET = process.env.ROO_CODE_IPC_SOCKET_PATH

beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
	;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined
	;(vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
		get: vi.fn((_k: string, def?: unknown) => def),
	})
	;(vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
	delete process.env.ROO_CODE_IPC_SOCKET_PATH
	process.env.NODE_ENV = "test"
})

afterEach(() => {
	process.env.NODE_ENV = ORIGINAL_NODE_ENV
	if (ORIGINAL_SOCKET === undefined) delete process.env.ROO_CODE_IPC_SOCKET_PATH
	else process.env.ROO_CODE_IPC_SOCKET_PATH = ORIGINAL_SOCKET
	vi.restoreAllMocks()
})

describe("activate - 基本フロー", () => {
	it("最小構成で一通り登録し、初期化系を呼び、API を返す", async () => {
		const context = makeContext()

		const api = await activate(context)

		expect(mocks.initializeNetworkProxy).toHaveBeenCalledTimes(1)
		expect(mocks.migrateSettings).toHaveBeenCalledTimes(1)
		expect(mocks.terminalInitialize).toHaveBeenCalledTimes(1)
		expect(mocks.registerCommands).toHaveBeenCalledTimes(1)
		expect(mocks.registerCodeActions).toHaveBeenCalledTimes(1)
		expect(mocks.registerTerminalActions).toHaveBeenCalledTimes(1)
		// activationCompleted の合図を出す
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("test-extension.activationCompleted")
		// 各種プロバイダ登録の Disposable が subscriptions に載る
		expect(context.subscriptions.length).toBeGreaterThanOrEqual(4)
		expect(mocks.API).toHaveBeenCalledTimes(1)
		expect(api).toEqual({ api: true, args: expect.any(Array) })
	})

	it("language 未設定なら env.language をフォーマットして i18n を初期化する", async () => {
		await activate(makeContext())
		expect(mocks.formatLanguage).toHaveBeenCalledWith("ja")
		expect(mocks.initializeI18n).toHaveBeenCalledWith("en")
	})

	it("language 設定済みならそれをそのまま使う", async () => {
		await activate(makeContext({ globalStateData: { language: "fr" } }))
		expect(mocks.formatLanguage).not.toHaveBeenCalled()
		expect(mocks.initializeI18n).toHaveBeenCalledWith("fr")
	})

	it("allowedCommands 未設定なら設定値で globalState を初期化する", async () => {
		;(vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
			get: vi.fn((key: string, def?: unknown) => (key === "allowedCommands" ? ["ls", "pwd"] : def)),
		})
		const context = makeContext()

		await activate(context)

		expect(context.globalState.update).toHaveBeenCalledWith("allowedCommands", ["ls", "pwd"])
	})

	it("allowedCommands 設定済みなら上書きしない。設定が無ければ空配列で扱う", async () => {
		const context = makeContext({ globalStateData: { allowedCommands: ["existing"] } })

		await activate(context)

		expect(context.globalState.update).not.toHaveBeenCalledWith("allowedCommands", expect.anything())
	})

	it("hasRevealedSidebar 未設定なら一度だけサイドバーを表示する", async () => {
		const context = makeContext()

		await activate(context)

		expect(context.globalState.update).toHaveBeenCalledWith("hasRevealedSidebar", true)
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"workbench.view.extension.test-extension-ActivityBar",
		)
	})

	it("サイドバー表示が拒否されても握りつぶす（reject コールバック）", async () => {
		;(vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
			if (cmd === "workbench.view.extension.test-extension-ActivityBar") {
				return Promise.reject(new Error("not ready"))
			}
			return undefined
		})

		await expect(activate(makeContext())).resolves.toBeDefined()
	})

	it("hasRevealedSidebar 設定済みなら表示コマンドを出さない", async () => {
		await activate(makeContext({ globalStateData: { hasRevealedSidebar: true } }))
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
			"workbench.view.extension.test-extension-ActivityBar",
		)
	})

	it("差分ドキュメントプロバイダは base64 クエリを UTF-8 に復号する", async () => {
		await activate(makeContext())

		const [, provider] = (vscode.workspace.registerTextDocumentContentProvider as ReturnType<typeof vi.fn>).mock
			.calls[0]
		const query = Buffer.from("元の内容", "utf-8").toString("base64")
		const content = (provider as { provideTextDocumentContent: (u: unknown) => string }).provideTextDocumentContent(
			{
				query,
			},
		)
		expect(content).toBe("元の内容")
	})
})

describe("activate - code index マネージャ", () => {
	beforeEach(() => {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
			{ uri: { fsPath: "/ws/a" } },
			{ uri: { fsPath: "/ws/b" } },
		]
	})

	it("マネージャが得られたら初期化を走らせ subscriptions に載せる", async () => {
		const manager = { initialize: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() }
		mocks.codeIndexGetInstance.mockReturnValue(manager)
		const context = makeContext()

		await activate(context)
		await Promise.resolve()

		expect(mocks.codeIndexGetInstance).toHaveBeenCalledTimes(2)
		expect(manager.initialize).toHaveBeenCalled()
		expect(context.subscriptions).toContain(manager)
	})

	it("マネージャが null のフォルダはスキップする", async () => {
		mocks.codeIndexGetInstance.mockReturnValue(null)
		const context = makeContext()

		await activate(context)

		// null は push されない（他の登録 Disposable のみ）
		expect(context.subscriptions).not.toContain(null)
	})

	it("バックグラウンド初期化が失敗してもログに落として activate は完了する（Error）", async () => {
		const manager = {
			initialize: vi.fn().mockRejectedValue(new Error("index boom")),
			dispose: vi.fn(),
		}
		mocks.codeIndexGetInstance.mockReturnValue(manager)

		await expect(activate(makeContext())).resolves.toBeDefined()
		await Promise.resolve()
		await Promise.resolve()
	})

	it("Error 以外で失敗しても String 化して握る（instanceof の else 側）", async () => {
		const manager = {
			initialize: vi.fn().mockRejectedValue("plain string failure"),
			dispose: vi.fn(),
		}
		mocks.codeIndexGetInstance.mockReturnValue(manager)

		await expect(activate(makeContext())).resolves.toBeDefined()
		await Promise.resolve()
		await Promise.resolve()
	})
})

describe("activate - autoImportSettings の失敗", () => {
	it("Error で失敗してもログに落として続行する", async () => {
		mocks.autoImportSettings.mockRejectedValueOnce(new Error("import boom"))

		await expect(activate(makeContext())).resolves.toBeDefined()
		expect(mocks.registerCommands).toHaveBeenCalledTimes(1)
	})

	it("Error 以外で失敗しても String 化して続行する（instanceof の else 側）", async () => {
		mocks.autoImportSettings.mockRejectedValueOnce("import string failure")

		await expect(activate(makeContext())).resolves.toBeDefined()
		expect(mocks.registerCommands).toHaveBeenCalledTimes(1)
	})
})

describe("activate - IPC ソケット", () => {
	it("ROO_CODE_IPC_SOCKET_PATH があれば enableLogging=true で API を作る", async () => {
		process.env.ROO_CODE_IPC_SOCKET_PATH = "/tmp/ipc.sock"

		await activate(makeContext())

		const args = mocks.API.mock.calls[0]
		expect(args[2]).toBe("/tmp/ipc.sock")
		expect(args[3]).toBe(true)
	})

	it("未設定なら enableLogging=false", async () => {
		await activate(makeContext())
		const args = mocks.API.mock.calls[0]
		expect(args[2]).toBeUndefined()
		expect(args[3]).toBe(false)
	})
})

describe("activate - development ホットリロード", () => {
	beforeEach(() => {
		process.env.NODE_ENV = "development"
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("ファイル監視を張り、変更はデバウンスして reloadWindow を呼ぶ", async () => {
		const context = makeContext()

		await activate(context)

		expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2)
		const watcher = (vscode.workspace.createFileSystemWatcher as ReturnType<typeof vi.fn>).mock.results[0].value
		expect(watcher.onDidChange).toHaveBeenCalled()
		expect(watcher.onDidCreate).toHaveBeenCalled()
		expect(watcher.onDidDelete).toHaveBeenCalled()

		const reload = watcher.onDidChange.mock.calls[0][0] as (uri: { fsPath: string }) => void
		// 1 回目でタイマー開始、2 回目で clearTimeout 側の分岐を通す
		reload({ fsPath: "/ext/a.ts" })
		reload({ fsPath: "/ext/b.ts" })

		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
		vi.advanceTimersByTime(1000)
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow")
	})

	it("deactivation 用の dispose はタイマー未設定でも設定済みでも安全", async () => {
		const context = makeContext()
		await activate(context)

		// dev ブロック最後の push が reloadTimeout 掃除用の dispose
		const cleanup = context.subscriptions.at(-1) as { dispose: () => void }
		expect(typeof cleanup.dispose).toBe("function")

		// reloadTimeout 未設定 → if(reloadTimeout) の false 側
		expect(() => cleanup.dispose()).not.toThrow()

		// reload を一度呼んでタイマーを仕込んでから dispose → clearTimeout を通す（true 側）
		const watcher = (vscode.workspace.createFileSystemWatcher as ReturnType<typeof vi.fn>).mock.results[0].value
		const reload = watcher.onDidChange.mock.calls[0][0] as (uri: { fsPath: string }) => void
		reload({ fsPath: "/ext/c.ts" })
		expect(() => cleanup.dispose()).not.toThrow()
	})
})

describe("checkWorktreeAutoOpen", () => {
	it("worktreeAutoOpenPath 未設定なら何もしない", async () => {
		const context = makeContext()
		await activate(context)
		expect(context.globalState.update).not.toHaveBeenCalledWith("worktreeAutoOpenPath", undefined)
	})

	it("workspaceFolders が空配列なら何もしない（length===0 側）", async () => {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = []
		const context = makeContext({ globalStateData: { worktreeAutoOpenPath: "/ws/a" } })
		await activate(context)
		expect(context.globalState.update).not.toHaveBeenCalledWith("worktreeAutoOpenPath", undefined)
	})

	it("workspaceFolders が undefined なら何もしない（!workspaceFolders 側）", async () => {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined
		const context = makeContext({ globalStateData: { worktreeAutoOpenPath: "/ws/a" } })
		await activate(context)
		expect(context.globalState.update).not.toHaveBeenCalledWith("worktreeAutoOpenPath", undefined)
	})

	it("パスが一致しなければ発火しない", async () => {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: "/ws/other" } }]
		const context = makeContext({ globalStateData: { worktreeAutoOpenPath: "/ws/a" } })
		await activate(context)
		expect(context.globalState.update).not.toHaveBeenCalledWith("worktreeAutoOpenPath", undefined)
	})

	it("パス一致で状態を消し、遅延後にサイドバーを開く", async () => {
		vi.useFakeTimers()
		try {
			;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: "/ws/A/" } }]
			// 末尾スラッシュ/大文字は normalize で無視される
			const context = makeContext({ globalStateData: { worktreeAutoOpenPath: "/ws/a" } })

			await activate(context)

			expect(context.globalState.update).toHaveBeenCalledWith("worktreeAutoOpenPath", undefined)
			await vi.advanceTimersByTimeAsync(500)
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("test-extension.plusButtonClicked")
		} finally {
			vi.useRealTimers()
		}
	})

	it("遅延後のサイドバーオープンが失敗しても握りつぶす", async () => {
		vi.useFakeTimers()
		try {
			;(vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
				if (cmd === "test-extension.plusButtonClicked") return Promise.reject(new Error("open boom"))
				return undefined
			})
			;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: "/ws/a" } }]
			const context = makeContext({ globalStateData: { worktreeAutoOpenPath: "/ws/a" } })

			await activate(context)
			// コールバック内の try/catch が reject を握るので、タイマー消化自体は例外にならない
			await vi.advanceTimersByTimeAsync(500)
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("test-extension.plusButtonClicked")
		} finally {
			vi.useRealTimers()
		}
	})

	it("サイドバーオープンが Error 以外で失敗しても String 化して握る（instanceof の else 側）", async () => {
		vi.useFakeTimers()
		try {
			;(vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
				if (cmd === "test-extension.plusButtonClicked") return Promise.reject("open string failure")
				return undefined
			})
			;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: "/ws/a" } }]
			const context = makeContext({ globalStateData: { worktreeAutoOpenPath: "/ws/a" } })

			await activate(context)
			await vi.advanceTimersByTimeAsync(500)
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("test-extension.plusButtonClicked")
		} finally {
			vi.useRealTimers()
		}
	})

	it("globalState.get が Error を投げても外側の catch で握って activate は完了する", async () => {
		const context = makeContext({ throwOnKey: "worktreeAutoOpenPath" })
		await expect(activate(context)).resolves.toBeDefined()
	})

	it("globalState.get が Error 以外を投げても String 化して握る（instanceof の else 側）", async () => {
		const context = makeContext({ throwOnKey: "worktreeAutoOpenPath", throwValue: "worktree string failure" })
		await expect(activate(context)).resolves.toBeDefined()
	})
})

describe("deactivate", () => {
	it("出力に記録し、MCP とターミナルを片付ける", async () => {
		await activate(makeContext())

		await deactivate()

		expect(mocks.mcpCleanup).toHaveBeenCalledTimes(1)
		expect(mocks.terminalCleanup).toHaveBeenCalledTimes(1)
	})
})
