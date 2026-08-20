import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ServerConfig } from "../serverConfigSchema"
import {
	createMcpTransport,
	isInfoLevelStderr,
	resolveStdioCommand,
	type McpTransportHandlers,
} from "../mcpTransportFactory"

const makeTransportStub = () => ({
	start: vi.fn().mockResolvedValue(undefined),
	stderr: { on: vi.fn() },
	onerror: undefined as ((error: unknown) => void) | undefined,
	onclose: undefined as (() => void) | undefined,
})

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn(),
	getDefaultEnvironment: vi.fn().mockReturnValue({ BASE: "1" }),
}))

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: vi.fn(),
}))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn(),
}))

vi.mock("reconnecting-eventsource", () => ({ default: class FakeEventSource {} }))

/** schema の必須フィールド（timeout / alwaysAllow / disabledTools）を埋めた設定を作る。 */
const config = (overrides: Record<string, unknown>): ServerConfig =>
	({
		timeout: 60,
		alwaysAllow: [],
		disabledTools: [],
		...overrides,
	}) as unknown as ServerConfig

const stdioConfig = (overrides: Record<string, unknown> = {}) =>
	config({ type: "stdio", command: "npx", args: ["server"], cwd: "/work", ...overrides })

const handlers = (): McpTransportHandlers => ({
	onDisconnected: vi.fn(),
	onStderr: vi.fn(),
})

describe("resolveStdioCommand", () => {
	it("非 Windows では素通し", () => {
		expect(resolveStdioCommand("npx", ["a"], "linux")).toEqual({ command: "npx", args: ["a"] })
	})

	it("Windows では cmd.exe /c で包む", () => {
		expect(resolveStdioCommand("npx", ["a"], "win32")).toEqual({
			command: "cmd.exe",
			args: ["/c", "npx", "a"],
		})
	})

	it("Windows で args が無くても包める", () => {
		expect(resolveStdioCommand("npx", undefined, "win32")).toEqual({
			command: "cmd.exe",
			args: ["/c", "npx"],
		})
	})

	it("既に cmd / cmd.exe なら二重に包まない（大文字小文字を問わず）", () => {
		expect(resolveStdioCommand("cmd.exe", ["/c", "x"], "win32")).toEqual({
			command: "cmd.exe",
			args: ["/c", "x"],
		})
		expect(resolveStdioCommand("CMD", ["/c", "x"], "win32")).toEqual({ command: "CMD", args: ["/c", "x"] })
	})
})

describe("isInfoLevelStderr", () => {
	it("INFO を含む行は情報ログ扱い（大文字小文字を問わず）", () => {
		expect(isInfoLevelStderr("2024 INFO server ready")).toBe(true)
		expect(isInfoLevelStderr("info: listening")).toBe(true)
	})

	it("それ以外はエラー扱い", () => {
		expect(isInfoLevelStderr("Error: EADDRINUSE")).toBe(false)
	})
})

describe("createMcpTransport", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("stdio は既定環境変数に設定の env を重ねて起動する", async () => {
		const stub = makeTransportStub()
		vi.mocked(StdioClientTransport).mockReturnValue(stub as never)

		await createMcpTransport("srv", stdioConfig({ env: { EXTRA: "2" } }), handlers(), "linux")

		expect(StdioClientTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "npx",
				args: ["server"],
				cwd: "/work",
				env: { BASE: "1", EXTRA: "2" },
				stderr: "pipe",
			}),
		)
	})

	it("stdio は connect 前に自分で起動し、start を no-op に差し替える", async () => {
		const stub = makeTransportStub()
		vi.mocked(StdioClientTransport).mockReturnValue(stub as never)

		// factory が transport.start を差し替えるので、spy の参照を先に押さえておく
		const originalStart = stub.start
		const transport = await createMcpTransport("srv", stdioConfig(), handlers(), "linux")

		expect(originalStart).toHaveBeenCalledTimes(1)
		expect(transport.start).not.toBe(originalStart)

		// 差し替え後の start は何もしない（client.connect が二重起動しないように）
		await transport.start()
		expect(originalStart).toHaveBeenCalledTimes(1)
	})

	it("stderr のチャンクを INFO 判定つきでハンドラに渡す", async () => {
		const stub = makeTransportStub()
		vi.mocked(StdioClientTransport).mockReturnValue(stub as never)
		const h = handlers()

		await createMcpTransport("srv", stdioConfig(), h, "linux")

		const onData = stub.stderr.on.mock.calls.find(([event]) => event === "data")?.[1] as (b: Buffer) => void
		await onData(Buffer.from("INFO ready"))
		await onData(Buffer.from("boom"))

		expect(h.onStderr).toHaveBeenCalledWith("INFO ready", true)
		expect(h.onStderr).toHaveBeenCalledWith("boom", false)
	})

	it("stderr ストリームが無くても throw しない", async () => {
		vi.mocked(StdioClientTransport).mockReturnValue({ ...makeTransportStub(), stderr: null } as never)

		await expect(createMcpTransport("srv", stdioConfig(), handlers(), "linux")).resolves.toBeDefined()
	})

	it("onerror はメッセージつきで、onclose はメッセージ無しで切断を通知する", async () => {
		const stub = makeTransportStub()
		vi.mocked(StdioClientTransport).mockReturnValue(stub as never)
		const h = handlers()

		await createMcpTransport("srv", stdioConfig(), h, "linux")

		await stub.onerror!(new Error("kaboom"))
		expect(h.onDisconnected).toHaveBeenCalledWith("kaboom")

		await stub.onclose!()
		expect(h.onDisconnected).toHaveBeenCalledWith()
	})

	it("Error でない値も文字列化して通知する", async () => {
		const stub = makeTransportStub()
		vi.mocked(StdioClientTransport).mockReturnValue(stub as never)
		const h = handlers()

		await createMcpTransport("srv", stdioConfig(), h, "linux")
		await stub.onerror!("plain string")

		expect(h.onDisconnected).toHaveBeenCalledWith("plain string")
	})

	it("streamable-http は URL とヘッダを渡す", async () => {
		const stub = makeTransportStub()
		vi.mocked(StreamableHTTPClientTransport).mockReturnValue(stub as never)

		await createMcpTransport(
			"srv",
			config({ type: "streamable-http", url: "https://example.test/mcp", headers: { A: "1" } }),
			handlers(),
			"linux",
		)

		expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
			new URL("https://example.test/mcp"),
			expect.objectContaining({ requestInit: { headers: { A: "1" } } }),
		)
	})

	it("sse は Authorization ヘッダがあるときだけ credentials を有効にする", async () => {
		const stub = makeTransportStub()
		vi.mocked(SSEClientTransport).mockReturnValue(stub as never)

		await createMcpTransport(
			"srv",
			config({ type: "sse", url: "https://example.test/sse", headers: { Authorization: "Bearer x" } }),
			handlers(),
			"linux",
		)
		expect(vi.mocked(SSEClientTransport).mock.calls[0][1]).toMatchObject({
			eventSourceInit: { withCredentials: true },
		})

		await createMcpTransport("srv", config({ type: "sse", url: "https://example.test/sse" }), handlers(), "linux")
		expect(vi.mocked(SSEClientTransport).mock.calls[1][1]).toMatchObject({
			eventSourceInit: { withCredentials: false },
		})
	})

	it("sse の fetch ラッパは設定ヘッダを init ヘッダに重ねて global fetch へ委譲する", async () => {
		const stub = makeTransportStub()
		vi.mocked(SSEClientTransport).mockReturnValue(stub as never)

		const originalFetch = global.fetch
		const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response)
		global.fetch = fetchMock as never

		try {
			await createMcpTransport(
				"srv",
				config({
					type: "sse",
					url: "https://example.test/sse",
					headers: { Authorization: "Bearer x", X: "1" },
				}),
				handlers(),
				"linux",
			)

			const wrappedFetch = (vi.mocked(SSEClientTransport).mock.calls[0][1] as any).eventSourceInit.fetch as (
				url: string,
				init: RequestInit,
			) => Promise<Response>

			// init 側のヘッダに設定ヘッダを重ねる（同名キーは設定が勝つ）。
			await wrappedFetch("https://example.test/sse", { method: "GET", headers: { Y: "2", X: "overridden" } })

			expect(fetchMock).toHaveBeenCalledTimes(1)
			const [calledUrl, calledInit] = fetchMock.mock.calls[0]
			expect(calledUrl).toBe("https://example.test/sse")
			const headers = calledInit.headers as Headers
			expect(headers.get("Authorization")).toBe("Bearer x")
			expect(headers.get("Y")).toBe("2")
			expect(headers.get("X")).toBe("1") // 設定ヘッダが init を上書きする

			// init 自体が無い分岐（init?.headers の nullish 側 / ...init が空）も通す。
			await wrappedFetch("https://example.test/sse", undefined as never)
			expect((fetchMock.mock.calls[1][1].headers as Headers).get("X")).toBe("1")
		} finally {
			global.fetch = originalFetch
		}
	})

	it("sse で設定ヘッダが無い場合でも fetch ラッパは動く（config.headers || {} の既定側）", async () => {
		const stub = makeTransportStub()
		vi.mocked(SSEClientTransport).mockReturnValue(stub as never)

		const originalFetch = global.fetch
		const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response)
		global.fetch = fetchMock as never

		try {
			await createMcpTransport(
				"srv",
				config({ type: "sse", url: "https://example.test/sse" }),
				handlers(),
				"linux",
			)

			const wrappedFetch = (vi.mocked(SSEClientTransport).mock.calls[0][1] as any).eventSourceInit.fetch as (
				url: string,
				init: RequestInit,
			) => Promise<Response>

			await wrappedFetch("https://example.test/sse", { headers: { Y: "2" } })

			expect((fetchMock.mock.calls[0][1].headers as Headers).get("Y")).toBe("2")
		} finally {
			global.fetch = originalFetch
		}
	})

	it("未知の type は throw する", async () => {
		await expect(
			createMcpTransport("srv", { type: "carrier-pigeon" } as unknown as ServerConfig, handlers(), "linux"),
		).rejects.toThrow("Unsupported MCP server type: carrier-pigeon")
	})
})
