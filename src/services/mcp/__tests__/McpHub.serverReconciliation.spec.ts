import fs from "fs/promises"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"

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
	StdioClientTransport: vi.fn().mockImplementation(() => ({
		start: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		stderr: null,
	})),
	getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		getInstructions: vi.fn().mockReturnValue(undefined),
		request: vi.fn().mockResolvedValue({ tools: [], resources: [], resourceTemplates: [] }),
	})),
}))

vi.mock("chokidar", () => ({
	default: { watch: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), close: vi.fn() }) },
}))

/** 変数展開を使うサーバ設定。展開結果は env に依存する。 */
const ENV_VAR = "MCP_RECONCILE_TEST_TOKEN"

const plainServer = { type: "stdio", command: "node", args: ["plain.js"] }
const envServer = { type: "stdio", command: "node", args: ["env.js"], env: { TOKEN: `\${env:${ENV_VAR}}` } }

const settings = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers })

describe("McpHub server reconciliation (change detection)", () => {
	let mcpHub: McpHub
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		vi.clearAllMocks()
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		process.env[ENV_VAR] = "token-v1"

		vi.mocked(fs.readFile).mockResolvedValue(settings({}) as never)

		const provider: McpProviderRef = {
			cwd: "/test/workspace",
			ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings"),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
			context: { extension: { packageJSON: { version: "1.0.0" } } },
		} as unknown as McpProviderRef

		mcpHub = new McpHub(provider)
		await mcpHub.waitUntilReady()
	})

	afterEach(() => {
		consoleErrorSpy.mockRestore()
		delete process.env[ENV_VAR]
	})

	/** 2 回目の reconcile で再接続が起きたかを数える。 */
	const reconcileTwice = async (servers: Record<string, unknown>, second = servers) => {
		await mcpHub.updateServerConnections(servers, "global", false)

		const reconnects = vi.spyOn(mcpHub, "deleteConnection")
		await mcpHub.updateServerConnections(second, "global", false)

		return reconnects.mock.calls.map(([name]) => name)
	}

	it("内容が変わっていない素の設定は再接続しない", async () => {
		expect(await reconcileTwice({ plain: plainServer })).toEqual([])
	})

	it("内容が変わった設定は再接続する", async () => {
		const restarted = await reconcileTwice(
			{ plain: plainServer },
			{ plain: { ...plainServer, args: ["changed.js"] } },
		)

		expect(restarted).toContain("plain")
	})

	it("変数展開を使うサーバは、内容が変わっていなくても再接続しない", async () => {
		expect(await reconcileTwice({ withEnv: envServer })).toEqual([])
	})

	it("生の設定（検証前）を渡されても、内容が同じなら再接続しない", async () => {
		// deleteServer / initializeMcpServers のフォールバックは検証前の生 JSON を渡す。
		// 既定値（timeout/alwaysAllow/disabledTools/cwd）が無いだけで別物扱いしてはいけない。
		await mcpHub.updateServerConnections({ plain: plainServer }, "global", false)

		const reconnects = vi.spyOn(mcpHub, "deleteConnection")
		await mcpHub.updateServerConnections({ plain: { ...plainServer } }, "global", false)

		expect(reconnects.mock.calls.map(([name]) => name)).toEqual([])
	})

	it("サーバを 1 つ削除しても、残ったサーバは再接続されない", async () => {
		vi.mocked(fs.readFile).mockResolvedValue(settings({ doomed: plainServer, keeper: envServer }) as never)
		await mcpHub.updateServerConnections({ doomed: plainServer, keeper: envServer }, "global", false)

		const reconnects = vi.spyOn(mcpHub, "deleteConnection")
		await mcpHub.deleteServer("doomed")

		expect(reconnects.mock.calls.map(([name]) => name)).toEqual(["doomed"])
	})

	it("env が変わっても、設定ファイルが変わっていなければ再接続しない（reconcile は file が真）", async () => {
		await mcpHub.updateServerConnections({ withEnv: envServer }, "global", false)

		process.env[ENV_VAR] = "token-v2"

		const reconnects = vi.spyOn(mcpHub, "deleteConnection")
		await mcpHub.updateServerConnections({ withEnv: envServer }, "global", false)

		expect(reconnects.mock.calls.map(([name]) => name)).toEqual([])
	})

	it("無効サーバ（placeholder）も内容が同じなら再接続しない", async () => {
		const disabled = { ...plainServer, disabled: true }

		expect(await reconcileTwice({ off: disabled })).toEqual([])
	})

	it("変数展開の結果は transport に渡る（展開自体は止めない）", async () => {
		await mcpHub.updateServerConnections({ withEnv: envServer }, "global", false)

		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
		const passedEnv = vi.mocked(StdioClientTransport).mock.calls.at(-1)?.[0]?.env

		expect(passedEnv).toMatchObject({ TOKEN: "token-v1" })
		expect(Client).toHaveBeenCalled()
	})
})
