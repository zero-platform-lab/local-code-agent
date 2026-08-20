import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"

import { McpConfigWatcher, type McpConfigWatchHost } from "../McpConfigWatcher"

type UriHandler = (uri: { fsPath: string }) => void

type FakeWatcher = {
	onDidChange: (cb: UriHandler) => { dispose: () => void }
	onDidCreate: (cb: UriHandler) => { dispose: () => void }
	onDidDelete: (cb: () => void) => { dispose: () => void }
	dispose: ReturnType<typeof vi.fn>
	handlers: { change?: UriHandler; create?: UriHandler; delete?: () => void }
}

const h = vi.hoisted(() => {
	const state: {
		watchers: FakeWatcher[]
		workspaceFolders: unknown[]
		onWorkspaceFoldersChange?: () => Promise<void> | void
	} = { watchers: [], workspaceFolders: [{ uri: { fsPath: "/ws" } }] }

	const makeFakeWatcher = (): FakeWatcher => {
		const w: FakeWatcher = {
			handlers: {},
			onDidChange: (cb) => {
				w.handlers.change = cb
				return { dispose: vi.fn() }
			},
			onDidCreate: (cb) => {
				w.handlers.create = cb
				return { dispose: vi.fn() }
			},
			onDidDelete: (cb) => {
				w.handlers.delete = cb
				return { dispose: vi.fn() }
			},
			dispose: vi.fn(),
		}
		return w
	}

	return { state, makeFakeWatcher }
})

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(() => {
			const w = h.makeFakeWatcher()
			h.state.watchers.push(w)
			return w
		}),
		onDidChangeWorkspaceFolders: vi.fn((cb: () => Promise<void> | void) => {
			h.state.onWorkspaceFoldersChange = cb
			return { dispose: vi.fn() }
		}),
		get workspaceFolders() {
			return h.state.workspaceFolders
		},
	},
	RelativePattern: vi.fn((base: string, pattern: string) => ({ base, pattern })),
	Disposable: {
		from: (...ds: Array<{ dispose?: () => void }>) => ({ dispose: () => ds.forEach((d) => d?.dispose?.()) }),
	},
}))

vi.mock("../../../utils/path", () => ({
	arePathsEqual: (a: string, b: string) => a === b,
	getWorkspacePath: () => "/ws",
}))

const SETTINGS_PATH = "/settings/mcp_settings.json"

function makeHost(overrides: Partial<McpConfigWatchHost> = {}): McpConfigWatchHost {
	return {
		getGlobalSettingsPath: vi.fn().mockResolvedValue(SETTINGS_PATH),
		getProjectCwd: vi.fn().mockReturnValue("/ws"),
		isProgrammaticWrite: vi.fn().mockReturnValue(false),
		reloadConfig: vi.fn().mockResolvedValue(undefined),
		reloadProjectConfig: vi.fn().mockResolvedValue(undefined),
		handleProjectConfigDeleted: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}
}

beforeEach(() => {
	h.state.watchers = []
	h.state.workspaceFolders = [{ uri: { fsPath: "/ws" } }]
	h.state.onWorkspaceFoldersChange = undefined
	vi.clearAllMocks()
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("start", () => {
	it("global / project / workspace の 3 監視を張る（fire-and-forget）", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)

		watcher.start()
		// start 内の watchGlobalSettings は void の非同期。マイクロタスクを流して確定させる。
		await Promise.resolve()
		await Promise.resolve()

		// global + project の 2 つの watcher が張られ、workspace 監視も登録される。
		expect(h.state.watchers.length).toBe(2)
		expect(h.state.onWorkspaceFoldersChange).toBeDefined()
	})
})

describe("watchGlobalSettings", () => {
	it("createFileSystemWatcher が無い環境では何もしない", async () => {
		const original = vscode.workspace.createFileSystemWatcher
		;(vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = undefined
		try {
			const host = makeHost()
			const watcher = new McpConfigWatcher(host)
			await watcher.watchGlobalSettings()

			// ガードで早期 return するので path 解決すら走らない。
			expect(host.getGlobalSettingsPath).not.toHaveBeenCalled()
			expect(h.state.watchers).toHaveLength(0)
		} finally {
			;(vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = original
		}
	})

	it("2 回張ると前回の settingsWatcher を破棄してから作り直す", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchGlobalSettings()
		const first = h.state.watchers[0]

		await watcher.watchGlobalSettings()

		expect(first.dispose).toHaveBeenCalled()
		expect(h.state.watchers).toHaveLength(2)
	})

	it("設定ファイルの作成イベントも 500ms デバウンスして reloadConfig を呼ぶ", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchGlobalSettings()

		h.state.watchers[0].handlers.create?.({ fsPath: SETTINGS_PATH })
		await vi.advanceTimersByTimeAsync(500)

		expect(host.reloadConfig).toHaveBeenCalledWith(SETTINGS_PATH, "global")
	})

	it("設定ファイルの変更を 500ms デバウンスして reloadConfig を呼ぶ", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchGlobalSettings()

		h.state.watchers[0].handlers.change?.({ fsPath: SETTINGS_PATH })
		expect(host.reloadConfig).not.toHaveBeenCalled() // まだデバウンス中

		await vi.advanceTimersByTimeAsync(500)
		expect(host.reloadConfig).toHaveBeenCalledWith(SETTINGS_PATH, "global")
	})

	it("設定ファイル以外のパス変更は無視する", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchGlobalSettings()

		h.state.watchers[0].handlers.change?.({ fsPath: "/settings/other.json" })
		await vi.advanceTimersByTimeAsync(500)

		expect(host.reloadConfig).not.toHaveBeenCalled()
	})

	it("連続変更はデバウンスで 1 回にまとめる", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchGlobalSettings()

		h.state.watchers[0].handlers.change?.({ fsPath: SETTINGS_PATH })
		await vi.advanceTimersByTimeAsync(200)
		h.state.watchers[0].handlers.change?.({ fsPath: SETTINGS_PATH })
		await vi.advanceTimersByTimeAsync(500)

		expect(host.reloadConfig).toHaveBeenCalledTimes(1)
	})

	it("拡張自身の書き込み中は再取り込みしない", async () => {
		const host = makeHost({ isProgrammaticWrite: vi.fn().mockReturnValue(true) })
		const watcher = new McpConfigWatcher(host)
		await watcher.watchGlobalSettings()

		h.state.watchers[0].handlers.change?.({ fsPath: SETTINGS_PATH })
		await vi.advanceTimersByTimeAsync(500)

		expect(host.reloadConfig).not.toHaveBeenCalled()
	})
})

describe("watchProjectFile", () => {
	it("削除イベントで handleProjectConfigDeleted を呼ぶ", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchProjectFile()

		await h.state.watchers[0].handlers.delete?.()
		expect(host.handleProjectConfigDeleted).toHaveBeenCalledTimes(1)
	})

	it("ワークスペースフォルダが無ければ watcher を作らない", async () => {
		h.state.workspaceFolders = []
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchProjectFile()

		expect(h.state.watchers).toHaveLength(0)
	})

	it("createFileSystemWatcher が無い環境では何もしない", async () => {
		const original = vscode.workspace.createFileSystemWatcher
		;(vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = undefined
		try {
			const host = makeHost()
			const watcher = new McpConfigWatcher(host)
			await watcher.watchProjectFile()

			expect(h.state.watchers).toHaveLength(0)
		} finally {
			;(vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = original
		}
	})

	it("2 回張ると前回の projectMcpWatcher を破棄してから作り直す", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchProjectFile()
		const first = h.state.watchers[0]

		await watcher.watchProjectFile()

		expect(first.dispose).toHaveBeenCalled()
		expect(h.state.watchers).toHaveLength(2)
	})

	it("変更 / 作成イベントは project ソースで debounce reloadConfig を呼ぶ", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchProjectFile()

		h.state.watchers[0].handlers.change?.({ fsPath: "/ws/.agent/mcp.json" })
		await vi.advanceTimersByTimeAsync(500)
		expect(host.reloadConfig).toHaveBeenLastCalledWith("/ws/.agent/mcp.json", "project")

		h.state.watchers[0].handlers.create?.({ fsPath: "/ws/.agent/mcp.json" })
		await vi.advanceTimersByTimeAsync(500)
		expect(host.reloadConfig).toHaveBeenCalledTimes(2)
	})
})

describe("watchWorkspaceFolders", () => {
	it("フォルダ変更で project 設定を読み直し、project watcher を張り直す", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		watcher.watchWorkspaceFolders()

		await h.state.onWorkspaceFoldersChange?.()

		expect(host.reloadProjectConfig).toHaveBeenCalledTimes(1)
		expect(h.state.watchers).toHaveLength(1) // 張り直した project watcher
	})
})

describe("dispose", () => {
	it("保留中のデバウンスを止め、watcher を破棄する", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchGlobalSettings()
		const created = h.state.watchers[0]

		// デバウンスを予約 → 発火前に dispose
		created.handlers.change?.({ fsPath: SETTINGS_PATH })
		watcher.dispose()
		await vi.advanceTimersByTimeAsync(500)

		expect(host.reloadConfig).not.toHaveBeenCalled()
		expect(created.dispose).toHaveBeenCalled()
	})

	it("project watcher も破棄する", async () => {
		const host = makeHost()
		const watcher = new McpConfigWatcher(host)
		await watcher.watchProjectFile()
		const projectWatcher = h.state.watchers[0]

		watcher.dispose()

		expect(projectWatcher.dispose).toHaveBeenCalled()
	})
})
