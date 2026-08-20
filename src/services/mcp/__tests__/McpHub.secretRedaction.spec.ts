import fs from "fs/promises"

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

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

vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: vi.fn().mockResolvedValue(undefined) }))

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
	window: { showErrorMessage: vi.fn(), showInformationMessage: vi.fn(), showWarningMessage: vi.fn() },
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

const SECRET_ENV = "MCP_REDACTION_TEST_SECRET"
const SECRET_VALUE = "sk-live-do-not-leak-4242"

/** `${env:...}` を含むサーバ設定。展開されると SECRET_VALUE になる。 */
const secretServer = {
	type: "stdio",
	command: "node",
	args: ["server.js"],
	env: { API_KEY: `\${env:${SECRET_ENV}}` },
}

describe("McpHub secret redaction (webview payload)", () => {
	let mcpHub: McpHub
	let postMessageToWebview: ReturnType<typeof vi.fn>
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		vi.clearAllMocks()
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		process.env[SECRET_ENV] = SECRET_VALUE

		// プロジェクト設定は存在しない構成にする（access が全部成功すると
		// 同じサーバが global と project の二重で読み込まれ、実運用と乖離する）
		vi.mocked(fs.access).mockImplementation(async (target) => {
			if (String(target).includes(".agent")) {
				throw new Error("ENOENT")
			}
		})
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ mcpServers: { secret: secretServer } }) as never)
		postMessageToWebview = vi.fn().mockResolvedValue(undefined)

		const provider: McpProviderRef = {
			cwd: "/test/workspace",
			ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/mock/settings"),
			postMessageToWebview,
			getState: vi.fn().mockResolvedValue({ mcpEnabled: true }),
			context: { extension: { packageJSON: { version: "1.0.0" } } },
		} as unknown as McpProviderRef

		mcpHub = new McpHub(provider)
		await mcpHub.waitUntilReady()
	})

	afterEach(() => {
		// restoreAllMocks はモジュールモック側の実装まで巻き戻して以降のテストを壊すので、
		// ここで張った spy だけ戻す。
		consoleErrorSpy.mockRestore()
		delete process.env[SECRET_ENV]
	})

	it("webview へ送るペイロードのどこにも展開後のシークレットが現れない", async () => {
		await mcpHub.updateServerConnections({ secret: secretServer }, "global", false)

		expect(postMessageToWebview).toHaveBeenCalled()

		// 送信された全メッセージを丸ごと文字列化して走査する（config 以外の経路も塞ぐ）
		const everythingSent = JSON.stringify(postMessageToWebview.mock.calls)

		expect(everythingSent).not.toContain(SECRET_VALUE)
	})

	it("ペイロードには展開前の宣言がそのまま載る", async () => {
		await mcpHub.updateServerConnections({ secret: secretServer }, "global", false)

		const servers = postMessageToWebview.mock.calls.at(-1)?.[0]?.mcpServers
		const sent = servers?.find((s: { name: string }) => s.name === "secret")

		expect(JSON.parse(sent.config).env).toEqual({ API_KEY: `\${env:${SECRET_ENV}}` })
	})

	it("getAllServers / getServers の返り値にもシークレットは含まれない", async () => {
		await mcpHub.updateServerConnections({ secret: secretServer }, "global", false)

		expect(JSON.stringify(mcpHub.getAllServers())).not.toContain(SECRET_VALUE)
		expect(JSON.stringify(mcpHub.getServers())).not.toContain(SECRET_VALUE)
	})

	it("展開後の値は transport にはきちんと渡る（秘匿と機能を両立している）", async () => {
		await mcpHub.updateServerConnections({ secret: secretServer }, "global", false)

		const passedEnv = vi.mocked(StdioClientTransport).mock.calls.at(-1)?.[0]?.env

		expect(passedEnv).toMatchObject({ API_KEY: SECRET_VALUE })
	})

	it("再接続は宣言から展開し直すので、env の変更を拾う", async () => {
		await mcpHub.updateServerConnections({ secret: secretServer }, "global", false)
		expect(vi.mocked(StdioClientTransport).mock.calls.at(-1)?.[0]?.env).toMatchObject({ API_KEY: SECRET_VALUE })

		process.env[SECRET_ENV] = "sk-live-rotated-9999"
		await mcpHub.restartConnection("secret", "global")

		expect(vi.mocked(StdioClientTransport).mock.calls.at(-1)?.[0]?.env).toMatchObject({
			API_KEY: "sk-live-rotated-9999",
		})
	})
})
