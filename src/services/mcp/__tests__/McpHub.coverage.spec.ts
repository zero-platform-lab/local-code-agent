import fs from "fs/promises"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { McpServer } from "@openai-agent/types"

import { McpHub } from "../McpHub"
import type { ConnectedMcpConnection, DisconnectedMcpConnection } from "../mcpConnection"

/**
 * McpHub の「まだ踏まれていない分岐」だけを狙って埋める補完スペック。
 *
 * 不変条件（このスペックが守らせたいこと）:
 *  - 本物の外部 MCP サーバへは繋がない（SDK Client / transport は全てモック）
 *  - 設定ファイルの読み書きは fs をモックして観測（実ファイルへ触れない）
 *  - 壊れた設定 / 未接続 / provider 消失でも throw で落ちず、防御分岐へ落ちる
 */

const hoisted = vi.hoisted(() => ({
	workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
	chokidarChangeHandlers: [] as Array<(p: string) => Promise<void>>,
}))

vi.mock("fs/promises", () => {
	const impl = {
		access: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue('{"mcpServers":{}}'),
		unlink: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
		lstat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
	}
	return { default: impl, ...impl }
})

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn(async (filePath: string, data: unknown) => {
		const fsMod = await import("fs/promises")
		return fsMod.writeFile(filePath, JSON.stringify(data), "utf8")
	}),
}))

vi.mock("delay", () => ({ default: vi.fn().mockResolvedValue(undefined) }))

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			dispose: vi.fn(),
		}),
		onDidSaveTextDocument: vi.fn(),
		onDidChangeWorkspaceFolders: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		get workspaceFolders() {
			return hoisted.workspaceFolders
		},
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	RelativePattern: vi.fn((base: string, pattern: string) => ({ base, pattern })),
	Disposable: {
		from: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn(),
	getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn(),
}))

vi.mock("chokidar", () => ({
	default: {
		watch: vi.fn(() => {
			const watcher: { on: (e: string, cb: (p: string) => Promise<void>) => unknown; close: () => void } = {
				on: (event: string, cb: (p: string) => Promise<void>) => {
					if (event === "change") hoisted.chokidarChangeHandlers.push(cb)
					return watcher
				},
				close: vi.fn(),
			}
			return watcher
		}),
	},
}))

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import * as vscode from "vscode"

const mockedReadFile = vi.mocked(fs.readFile)
const mockedAccess = vi.mocked(fs.access)
const mockedWriteFile = vi.mocked(fs.writeFile)

/** 設定ファイルの中身（`{ mcpServers: {...} }`）を全パスに対して返す。 */
function setConfigContent(servers: Record<string, unknown>): void {
	mockedReadFile.mockResolvedValue(JSON.stringify({ mcpServers: servers }))
}

function makeProvider(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/ws",
		ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings"),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
		context: {
			extension: { packageJSON: { version: "1.2.3" } },
		},
		...overrides,
	}
}

/** hub を作り初期化を待ってから、以降のアサーション用にモック呼び出し履歴を掃除する。 */
async function newHub(provider = makeProvider()): Promise<McpHub> {
	setConfigContent({})
	const hub = new McpHub(provider as never)
	await hub.waitUntilReady()
	vi.mocked(vscode.window.showErrorMessage).mockClear()
	vi.mocked(vscode.window.showInformationMessage).mockClear()
	vi.mocked(vscode.window.showWarningMessage).mockClear()
	provider.postMessageToWebview.mockClear()
	return hub
}

function server(overrides: Partial<McpServer> & { name: string }): McpServer {
	const base = {
		config: JSON.stringify({ type: "stdio", command: "node", timeout: 60 }),
		status: "connected",
		errorHistory: [],
	}
	return { ...base, ...overrides } as McpServer
}

function connected(overrides: Partial<McpServer> & { name: string }): ConnectedMcpConnection {
	return {
		type: "connected",
		declaredConfig: { type: "stdio", command: "node", timeout: 60 } as never,
		server: server(overrides),
		client: { close: vi.fn().mockResolvedValue(undefined), request: vi.fn().mockResolvedValue({}) } as never,
		transport: { close: vi.fn().mockResolvedValue(undefined) } as never,
	}
}

function disconnected(overrides: Partial<McpServer> & { name: string }): DisconnectedMcpConnection {
	return {
		type: "disconnected",
		declaredConfig: { type: "stdio", command: "node", timeout: 60 } as never,
		server: server({ status: "disconnected", ...overrides }),
		client: null,
		transport: null,
	}
}

/** stdio の connectToServer を最後まで通すための Client / transport スタブを仕込む。 */
function stubSdkConnect() {
	const transport = {
		start: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		stderr: { on: vi.fn() },
		onerror: undefined as ((e: unknown) => void) | undefined,
		onclose: undefined as (() => void) | undefined,
	}
	const client = {
		connect: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		getInstructions: vi.fn().mockReturnValue("instructions"),
		request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
	}
	vi.mocked(StdioClientTransport).mockImplementation(() => transport as never)
	vi.mocked(Client).mockImplementation(() => client as never)
	return { transport, client }
}

const originalConsoleError = console.error
const originalConsoleLog = console.log
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!

beforeEach(() => {
	vi.clearAllMocks()
	console.error = vi.fn()
	console.log = vi.fn()
	hoisted.workspaceFolders = []
	hoisted.chokidarChangeHandlers = []
	mockedAccess.mockResolvedValue(undefined)
	mockedReadFile.mockResolvedValue('{"mcpServers":{}}')
	mockedWriteFile.mockResolvedValue(undefined)
})

afterEach(() => {
	console.error = originalConsoleError
	console.log = originalConsoleLog
	Object.defineProperty(process, "platform", originalPlatform)
})

describe("constructor", () => {
	it("NODE_ENV が test 以外なら設定監視を張る", async () => {
		const prev = process.env.NODE_ENV
		process.env.NODE_ENV = "development"
		try {
			setConfigContent({})
			const hub = new McpHub(makeProvider() as never)
			await hub.waitUntilReady()
			// start() 内で watcher を張る（RelativePattern / createFileSystemWatcher 経由）。
			expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalled()
			await hub.dispose()
		} finally {
			process.env.NODE_ENV = prev
		}
	})
})

describe("register / unregister client", () => {
	it("最後のクライアントが去ると hub を dispose する", async () => {
		const hub = await newHub()
		hub.registerClient()
		hub.registerClient()

		await hub.unregisterClient()
		expect((hub as unknown as { isDisposed: boolean }).isDisposed).toBe(false)

		await hub.unregisterClient()
		expect((hub as unknown as { isDisposed: boolean }).isDisposed).toBe(true)
	})
})

describe("configWatcher host のブリッジ", () => {
	it("watcher へ渡した host コールバックが McpHub のメソッドへ委譲する", async () => {
		const hub = await newHub()
		const host = (hub as unknown as { configWatcher: { host: Record<string, (...a: unknown[]) => unknown> } })
			.configWatcher.host

		await expect(host.getGlobalSettingsPath()).resolves.toContain("mcp_settings.json")
		expect(host.getProjectCwd()).toBe("/ws")
		expect(host.isProgrammaticWrite()).toBe(false)

		// reload 系はそれぞれ対応する private メソッドを呼ぶ（ここでは throw しないことを見る）。
		setConfigContent({})
		await expect(host.reloadConfig("/mock/settings/mcp_settings.json", "global")).resolves.toBeUndefined()
		await expect(host.reloadProjectConfig()).resolves.toBeUndefined()
		await expect(host.handleProjectConfigDeleted()).resolves.toBeUndefined()

		// provider が消えていれば getProjectCwd は getWorkspacePath() へフォールバックする（?? の右側）。
		;(hub as unknown as { providerRef: { deref: () => undefined } }).providerRef = { deref: () => undefined }
		expect(typeof host.getProjectCwd()).toBe("string")
	})
})

describe("getMcpSettingsFilePath", () => {
	it("provider が消えていれば例外", async () => {
		const hub = await newHub()
		;(hub as unknown as { providerRef: { deref: () => undefined } }).providerRef = { deref: () => undefined }

		await expect(
			(hub as unknown as { getMcpSettingsFilePath: () => Promise<string> }).getMcpSettingsFilePath(),
		).rejects.toThrow("Provider not available")
	})

	it("設定ファイルが無ければ空テンプレートを書き出す", async () => {
		const hub = await newHub()
		mockedAccess.mockRejectedValueOnce(new Error("ENOENT")) // fileExistsAtPath -> false

		const p = await (hub as unknown as { getMcpSettingsFilePath: () => Promise<string> }).getMcpSettingsFilePath()

		expect(p).toContain("mcp_settings.json")
		expect(mockedWriteFile).toHaveBeenCalledWith(
			expect.stringContaining("mcp_settings.json"),
			expect.stringContaining("mcpServers"),
		)
	})
})

describe("isMcpEnabled", () => {
	it("provider が無ければ既定で有効", async () => {
		const hub = await newHub()
		;(hub as unknown as { providerRef: { deref: () => undefined } }).providerRef = { deref: () => undefined }

		await expect((hub as unknown as { isMcpEnabled: () => Promise<boolean> }).isMcpEnabled()).resolves.toBe(true)
	})

	it("state に mcpEnabled が無ければ既定で有効（?? true）", async () => {
		const provider = makeProvider({ getState: vi.fn().mockResolvedValue({}) })
		const hub = await newHub(provider)

		await expect((hub as unknown as { isMcpEnabled: () => Promise<boolean> }).isMcpEnabled()).resolves.toBe(true)
	})
})

describe("currentProjectPath", () => {
	it("project は先頭 workspace を返し、global は undefined", async () => {
		const hub = await newHub()
		hoisted.workspaceFolders = [{ uri: { fsPath: "/proj" } }]
		const fn = (
			hub as unknown as { currentProjectPath: (s: string) => string | undefined }
		).currentProjectPath.bind(hub)

		expect(fn("project")).toBe("/proj")
		expect(fn("global")).toBeUndefined()
	})
})

describe("findServerNameBySanitizedName", () => {
	it("サニタイズ名から実名を引く（ハイフン↔アンダースコアの揺れを吸収）", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "my-server", source: "global" })])
		hub.connectionStore.rememberName("my-server")

		// モデルが "my-server" を "my_server" に変換してきても実名へ戻せる。
		expect(hub.findServerNameBySanitizedName("my_server")).toBe("my-server")
		expect(hub.findServerNameBySanitizedName("unknown")).toBeNull()
	})
})

describe("handleConfigFileChange", () => {
	const call = (hub: McpHub, p: string, s: "global" | "project") =>
		(
			hub as unknown as { handleConfigFileChange: (p: string, s: "global" | "project") => Promise<void> }
		).handleConfigFileChange(p, s)

	it("正しい設定なら updateServerConnections を呼ぶ", async () => {
		const hub = await newHub()
		const spy = vi.spyOn(hub, "updateServerConnections").mockResolvedValue(undefined)
		setConfigContent({ a: { command: "node" } })

		await call(hub, "/g.json", "global")

		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ a: expect.anything() }), "global")
	})

	it("JSON として壊れていれば構文エラーを通知して中断", async () => {
		const hub = await newHub()
		mockedReadFile.mockResolvedValue("not-json")

		await call(hub, "/g.json", "global")

		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})

	it("スキーマ不一致なら検証エラーを通知して中断", async () => {
		const hub = await newHub()
		mockedReadFile.mockResolvedValue(JSON.stringify({ nope: true }))

		await call(hub, "/g.json", "global")

		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})

	it("project の ENOENT は設定削除として後始末する", async () => {
		const hub = await newHub()
		const cleanup = vi
			.spyOn(hub as unknown as { handleProjectConfigDeleted: () => Promise<void> }, "handleProjectConfigDeleted")
			.mockResolvedValue(undefined)
		mockedReadFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))

		await call(hub, "/p.json", "project")

		expect(cleanup).toHaveBeenCalled()
	})

	it("その他の読み取りエラーはエラー表示にとどめる", async () => {
		const hub = await newHub()
		mockedReadFile.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }))

		await call(hub, "/g.json", "global")

		expect(console.error).toHaveBeenCalled()
	})
})

describe("handleProjectConfigDeleted / cleanupProjectMcpServers", () => {
	it("project 接続を全て切ってから空で reconcile し、通知する", async () => {
		const hub = await newHub()
		const projConn = connected({ name: "p1", source: "project" })
		hub.connectionStore.replaceAll([projConn])

		await (hub as unknown as { handleProjectConfigDeleted: () => Promise<void> }).handleProjectConfigDeleted()

		expect(projConn.transport.close).toHaveBeenCalled()
		expect(hub.connectionStore.withSource("project")).toHaveLength(0)
		expect(vscode.window.showInformationMessage).toHaveBeenCalled()
	})
})

describe("updateProjectMcpServers", () => {
	const call = (hub: McpHub) =>
		(hub as unknown as { updateProjectMcpServers: () => Promise<void> }).updateProjectMcpServers()

	it("project 設定ファイルが無ければ何もしない", async () => {
		const hub = await newHub()
		mockedAccess.mockRejectedValue(new Error("ENOENT")) // getProjectMcpPath -> null
		const spy = vi.spyOn(hub, "updateServerConnections")

		await call(hub)

		expect(spy).not.toHaveBeenCalled()
	})

	it("正しい project 設定なら project ソースで反映する", async () => {
		const hub = await newHub()
		const spy = vi.spyOn(hub, "updateServerConnections").mockResolvedValue(undefined)
		setConfigContent({ a: { command: "node" } })

		await call(hub)

		expect(spy).toHaveBeenCalledWith(expect.anything(), "project")
	})

	it("JSON が壊れていれば構文エラーを通知", async () => {
		const hub = await newHub()
		mockedReadFile.mockResolvedValue("nope")

		await call(hub)

		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})

	it("スキーマ不一致なら検証エラーを通知", async () => {
		const hub = await newHub()
		mockedReadFile.mockResolvedValue(JSON.stringify({ notMcpServers: 1 }))

		await call(hub)

		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})

	it("読み取り例外は showErrorMessage にとどめる", async () => {
		const hub = await newHub()
		// access は成功（path あり）だが readFile が投げる。
		mockedReadFile.mockRejectedValue(new Error("boom"))

		await call(hub)

		expect(console.error).toHaveBeenCalled()
	})
})

describe("initializeMcpServers の防御分岐", () => {
	const init = (hub: McpHub, s: "global" | "project") =>
		(hub as unknown as { initializeMcpServers: (s: "global" | "project") => Promise<void> }).initializeMcpServers(s)

	it("global はスキーマ不一致でも raw config で接続を試みる", async () => {
		const hub = await newHub()
		const spy = vi.spyOn(hub, "updateServerConnections").mockResolvedValue(undefined)
		// mcpServers は在るが中身が不正（parseMcpSettings は失敗 → raw fallback）。
		mockedReadFile.mockResolvedValue(JSON.stringify({ mcpServers: { a: { type: "bogus" } } }))

		await init(hub, "global")

		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
		// raw fallback で updateServerConnections(config.mcpServers) を呼ぶ。
		expect(spy).toHaveBeenCalled()
	})

	it("mcpServers セクションすら無い global 設定は raw fallback を空 {} で試す", async () => {
		const hub = await newHub()
		const spy = vi.spyOn(hub, "updateServerConnections").mockResolvedValue(undefined)
		// mcpServers キーが無い → parseMcpSettings 失敗 → config.mcpServers || {} の右側。
		mockedReadFile.mockResolvedValue("{}")

		await init(hub, "global")

		expect(spy).toHaveBeenCalledWith({}, "global", false)
	})

	it("raw fallback 自体が失敗しても showErrorMessage で握る", async () => {
		const hub = await newHub()
		vi.spyOn(hub, "updateServerConnections").mockRejectedValue(new Error("connect fail"))
		mockedReadFile.mockResolvedValue(JSON.stringify({ mcpServers: { a: { type: "bogus" } } }))

		await init(hub, "global")

		expect(console.error).toHaveBeenCalled()
	})

	it("構文エラーは SyntaxError として通知する", async () => {
		const hub = await newHub()
		mockedReadFile.mockResolvedValue("not-json-at-all")

		await init(hub, "global")

		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})

	it("構文以外の読み取りエラーは failed to initialize 扱い", async () => {
		const hub = await newHub()
		mockedReadFile.mockRejectedValue(new Error("EIO"))

		await init(hub, "global")

		expect(console.error).toHaveBeenCalled()
	})
})

describe("connectToServer の残り分岐", () => {
	it("version 未設定 / project source でも接続し、切断通知の配線が生きる", async () => {
		const provider = makeProvider({ context: { extension: { packageJSON: {} } } }) // version undefined -> ?? "1.0.0"
		const hub = await newHub(provider)
		hoisted.workspaceFolders = [{ uri: { fsPath: "/wsx" } }] // workspaceFolders?.[0] あり -> ?? "" の左側
		const { transport } = stubSdkConnect()
		const notify = vi.spyOn(
			hub as unknown as { notifyWebviewOfServerChanges: () => Promise<void> },
			"notifyWebviewOfServerChanges",
		)

		await (
			hub as unknown as {
				connectToServer: (n: string, c: unknown, s: string) => Promise<void>
			}
		).connectToServer("srv", { type: "stdio", command: "node", timeout: 60 }, "project")

		const conn = hub.connectionStore.find("srv")
		expect(conn?.server.status).toBe("connected")
		expect(conn?.server.projectPath).toBe("/wsx")

		// transport のライフサイクルハンドラ（onclose）が McpHub の notify へ配線されている。
		notify.mockClear()
		await transport.onclose?.()
		expect(notify).toHaveBeenCalled()
	})
})

describe("setupFileWatcher", () => {
	it("監視対象が変わると restartConnection を呼ぶ", async () => {
		const hub = await newHub()
		const restart = vi
			.spyOn(hub as unknown as { restartConnection: (...a: unknown[]) => Promise<void> }, "restartConnection")
			.mockResolvedValue(undefined)

		;(hub as unknown as { setupFileWatcher: (n: string, c: unknown, s: string) => void }).setupFileWatcher(
			"srv",
			{ type: "stdio", command: "node", watchPaths: ["/watched/file.js"], timeout: 60 },
			"global",
		)

		// chokidar の change ハンドラを発火させる。
		expect(hoisted.chokidarChangeHandlers.length).toBeGreaterThan(0)
		await hoisted.chokidarChangeHandlers[0]("/watched/file.js")

		expect(restart).toHaveBeenCalledWith("srv", "global")
	})
})

describe("updateServerConnections: 不正な設定", () => {
	it("検証に失敗したサーバは invalid として表示し接続しない", async () => {
		const hub = await newHub()

		await hub.updateServerConnections({ bad: { type: "totally-wrong" } }, "global")

		// showErrorMessage は console.error への薄いラッパ。invalid アクションはログにとどめ接続しない。
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('Invalid configuration for MCP server "bad"'),
			expect.anything(),
		)
		expect(hub.connectionStore.find("bad")).toBeUndefined()
	})
})

describe("restartConnection", () => {
	it("検証に通る設定なら削除してから繋ぎ直す（source 未設定は global 扱い）", async () => {
		const hub = await newHub()
		const conn = connected({
			name: "r1",
			source: undefined,
			config: JSON.stringify({ type: "stdio", command: "node" }),
		})
		hub.connectionStore.replaceAll([conn])
		const connectSpy = vi
			.spyOn(hub as unknown as { connectToServer: (...a: unknown[]) => Promise<void> }, "connectToServer")
			.mockResolvedValue(undefined)

		await hub.restartConnection("r1")

		expect(connectSpy).toHaveBeenCalledWith("r1", expect.anything(), "global")
		expect(vscode.window.showInformationMessage).toHaveBeenCalled()
		expect(hub.isConnecting).toBe(false)
	})

	it("設定がスキーマ違反なら検証エラーを表示する", async () => {
		const hub = await newHub()
		const conn = connected({ name: "r2", config: JSON.stringify({ type: "bogus" }) })
		hub.connectionStore.replaceAll([conn])

		await hub.restartConnection("r2")

		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('Invalid configuration for MCP server "r2"'),
			expect.anything(),
		)
	})

	it("設定が JSON として壊れていれば restart 失敗として握る", async () => {
		const hub = await newHub()
		const conn = connected({ name: "r3", config: "broken-json" })
		hub.connectionStore.replaceAll([conn])

		await hub.restartConnection("r3")

		expect(console.error).toHaveBeenCalled()
		expect(hub.isConnecting).toBe(false)
	})
})

describe("refreshAllConnections", () => {
	it("既に接続処理中なら何もしない", async () => {
		const hub = await newHub()
		hub.isConnecting = true
		const spy = vi.spyOn(
			hub as unknown as { getMcpSettingsFilePath: () => Promise<string> },
			"getMcpSettingsFilePath",
		)

		await hub.refreshAllConnections()

		expect(spy).not.toHaveBeenCalled()
	})

	it("有効時は既存接続を全て切ってから設定を読み直して初期化し直す", async () => {
		const hub = await newHub()
		const existing = connected({ name: "old", source: "global" })
		hub.connectionStore.replaceAll([existing])
		setConfigContent({})

		await hub.refreshAllConnections()

		// 既存接続は一旦切られる（delete ループを通す）。
		expect(existing.transport.close).toHaveBeenCalled()
		expect(hub.isConnecting).toBe(false)
	})

	it("設定ファイルが壊れていても read エラーを握って落ちない", async () => {
		const hub = await newHub()
		mockedReadFile.mockResolvedValue("not-json")

		await hub.refreshAllConnections()

		// global / project の read エラーが console.log される。
		expect(console.log).toHaveBeenCalled()
		expect(hub.isConnecting).toBe(false)
	})
})

describe("notifyWebviewOfServerChanges の防御分岐", () => {
	const notify = (hub: McpHub) =>
		(hub as unknown as { notifyWebviewOfServerChanges: () => Promise<void> }).notifyWebviewOfServerChanges()

	it("project 設定の読み取りに失敗しても global 順で続行する", async () => {
		const hub = await newHub()
		// global path は正常、project path (.agent/mcp.json) だけ壊す。
		mockedReadFile.mockImplementation(async (p: unknown) =>
			String(p).includes(".agent") ? "broken" : '{"mcpServers":{}}',
		)

		await expect(notify(hub)).resolves.toBeUndefined()
	})

	it("postMessage が失敗しても throw しない", async () => {
		const provider = makeProvider({ postMessageToWebview: vi.fn().mockRejectedValue(new Error("post fail")) })
		const hub = await newHub(provider)

		await expect(notify(hub)).resolves.toBeUndefined()
		expect(console.error).toHaveBeenCalled()
	})

	it("provider が消えていれば送信先なしとしてログする", async () => {
		const hub = await newHub()
		;(hub as unknown as { getMcpSettingsFilePath: () => Promise<string> }).getMcpSettingsFilePath = vi
			.fn()
			.mockResolvedValue("/mock/settings/mcp_settings.json")
		;(hub as unknown as { providerRef: { deref: () => undefined } }).providerRef = { deref: () => undefined }

		await notify(hub)

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("No target provider"))
	})
})

describe("toggleServerDisabled", () => {
	it("存在しないサーバは例外にして再送出する（source の有無どちらも）", async () => {
		const hub = await newHub()

		// source 無し（メッセージの : "" 側）
		await expect(hub.toggleServerDisabled("nope", true)).rejects.toThrow(/^Server nope not found$/)
		// source 有り（メッセージの source ? ... 側）
		await expect(hub.toggleServerDisabled("nope", true, "project")).rejects.toThrow("with source project")
		expect(console.error).toHaveBeenCalled()
	})

	it("無効化: 接続中サーバを止めて無効 placeholder として置き直す", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "s1", source: undefined, status: "connected" })])
		vi.spyOn(
			hub as unknown as { updateServerConfig: (...a: unknown[]) => Promise<void> },
			"updateServerConfig",
		).mockResolvedValue(undefined)
		vi.spyOn(
			hub as unknown as { reconnectFromFile: (...a: unknown[]) => Promise<void> },
			"reconnectFromFile",
		).mockResolvedValue(undefined)

		await hub.toggleServerDisabled("s1", true)

		expect(hub.connectionStore.find("s1")?.server.disabled).toBe(true)
	})

	it("有効化: 切断中サーバは削除してから繋ぎ直す（deleteFirst）", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([disconnected({ name: "s2", source: "global", status: "disconnected" })])
		vi.spyOn(
			hub as unknown as { updateServerConfig: (...a: unknown[]) => Promise<void> },
			"updateServerConfig",
		).mockResolvedValue(undefined)
		const connectSpy = vi
			.spyOn(hub as unknown as { connectToServer: (...a: unknown[]) => Promise<void> }, "connectToServer")
			.mockResolvedValue(undefined)
		setConfigContent({ s2: { command: "node" } })

		await hub.toggleServerDisabled("s2", false)

		// reconnectFromFile 経由で connectToServer まで到達する。
		expect(connectSpy).toHaveBeenCalledWith("s2", expect.anything(), "global")
	})

	it("有効化: 接続中サーバは capabilities のみ取り直す", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "s3", source: "global", status: "connected" })])
		vi.spyOn(
			hub as unknown as { updateServerConfig: (...a: unknown[]) => Promise<void> },
			"updateServerConfig",
		).mockResolvedValue(undefined)
		const refresh = vi
			.spyOn(
				hub as unknown as { refreshServerCapabilities: (...a: unknown[]) => Promise<void> },
				"refreshServerCapabilities",
			)
			.mockResolvedValue(undefined)

		await hub.toggleServerDisabled("s3", false)

		expect(refresh).toHaveBeenCalled()
	})

	it("再接続処理が失敗しても内側で握って通知まで進む", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([disconnected({ name: "s4", source: "global", status: "disconnected" })])
		vi.spyOn(
			hub as unknown as { updateServerConfig: (...a: unknown[]) => Promise<void> },
			"updateServerConfig",
		).mockResolvedValue(undefined)
		vi.spyOn(
			hub as unknown as { reconnectFromFile: (...a: unknown[]) => Promise<void> },
			"reconnectFromFile",
		).mockRejectedValue(new Error("boom"))

		await hub.toggleServerDisabled("s4", false)

		expect(console.error).toHaveBeenCalled()
	})
})

describe("readServerConfigFromFile", () => {
	it("設定ファイルにサーバが無ければ例外", async () => {
		const hub = await newHub()
		setConfigContent({ other: { command: "node" } })

		await expect(
			(
				hub as unknown as { readServerConfigFromFile: (n: string, s: string) => Promise<unknown> }
			).readServerConfigFromFile("missing", "global"),
		).rejects.toThrow("not found in config")
	})
})

describe("updateServerTimeout", () => {
	it("存在しないサーバは例外にして再送出する（source の有無どちらも）", async () => {
		const hub = await newHub()

		await expect(hub.updateServerTimeout("nope", 30, "global")).rejects.toThrow("with source global")
		await expect(hub.updateServerTimeout("nope", 30)).rejects.toThrow(/^Server nope not found$/)
	})

	it("timeout を設定ファイルへ書き込み webview へ通知する（source 未設定は global）", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "t1", source: undefined })])
		setConfigContent({ t1: { command: "node" } })

		await hub.updateServerTimeout("t1", 120)

		expect(mockedWriteFile).toHaveBeenCalled()
	})

	it("設定ファイルにサーバが無くても既定 {} から作って書き込む（?? {} の右側）", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "t2", source: "global" })])
		setConfigContent({}) // t2 は設定ファイルに存在しない

		await hub.updateServerTimeout("t2", 30)

		expect(mockedWriteFile).toHaveBeenCalled()
	})
})

describe("deleteServer", () => {
	it("存在しないサーバは例外にして再送出する（source の有無どちらも）", async () => {
		const hub = await newHub()

		await expect(hub.deleteServer("nope", "project")).rejects.toThrow("with source project")
		await expect(hub.deleteServer("nope")).rejects.toThrow(/^Server nope not found$/)
	})

	it("設定ファイルにあるサーバを消して残りを reconcile する（source 未設定は global）", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "d1", source: undefined })])
		setConfigContent({ d1: { command: "node" }, keep: { command: "node" } })
		vi.spyOn(hub, "updateServerConnections").mockResolvedValue(undefined)

		await hub.deleteServer("d1")

		expect(mockedWriteFile).toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalled()
	})

	it("設定ファイルに無いサーバの削除は警告のみ", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "d2", source: "global" })])
		setConfigContent({ other: { command: "node" } })

		await hub.deleteServer("d2")

		expect(vscode.window.showWarningMessage).toHaveBeenCalled()
	})
})

describe("readResource / callTool のガード", () => {
	it("readResource: 未接続なら source つきメッセージで例外", async () => {
		const hub = await newHub()

		await expect(hub.readResource("missing", "res://x", "global")).rejects.toThrow(
			"No connection found for server: missing with source global",
		)
	})

	it("readResource: source 無しの未接続メッセージ", async () => {
		const hub = await newHub()

		await expect(hub.readResource("missing", "res://x")).rejects.toThrow(/No connection found for server: missing$/)
	})

	it("readResource: disabled なサーバは弾く", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "rr1", source: "global", disabled: true })])

		await expect(hub.readResource("rr1", "res://x")).rejects.toThrow('Server "rr1" is disabled')
	})

	it("readResource: 接続済みなら requestResourceRead へ委譲する", async () => {
		const hub = await newHub()
		const conn = connected({ name: "rr2", source: "global" })
		;(conn.client.request as ReturnType<typeof vi.fn>).mockResolvedValue({ contents: [] })
		hub.connectionStore.replaceAll([conn])

		const result = await hub.readResource("rr2", "res://y")

		expect(conn.client.request).toHaveBeenCalledWith(
			{ method: "resources/read", params: { uri: "res://y" } },
			expect.anything(),
		)
		expect(result).toEqual({ contents: [] })
	})

	it("callTool: source つきメッセージで未接続を弾く", async () => {
		const hub = await newHub()

		await expect(hub.callTool("missing", "tool", {}, "project")).rejects.toThrow(
			"No connection found for server: missing with source project",
		)
	})

	it("callTool: 接続はあるが disabled なら弾く", async () => {
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "c1", source: "global", disabled: true })])

		await expect(hub.callTool("c1", "tool", {})).rejects.toThrow('Server "c1" is disabled')
	})
})

describe("updateServerToolList 経由の分岐", () => {
	it("接続が無ければ toggleToolAlwaysAllow は例外を再送出", async () => {
		const hub = await newHub()

		await expect(hub.toggleToolAlwaysAllow("nope", "global", "tool", true)).rejects.toThrow("not found")
		expect(console.error).toHaveBeenCalled()
	})

	it("接続が無ければ toggleToolEnabledForPrompt も例外を再送出", async () => {
		const hub = await newHub()

		await expect(hub.toggleToolEnabledForPrompt("nope", "global", "tool", true)).rejects.toThrow("not found")
		expect(console.error).toHaveBeenCalled()
	})

	it("Windows ではパスを正規化しつつ、設定に無いサーバは既定 stdio を補って書き込む", async () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		const hub = await newHub()
		hub.connectionStore.replaceAll([connected({ name: "w1", source: "global" })])
		// 設定ファイルには w1 が無い → default stdio を補う分岐へ。
		setConfigContent({})

		await hub.toggleToolAlwaysAllow("w1", "global", "toolA", true)

		expect(mockedWriteFile).toHaveBeenCalled()
	})
})

describe("handleMcpEnabledChange", () => {
	it("無効化: 接続を全て切って refreshAllConnections する", async () => {
		const provider = makeProvider({ getState: vi.fn().mockResolvedValue({ mcpEnabled: false }) })
		const hub = await newHub(provider)
		hub.connectionStore.replaceAll([connected({ name: "e1", source: "global" })])

		await hub.handleMcpEnabledChange(false)

		expect(hub.connectionStore.find("e1")?.type).not.toBe("connected")
	})

	it("無効化: 切断に失敗したサーバがあれば警告でまとめて知らせる（Error / 非 Error 両方）", async () => {
		const provider = makeProvider({ getState: vi.fn().mockResolvedValue({ mcpEnabled: false }) })
		const hub = await newHub(provider)
		hub.connectionStore.replaceAll([
			connected({ name: "e2a", source: "global" }),
			connected({ name: "e2b", source: "global" }),
		])
		// 1 件目は Error（error.message 側）、2 件目は非 Error（String(error) 側）で失敗させる。
		vi.spyOn(hub, "deleteConnection")
			.mockRejectedValueOnce(new Error("cannot close"))
			.mockRejectedValueOnce("plain string failure")
		vi.spyOn(hub, "refreshAllConnections").mockResolvedValue(undefined)

		await hub.handleMcpEnabledChange(false)

		expect(vscode.window.showWarningMessage).toHaveBeenCalled()
	})

	it("無効化: refreshAllConnections が失敗したらエラー通知する", async () => {
		const provider = makeProvider({ getState: vi.fn().mockResolvedValue({ mcpEnabled: false }) })
		const hub = await newHub(provider)
		vi.spyOn(hub, "refreshAllConnections").mockRejectedValue(new Error("refresh fail"))

		await hub.handleMcpEnabledChange(false)

		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})

	it("有効化: refreshAllConnections を呼ぶ", async () => {
		const hub = await newHub()
		const refresh = vi.spyOn(hub, "refreshAllConnections").mockResolvedValue(undefined)

		await hub.handleMcpEnabledChange(true)

		expect(refresh).toHaveBeenCalled()
	})

	it("有効化: refreshAllConnections が失敗したらエラー通知する", async () => {
		const hub = await newHub()
		vi.spyOn(hub, "refreshAllConnections").mockRejectedValue(new Error("refresh fail"))

		await hub.handleMcpEnabledChange(true)

		expect(vscode.window.showErrorMessage).toHaveBeenCalled()
	})
})

describe("dispose", () => {
	it("接続を閉じ、二重 dispose は無視する", async () => {
		const hub = await newHub()
		const conn = connected({ name: "z1", source: "global" })
		hub.connectionStore.replaceAll([conn])

		await hub.dispose()
		expect(conn.transport.close).toHaveBeenCalled()
		expect((hub as unknown as { isDisposed: boolean }).isDisposed).toBe(true)

		// 2 回目は早期 return（例外を投げない）。
		await expect(hub.dispose()).resolves.toBeUndefined()
	})

	it("接続の close に失敗しても最後まで dispose を続ける", async () => {
		const hub = await newHub()
		vi.spyOn(hub, "deleteConnection").mockRejectedValue(new Error("close fail"))
		hub.connectionStore.replaceAll([connected({ name: "z2", source: "global" })])

		await hub.dispose()

		expect(console.error).toHaveBeenCalled()
	})
})
