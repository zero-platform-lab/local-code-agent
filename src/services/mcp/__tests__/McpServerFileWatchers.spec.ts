import chokidar from "chokidar"

import { describe, it, expect, vi, beforeEach } from "vitest"

import { McpServerFileWatchers, resolveWatchTargets } from "../McpServerFileWatchers"
import type { ServerConfig } from "../serverConfigSchema"

vi.mock("chokidar", () => ({
	default: { watch: vi.fn() },
}))

const config = (overrides: Record<string, unknown>): ServerConfig =>
	({ timeout: 60, alwaysAllow: [], disabledTools: [], ...overrides }) as unknown as ServerConfig

const stdio = (overrides: Record<string, unknown> = {}) =>
	config({ type: "stdio", command: "node", args: [], cwd: "/w", ...overrides })

const makeWatcher = () => {
	const handlers: Record<string, (p: string) => unknown> = {}
	return {
		on: vi.fn((event: string, cb: (p: string) => unknown) => {
			handlers[event] = cb
			return this
		}),
		close: vi.fn(),
		fire: (path: string) => handlers.change?.(path),
	}
}

describe("resolveWatchTargets", () => {
	it("stdio 以外は監視しない（ローカルファイルを持たない）", () => {
		expect(resolveWatchTargets(config({ type: "sse", url: "https://x.test" }))).toEqual({ watchPaths: [] })
		expect(resolveWatchTargets(config({ type: "streamable-http", url: "https://x.test" }))).toEqual({
			watchPaths: [],
		})
	})

	it("設定された watchPaths をそのまま返す", () => {
		expect(resolveWatchTargets(stdio({ watchPaths: ["/a", "/b"] })).watchPaths).toEqual(["/a", "/b"])
	})

	it("空の watchPaths は監視対象にしない", () => {
		expect(resolveWatchTargets(stdio({ watchPaths: [] })).watchPaths).toEqual([])
	})

	it("args から build/index.js を拾う", () => {
		expect(resolveWatchTargets(stdio({ args: ["--x", "/srv/build/index.js"] })).buildArtifact).toBe(
			"/srv/build/index.js",
		)
	})

	it("build/index.js を含まない args では拾わない", () => {
		expect(resolveWatchTargets(stdio({ args: ["/srv/dist/main.js"] })).buildArtifact).toBeUndefined()
	})

	it("watchPaths と build 成果物は併存できる", () => {
		const targets = resolveWatchTargets(stdio({ watchPaths: ["/a"], args: ["/srv/build/index.js"] }))

		expect(targets).toEqual({ watchPaths: ["/a"], buildArtifact: "/srv/build/index.js" })
	})
})

describe("McpServerFileWatchers", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("watchPaths は 1 つの watcher にまとめて渡す（配列のまま）", () => {
		vi.mocked(chokidar.watch).mockReturnValue(makeWatcher() as never)
		const watchers = new McpServerFileWatchers()

		watchers.watch("srv", stdio({ watchPaths: ["/a", "/b"] }), vi.fn())

		expect(chokidar.watch).toHaveBeenCalledTimes(1)
		expect(chokidar.watch).toHaveBeenCalledWith(["/a", "/b"], expect.any(Object))
	})

	it("watchPaths と build 成果物は別々の watcher になる", () => {
		vi.mocked(chokidar.watch).mockReturnValue(makeWatcher() as never)
		const watchers = new McpServerFileWatchers()

		watchers.watch("srv", stdio({ watchPaths: ["/a"], args: ["/srv/build/index.js"] }), vi.fn())

		expect(chokidar.watch).toHaveBeenCalledTimes(2)
		expect(chokidar.watch).toHaveBeenNthCalledWith(1, ["/a"], expect.any(Object))
		expect(chokidar.watch).toHaveBeenNthCalledWith(2, "/srv/build/index.js", expect.any(Object))
	})

	it("監視対象が無ければ watcher を作らず登録もしない", () => {
		const watchers = new McpServerFileWatchers()

		watchers.watch("srv", stdio(), vi.fn())

		expect(chokidar.watch).not.toHaveBeenCalled()
		expect(watchers.size).toBe(0)
	})

	it("変更を検知したらハンドラを呼ぶ", async () => {
		const watcher = makeWatcher()
		vi.mocked(chokidar.watch).mockReturnValue(watcher as never)
		const onChange = vi.fn().mockResolvedValue(undefined)
		const watchers = new McpServerFileWatchers()

		watchers.watch("srv", stdio({ watchPaths: ["/a"] }), onChange)
		await watcher.fire("/a/changed.ts")

		expect(onChange).toHaveBeenCalledWith("/a/changed.ts")
	})

	it("ハンドラが失敗しても throw せず監視を続ける", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const watcher = makeWatcher()
		vi.mocked(chokidar.watch).mockReturnValue(watcher as never)
		const watchers = new McpServerFileWatchers()

		watchers.watch("srv", stdio({ watchPaths: ["/a"] }), vi.fn().mockRejectedValue(new Error("restart failed")))
		await watcher.fire("/a/changed.ts")

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to restart server srv"),
			expect.any(Error),
		)
		consoleErrorSpy.mockRestore()
	})

	it("removeFor は該当サーバの watcher だけ閉じる", () => {
		const a = makeWatcher()
		const b = makeWatcher()
		vi.mocked(chokidar.watch)
			.mockReturnValueOnce(a as never)
			.mockReturnValueOnce(b as never)
		const watchers = new McpServerFileWatchers()

		watchers.watch("a", stdio({ watchPaths: ["/a"] }), vi.fn())
		watchers.watch("b", stdio({ watchPaths: ["/b"] }), vi.fn())

		watchers.removeFor("a")

		expect(a.close).toHaveBeenCalled()
		expect(b.close).not.toHaveBeenCalled()
		expect(watchers.size).toBe(1)
	})

	it("removeFor は未登録のサーバでも壊れない", () => {
		const watchers = new McpServerFileWatchers()

		expect(() => watchers.removeFor("unknown")).not.toThrow()
	})

	it("removeAll は全ての watcher を閉じる", () => {
		const a = makeWatcher()
		const b = makeWatcher()
		vi.mocked(chokidar.watch)
			.mockReturnValueOnce(a as never)
			.mockReturnValueOnce(b as never)
		const watchers = new McpServerFileWatchers()

		watchers.watch("a", stdio({ watchPaths: ["/a"] }), vi.fn())
		watchers.watch("b", stdio({ watchPaths: ["/b"] }), vi.fn())

		watchers.removeAll()

		expect(a.close).toHaveBeenCalled()
		expect(b.close).toHaveBeenCalled()
		expect(watchers.size).toBe(0)
	})

	it("同じサーバを 2 回 watch すると watcher が積み上がる（再購読時は先に removeFor する前提）", () => {
		vi.mocked(chokidar.watch).mockReturnValue(makeWatcher() as never)
		const watchers = new McpServerFileWatchers()

		watchers.watch("srv", stdio({ watchPaths: ["/a"] }), vi.fn())
		watchers.watch("srv", stdio({ watchPaths: ["/a"] }), vi.fn())

		expect(chokidar.watch).toHaveBeenCalledTimes(2)
		expect(watchers.size).toBe(1)
	})
})
