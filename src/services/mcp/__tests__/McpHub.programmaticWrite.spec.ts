import fs from "fs/promises"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { McpProviderRef } from "../mcpProviderRef"
import { McpHub } from "../McpHub"

vi.mock("fs/promises", () => {
	const impl = {
		access: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("{}"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
	}
	return { default: impl, ...impl }
})

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		onDidChangeWorkspaceFolders: vi.fn(),
		workspaceFolders: [],
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	Disposable: { from: vi.fn() },
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn(),
	getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: vi.fn() }))

vi.mock("chokidar", () => ({
	default: { watch: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), close: vi.fn() }) },
}))

const SETTINGS_PATH = "/mock/settings/path/mcp_settings.json"

/** 2 サーバ構成の設定ファイル。削除対象は `doomed`、巻き添えを見るのが `keeper`。 */
const settingsJson = (servers: string[]) =>
	JSON.stringify({
		mcpServers: Object.fromEntries(
			servers.map((name) => [name, { type: "stdio", command: "node", args: [`${name}.js`] }]),
		),
	})

describe("McpHub programmatic write guard", () => {
	let mcpHub: McpHub
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		vi.clearAllMocks()
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(fs.readFile).mockResolvedValue(settingsJson(["doomed", "keeper"]) as never)

		const provider: McpProviderRef = {
			cwd: "/test/workspace",
			ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings/path"),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
			context: { extension: { packageJSON: { version: "1.0.0" } } },
		} as unknown as McpProviderRef

		mcpHub = new McpHub(provider)
		await mcpHub.waitUntilReady()
	})

	afterEach(() => {
		consoleErrorSpy.mockRestore()
		vi.useRealTimers()
	})

	/**
	 * 設定ファイルの watcher イベントを 1 回流し、debounce を明ける。
	 * watcher プランビングは `configWatcher` に分離されたが、「拡張自身の書き込みを無視
	 * するか」の唯一の入口なので、ここだけは内部に手を入れて叩く。
	 */
	const fireWatcherEvent = async () => {
		;(
			mcpHub as unknown as { configWatcher: { debounce(p: string, s: "global" | "project"): void } }
		).configWatcher.debounce(SETTINGS_PATH, "global")
		await vi.advanceTimersByTimeAsync(500)
	}

	it("updateServerTimeout の書き込みは watcher による再取り込みを抑止する（基準となる既存挙動）", async () => {
		mcpHub.connectionStore.replaceAll([
			{
				type: "disconnected",
				server: { name: "keeper", config: "{}", status: "disconnected", source: "global" },
				client: null,
				transport: null,
			} as never,
		])

		await mcpHub.updateServerTimeout("keeper", 120)

		vi.useFakeTimers()
		const reconcile = vi.spyOn(mcpHub, "updateServerConnections").mockResolvedValue(undefined)

		await fireWatcherEvent()

		expect(reconcile).not.toHaveBeenCalled()
	})

	it("deleteServer の書き込みも watcher による再取り込みを抑止する", async () => {
		mcpHub.connectionStore.replaceAll([
			{
				type: "disconnected",
				server: { name: "doomed", config: "{}", status: "disconnected", source: "global" },
				client: null,
				transport: null,
			} as never,
			{
				type: "disconnected",
				server: { name: "keeper", config: "{}", status: "disconnected", source: "global" },
				client: null,
				transport: null,
			} as never,
		])

		await mcpHub.deleteServer("doomed")

		// deleteServer 自身の明示的な再構成は既に済んでいる。ここから先、
		// watcher 由来の "2 回目" が走ると keeper が無用に再起動される。
		vi.useFakeTimers()
		const reconcile = vi.spyOn(mcpHub, "updateServerConnections").mockResolvedValue(undefined)

		await fireWatcherEvent()

		expect(reconcile).not.toHaveBeenCalled()
	})
})
