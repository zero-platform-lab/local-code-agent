// npx vitest run core/webview/__tests__/mcpMessageHandlers.spec.ts
//
// mcpMessageHandlers は webview からの操作でワークスペース内にディレクトリを作り
// （fs.mkdir）、MCP 設定ファイルを書き出す（safeWriteJson）。webview から来る値が
// パス組み立てに混ざると任意の場所へ書けてしまうため、行数ではなく次を不変条件として固定する。
//
//   3. fs.mkdir / safeWriteJson に渡った「全パス」が想定ディレクトリ（<cwd>/.agent）配下で、
//      ファイル名がちょうど mcp.json であること
//   3'. パスが webview メッセージのどのフィールドにも影響されないこと
//   その他: 既存の mcp.json を上書きしないこと、McpHub 未初期化でも落ちないこと

import path from "node:path"

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { WebviewMessage } from "@openai-agent/types"

import { mcpMessageHandlers } from "../mcpMessageHandlers"
import type { WebviewMessageHost } from "../webviewMessageHost"

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

const { workspaceMock, showErrorMessageMock, mkdirMock, safeWriteJsonMock, fileExistsAtPathMock, openFileMock } =
	vi.hoisted(() => ({
		workspaceMock: { workspaceFolders: [{ uri: { fsPath: "/workspace/project" } }] as unknown },
		showErrorMessageMock: vi.fn(),
		mkdirMock: vi.fn(async (..._args: unknown[]) => undefined),
		safeWriteJsonMock: vi.fn(async (..._args: unknown[]) => undefined),
		fileExistsAtPathMock: vi.fn(async (..._args: unknown[]) => false),
		openFileMock: vi.fn(async (..._args: unknown[]) => undefined),
	}))

vi.mock("vscode", () => ({
	workspace: workspaceMock,
	window: { showErrorMessage: showErrorMessageMock },
}))

// 実装は `import * as fs from "fs/promises"` の名前空間 import。default も生やしておく。
vi.mock("fs/promises", () => {
	const api = { mkdir: mkdirMock }
	return { ...api, default: api }
})

vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: safeWriteJsonMock }))

vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: fileExistsAtPathMock }))

vi.mock("../../../integrations/misc/open-file", () => ({ openFile: openFileMock }))

// t はキーと引数をそのまま返す。文言ではなく「どのキーで何を伝えたか」を見たいため。
vi.mock("../../../i18n", () => ({
	t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
}))

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

const PROVIDER_CWD = "/workspace/project"

/** fs.mkdir に渡った第 1 引数（作られるディレクトリ）を呼ばれた順に全件返す。 */
const mkdirPaths = (): string[] => mkdirMock.mock.calls.map((c) => c[0] as string)

/** safeWriteJson に渡った第 1 引数（書き込み先）を呼ばれた順に全件返す。 */
const writePaths = (): string[] => safeWriteJsonMock.mock.calls.map((c) => c[0] as string)

/** fileExistsAtPath に渡ったパスを全件返す。 */
const existsPaths = (): string[] => fileExistsAtPathMock.mock.calls.map((c) => c[0] as string)

/** openFile に渡ったパスを全件返す。 */
const openedPaths = (): string[] => openFileMock.mock.calls.map((c) => c[0] as string)

/**
 * ファイルシステムに触った全パスが `<cwd>/.agent` 配下に収まっていることを検査する。
 *
 * ここが崩れると webview 操作でワークスペース外にディレクトリを作られたり、
 * 既存ファイルを mcp.json で置き換えられたりする。個々の期待値とは別に、
 * 書き込みが走るケースでは必ずこの形を通す。
 */
function expectAllPathsInsideAgentDir(cwd: string): void {
	const agentDir = path.join(cwd, ".agent")

	for (const p of mkdirPaths()) {
		expect(p).toBe(agentDir)
	}

	for (const p of [...writePaths(), ...existsPaths(), ...openedPaths()]) {
		expect(path.dirname(p)).toBe(agentDir)
		expect(path.basename(p)).toBe("mcp.json")
		// 正規化しても .agent の外へ抜けない。
		expect(path.resolve(p)).toBe(path.resolve(agentDir, "mcp.json"))
		expect(path.relative(agentDir, path.resolve(p)).startsWith("..")).toBe(false)
	}
}

interface FakeMcpHub {
	getMcpSettingsFilePath: ReturnType<typeof vi.fn>
	deleteServer: ReturnType<typeof vi.fn>
	restartConnection: ReturnType<typeof vi.fn>
	toggleServerDisabled: ReturnType<typeof vi.fn>
	refreshAllConnections: ReturnType<typeof vi.fn>
	toggleToolAlwaysAllow: ReturnType<typeof vi.fn>
	toggleToolEnabledForPrompt: ReturnType<typeof vi.fn>
	updateServerTimeout: ReturnType<typeof vi.fn>
}

const makeHub = (): FakeMcpHub => ({
	getMcpSettingsFilePath: vi.fn(async () => "/global/settings/mcp_settings.json"),
	deleteServer: vi.fn(async () => {}),
	restartConnection: vi.fn(async () => {}),
	toggleServerDisabled: vi.fn(async () => {}),
	refreshAllConnections: vi.fn(async () => {}),
	toggleToolAlwaysAllow: vi.fn(async () => {}),
	toggleToolEnabledForPrompt: vi.fn(async () => {}),
	updateServerTimeout: vi.fn(async () => {}),
})

interface SetupOptions {
	/** getMcpHub() の戻り値。既定は undefined（未初期化）。 */
	hub?: FakeMcpHub
	/** getCurrentTask() の戻り値。cwd を持つ想定。 */
	currentTask?: { cwd: string }
	/** provider.cwd。 */
	cwd?: string
}

function setup(options: SetupOptions = {}) {
	const log = vi.fn()
	const postStateToWebview = vi.fn(async () => {})
	const getMcpHub = vi.fn(() => options.hub)
	const getCurrentTask = vi.fn(() => options.currentTask)

	const provider = {
		cwd: options.cwd ?? PROVIDER_CWD,
		log,
		postStateToWebview,
		getMcpHub,
		getCurrentTask,
	} as unknown as WebviewMessageHost

	return { provider, log, postStateToWebview, getMcpHub, getCurrentTask, hub: options.hub }
}

const call = (type: WebviewMessage["type"], provider: WebviewMessageHost, message: Partial<WebviewMessage> = {}) =>
	mcpMessageHandlers[type]!(provider, { type, ...message } as WebviewMessage)

beforeEach(() => {
	vi.clearAllMocks()
	workspaceMock.workspaceFolders = [{ uri: { fsPath: PROVIDER_CWD } }]
	mkdirMock.mockImplementation(async () => undefined)
	safeWriteJsonMock.mockImplementation(async () => undefined)
	fileExistsAtPathMock.mockImplementation(async () => false)
	openFileMock.mockImplementation(async () => undefined)
})

// ---------------------------------------------------------------------------

describe("mcpMessageHandlers", () => {
	describe("openMcpSettings", () => {
		it("McpHub があれば設定ファイルを開く", async () => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("openMcpSettings", h.provider)

			expect(openFileMock).toHaveBeenCalledExactlyOnceWith("/global/settings/mcp_settings.json")
			// 読み取り操作なのでファイル作成は起きない。
			expect(mkdirMock).not.toHaveBeenCalled()
			expect(safeWriteJsonMock).not.toHaveBeenCalled()
		})

		it("McpHub が未初期化なら何もしない", async () => {
			const h = setup()

			await call("openMcpSettings", h.provider)

			expect(openFileMock).not.toHaveBeenCalled()
		})

		it("設定ファイルのパスが取れなければ開かない", async () => {
			const hub = makeHub()
			hub.getMcpSettingsFilePath.mockResolvedValue("")
			const h = setup({ hub })

			await call("openMcpSettings", h.provider)

			expect(openFileMock).not.toHaveBeenCalled()
		})
	})

	describe("openProjectMcpSettings: 書き込み先（不変条件 3）", () => {
		it("mcp.json が無ければ <cwd>/.agent/mcp.json を作って開く", async () => {
			const h = setup()

			await call("openProjectMcpSettings", h.provider)

			expect(mkdirPaths()).toEqual([path.join(PROVIDER_CWD, ".agent")])
			expect(mkdirMock).toHaveBeenCalledExactlyOnceWith(path.join(PROVIDER_CWD, ".agent"), { recursive: true })
			expect(writePaths()).toEqual([path.join(PROVIDER_CWD, ".agent", "mcp.json")])
			expect(safeWriteJsonMock).toHaveBeenCalledExactlyOnceWith(
				path.join(PROVIDER_CWD, ".agent", "mcp.json"),
				{ mcpServers: {} },
				{ prettyPrint: true },
			)
			expect(openedPaths()).toEqual([path.join(PROVIDER_CWD, ".agent", "mcp.json")])
			expectAllPathsInsideAgentDir(PROVIDER_CWD)
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		// 既存ファイルを空の { mcpServers: {} } で潰すと、登録済みサーバー定義が失われる。
		it("mcp.json が既にあれば上書きせず開くだけ", async () => {
			const h = setup()
			fileExistsAtPathMock.mockResolvedValue(true)

			await call("openProjectMcpSettings", h.provider)

			expect(safeWriteJsonMock).not.toHaveBeenCalled()
			expect(openedPaths()).toEqual([path.join(PROVIDER_CWD, ".agent", "mcp.json")])
			expectAllPathsInsideAgentDir(PROVIDER_CWD)
		})

		it("実行中タスクがあればその cwd を基点にする", async () => {
			const taskCwd = "/workspace/other-repo"
			const h = setup({ currentTask: { cwd: taskCwd } })

			await call("openProjectMcpSettings", h.provider)

			expect(mkdirPaths()).toEqual([path.join(taskCwd, ".agent")])
			expect(writePaths()).toEqual([path.join(taskCwd, ".agent", "mcp.json")])
			expectAllPathsInsideAgentDir(taskCwd)
		})

		it("タスクの cwd が空なら provider の cwd を使う", async () => {
			const h = setup({ currentTask: { cwd: "" } })

			await call("openProjectMcpSettings", h.provider)

			expect(mkdirPaths()).toEqual([path.join(PROVIDER_CWD, ".agent")])
			expectAllPathsInsideAgentDir(PROVIDER_CWD)
		})

		// 【不変条件 3'】パスは cwd だけから決まる。webview 由来の値は一切混ざらない。
		it("メッセージにパスらしきフィールドを詰めても書き込み先は変わらない", async () => {
			const h = setup()

			await call("openProjectMcpSettings", h.provider, {
				text: "../../../../etc/mcp.json",
				serverName: "../../evil",
				setting: "/etc/passwd",
				values: { path: "/etc", mcpPath: "/etc/mcp.json" },
			} as Partial<WebviewMessage>)

			expect(mkdirPaths()).toEqual([path.join(PROVIDER_CWD, ".agent")])
			expect(writePaths()).toEqual([path.join(PROVIDER_CWD, ".agent", "mcp.json")])
			expect(openedPaths()).toEqual([path.join(PROVIDER_CWD, ".agent", "mcp.json")])
			expectAllPathsInsideAgentDir(PROVIDER_CWD)
			// ワークスペース外や別名のファイルには一切触れていない。
			for (const p of [...mkdirPaths(), ...writePaths(), ...openedPaths(), ...existsPaths()]) {
				expect(p.includes("..")).toBe(false)
				expect(p.startsWith("/etc")).toBe(false)
			}
		})

		it.each([
			["ワークスペース未オープン（undefined）", undefined],
			["ワークスペースが空配列", []],
		])("%s なら 1 バイトも書かずにエラー表示する", async (_label, folders) => {
			const h = setup()
			workspaceMock.workspaceFolders = folders

			await call("openProjectMcpSettings", h.provider)

			expect(mkdirMock).not.toHaveBeenCalled()
			expect(safeWriteJsonMock).not.toHaveBeenCalled()
			expect(openFileMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.no_workspace")
			// cwd の解決自体に到達しない。
			expect(h.getCurrentTask).not.toHaveBeenCalled()
		})

		it("mkdir が失敗したら書き込みへ進まずエラー表示する", async () => {
			const h = setup()
			mkdirMock.mockRejectedValue(new Error("EACCES: permission denied"))

			await call("openProjectMcpSettings", h.provider)

			expect(safeWriteJsonMock).not.toHaveBeenCalled()
			expect(openFileMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				'mcp:errors.create_json {"error":"Error: EACCES: permission denied"}',
			)
		})

		it("safeWriteJson が失敗したらファイルを開かずエラー表示する", async () => {
			const h = setup()
			safeWriteJsonMock.mockRejectedValue(new Error("ENOSPC"))

			await call("openProjectMcpSettings", h.provider)

			// 書き込み先は最後まで想定ディレクトリのまま。
			expect(writePaths()).toEqual([path.join(PROVIDER_CWD, ".agent", "mcp.json")])
			expectAllPathsInsideAgentDir(PROVIDER_CWD)
			expect(openFileMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				'mcp:errors.create_json {"error":"Error: ENOSPC"}',
			)
		})

		it("存在確認が失敗しても書き込みへ進まない", async () => {
			const h = setup()
			fileExistsAtPathMock.mockRejectedValue(new Error("stat failed"))

			await call("openProjectMcpSettings", h.provider)

			expect(safeWriteJsonMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				'mcp:errors.create_json {"error":"Error: stat failed"}',
			)
		})

		it("ファイルを開くのに失敗してもエラー表示に落ちる（例外を外へ出さない）", async () => {
			const h = setup()
			openFileMock.mockRejectedValue(new Error("open failed"))

			await expect(call("openProjectMcpSettings", h.provider)).resolves.toBeUndefined()

			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				'mcp:errors.create_json {"error":"Error: open failed"}',
			)
		})
	})

	describe("deleteMcpServer", () => {
		it("serverName が無ければ何もしない", async () => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("deleteMcpServer", h.provider, {})

			expect(hub.deleteServer).not.toHaveBeenCalled()
			expect(h.log).not.toHaveBeenCalled()
		})

		it("サーバー名と source を McpHub へ渡し、成功したら state を再送する", async () => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("deleteMcpServer", h.provider, { serverName: "srv", source: "project" })

			expect(hub.deleteServer).toHaveBeenCalledExactlyOnceWith("srv", "project")
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
			expect(h.log).toHaveBeenCalledTimes(2)
		})

		it("McpHub が未初期化でも落ちず、state だけ再送する", async () => {
			const h = setup()

			await expect(call("deleteMcpServer", h.provider, { serverName: "srv" })).resolves.toBeUndefined()

			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("削除が Error で失敗したら state を再送せずログだけ残す", async () => {
			const hub = makeHub()
			hub.deleteServer.mockRejectedValue(new Error("delete failed"))
			const h = setup({ hub })

			await call("deleteMcpServer", h.provider, { serverName: "srv" })

			expect(h.postStateToWebview).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledWith("Failed to delete MCP server: delete failed")
		})

		it("Error 以外が投げられても String 化して握り潰す", async () => {
			const hub = makeHub()
			hub.deleteServer.mockRejectedValue("string-failure")
			const h = setup({ hub })

			await call("deleteMcpServer", h.provider, { serverName: "srv" })

			expect(h.log).toHaveBeenCalledWith("Failed to delete MCP server: string-failure")
		})
	})

	describe("restartMcpServer", () => {
		it("再接続を委譲する", async () => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("restartMcpServer", h.provider, { text: "srv", source: "global" })

			expect(hub.restartConnection).toHaveBeenCalledExactlyOnceWith("srv", "global")
			expect(h.log).not.toHaveBeenCalled()
		})

		it("McpHub が未初期化でも落ちない", async () => {
			const h = setup()

			await expect(call("restartMcpServer", h.provider, { text: "srv" })).resolves.toBeUndefined()
		})

		it("失敗したらログだけ残して握り潰す", async () => {
			const hub = makeHub()
			hub.restartConnection.mockRejectedValue(new Error("restart failed"))
			const h = setup({ hub })

			await call("restartMcpServer", h.provider, { text: "srv" })

			expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("restart failed"))
		})
	})

	describe("toggleMcpServer", () => {
		it.each([true, false])("disabled=%s を委譲する", async (disabled) => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("toggleMcpServer", h.provider, { serverName: "srv", disabled, source: "project" })

			expect(hub.toggleServerDisabled).toHaveBeenCalledExactlyOnceWith("srv", disabled, "project")
		})

		it("McpHub が未初期化でも落ちない", async () => {
			const h = setup()

			await expect(
				call("toggleMcpServer", h.provider, { serverName: "srv", disabled: true }),
			).resolves.toBeUndefined()
		})

		it("失敗したらログだけ残して握り潰す", async () => {
			const hub = makeHub()
			hub.toggleServerDisabled.mockRejectedValue(new Error("toggle failed"))
			const h = setup({ hub })

			await call("toggleMcpServer", h.provider, { serverName: "srv", disabled: true })

			expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("toggle failed"))
		})
	})

	describe("refreshAllMcpServers", () => {
		it("McpHub があれば全接続を更新する", async () => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("refreshAllMcpServers", h.provider)

			expect(hub.refreshAllConnections).toHaveBeenCalledOnce()
		})

		it("McpHub が未初期化なら何もしない", async () => {
			const h = setup()

			await expect(call("refreshAllMcpServers", h.provider)).resolves.toBeUndefined()

			expect(h.getMcpHub).toHaveBeenCalledOnce()
		})

		// 【バグ】ここだけ try/catch が無いため、更新の失敗が呼び出し側まで抜ける
		// （mcpMessageHandlers.ts:100-106）。他のハンドラはすべて握り潰している。
		it("更新が失敗すると例外がそのまま外へ出る（他のハンドラと非対称）", async () => {
			const hub = makeHub()
			hub.refreshAllConnections.mockRejectedValue(new Error("refresh failed"))
			const h = setup({ hub })

			await expect(call("refreshAllMcpServers", h.provider)).rejects.toThrow("refresh failed")

			expect(h.log).not.toHaveBeenCalled()
		})
	})

	describe("toggleToolAlwaysAllow", () => {
		it.each([
			{ label: "true", alwaysAllow: true, expected: true },
			{ label: "false", alwaysAllow: false, expected: false },
			{ label: "未指定", alwaysAllow: undefined, expected: false },
		])("alwaysAllow=$label は $expected として委譲する", async ({ alwaysAllow, expected }) => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("toggleToolAlwaysAllow", h.provider, {
				serverName: "srv",
				source: "global",
				toolName: "tool",
				alwaysAllow,
			})

			expect(hub.toggleToolAlwaysAllow).toHaveBeenCalledExactlyOnceWith("srv", "global", "tool", expected)
		})

		it("McpHub が未初期化でも落ちない", async () => {
			const h = setup()

			await expect(
				call("toggleToolAlwaysAllow", h.provider, { serverName: "srv", toolName: "tool" }),
			).resolves.toBeUndefined()
		})

		it("失敗したらログだけ残して握り潰す", async () => {
			const hub = makeHub()
			hub.toggleToolAlwaysAllow.mockRejectedValue(new Error("always-allow failed"))
			const h = setup({ hub })

			await call("toggleToolAlwaysAllow", h.provider, { serverName: "srv", toolName: "tool", alwaysAllow: true })

			expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("always-allow failed"))
		})
	})

	describe("toggleToolEnabledForPrompt", () => {
		it.each([
			{ label: "true", isEnabled: true, expected: true },
			{ label: "false", isEnabled: false, expected: false },
			{ label: "未指定", isEnabled: undefined, expected: false },
		])("isEnabled=$label は $expected として委譲する", async ({ isEnabled, expected }) => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("toggleToolEnabledForPrompt", h.provider, {
				serverName: "srv",
				source: "project",
				toolName: "tool",
				isEnabled,
			})

			expect(hub.toggleToolEnabledForPrompt).toHaveBeenCalledExactlyOnceWith("srv", "project", "tool", expected)
		})

		it("McpHub が未初期化でも落ちない", async () => {
			const h = setup()

			await expect(
				call("toggleToolEnabledForPrompt", h.provider, { serverName: "srv", toolName: "tool" }),
			).resolves.toBeUndefined()
		})

		it("失敗したらログだけ残して握り潰す", async () => {
			const hub = makeHub()
			hub.toggleToolEnabledForPrompt.mockRejectedValue(new Error("enable failed"))
			const h = setup({ hub })

			await call("toggleToolEnabledForPrompt", h.provider, {
				serverName: "srv",
				toolName: "tool",
				isEnabled: true,
			})

			expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("enable failed"))
		})
	})

	describe("updateMcpTimeout", () => {
		it("サーバー名と数値の timeout が揃っていれば委譲する", async () => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("updateMcpTimeout", h.provider, { serverName: "srv", timeout: 60, source: "global" })

			expect(hub.updateServerTimeout).toHaveBeenCalledExactlyOnceWith("srv", 60, "global")
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it.each([
			["serverName が無い", { timeout: 60 }],
			["timeout が無い", { serverName: "srv" }],
			["timeout が数値でない", { serverName: "srv", timeout: "60" }],
			["両方無い", {}],
		])("%s なら委譲しない", async (_label, message) => {
			const hub = makeHub()
			const h = setup({ hub })

			await call("updateMcpTimeout", h.provider, message as Partial<WebviewMessage>)

			expect(hub.updateServerTimeout).not.toHaveBeenCalled()
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it("McpHub が未初期化でも落ちない", async () => {
			const h = setup()

			await expect(
				call("updateMcpTimeout", h.provider, { serverName: "srv", timeout: 60 }),
			).resolves.toBeUndefined()

			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it("失敗したらログとエラー表示に落ちる", async () => {
			const hub = makeHub()
			hub.updateServerTimeout.mockRejectedValue(new Error("timeout update failed"))
			const h = setup({ hub })

			await call("updateMcpTimeout", h.provider, { serverName: "srv", timeout: 60 })

			expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("timeout update failed"))
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.update_server_timeout")
		})
	})
})
