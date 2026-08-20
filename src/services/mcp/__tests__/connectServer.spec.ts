import { describe, it, expect, vi, beforeEach } from "vitest"

import type { McpServer } from "@openai-agent/types"

import {
	createConnectedConnection,
	createPlaceholderConnection,
	makeConnectionTransportHandlers,
	recordConnectionFailure,
	resolveConnectPlan,
	type ConnectionLookup,
} from "../connectServer"
import { DisableReason, type McpConnection } from "../mcpConnection"
import type { ServerConfig } from "../serverConfigSchema"

const config = (overrides: Record<string, unknown> = {}): ServerConfig =>
	({
		type: "stdio",
		command: "node",
		args: ["s.js"],
		cwd: "/w",
		timeout: 60,
		alwaysAllow: [],
		disabledTools: [],
		...overrides,
	}) as unknown as ServerConfig

describe("resolveConnectPlan", () => {
	it("MCP 全体が無効なら、サーバが有効でも接続しない", () => {
		expect(resolveConnectPlan(false, undefined)).toBe("mcp-disabled")
		expect(resolveConnectPlan(false, false)).toBe("mcp-disabled")
	})

	it("全体が無効なら、サーバ個別の無効化より優先される", () => {
		expect(resolveConnectPlan(false, true)).toBe("mcp-disabled")
	})

	it("サーバ個別の無効化を尊重する", () => {
		expect(resolveConnectPlan(true, true)).toBe("server-disabled")
	})

	it("どちらも無効でなければ接続する", () => {
		expect(resolveConnectPlan(true, false)).toBe("connect")
		expect(resolveConnectPlan(true, undefined)).toBe("connect")
	})
})

describe("createPlaceholderConnection", () => {
	it("接続を張らない形（client/transport が null）で作る", () => {
		const conn = createPlaceholderConnection({
			name: "srv",
			config: config(),
			source: "global",
			reason: DisableReason.SERVER_DISABLED,
			projectPath: undefined,
		})

		expect(conn.type).toBe("disconnected")
		expect(conn.client).toBeNull()
		expect(conn.transport).toBeNull()
		expect(conn.server.status).toBe("disconnected")
	})

	it("サーバ個別の無効化では disabled を true に固定する", () => {
		const conn = createPlaceholderConnection({
			name: "srv",
			config: config({ disabled: false }),
			source: "global",
			reason: DisableReason.SERVER_DISABLED,
			projectPath: undefined,
		})

		expect(conn.server.disabled).toBe(true)
	})

	it("MCP 全体の無効化では設定値をそのまま残す（再有効化で元に戻すため）", () => {
		const enabled = createPlaceholderConnection({
			name: "srv",
			config: config({ disabled: false }),
			source: "global",
			reason: DisableReason.MCP_DISABLED,
			projectPath: undefined,
		})
		const disabled = createPlaceholderConnection({
			name: "srv",
			config: config({ disabled: true }),
			source: "global",
			reason: DisableReason.MCP_DISABLED,
			projectPath: undefined,
		})

		expect(enabled.server.disabled).toBe(false)
		expect(disabled.server.disabled).toBe(true)
	})

	it("変更検知の基準として declaredConfig を持つ", () => {
		const declared = config()
		const conn = createPlaceholderConnection({
			name: "srv",
			config: declared,
			source: "project",
			reason: DisableReason.SERVER_DISABLED,
			projectPath: "/ws",
		})

		expect(conn.declaredConfig).toBe(declared)
		expect(conn.server.projectPath).toBe("/ws")
	})
})

describe("createConnectedConnection", () => {
	const client = { id: "client" } as never
	const transport = { id: "transport" } as never

	it("status は connecting から始まる（connect 成功後に呼び出し側が進める）", () => {
		const conn = createConnectedConnection({
			name: "srv",
			declaredConfig: config(),
			source: "global",
			projectPath: undefined,
			client,
			transport,
		})

		expect(conn.server.status).toBe("connecting")
		expect(conn.type).toBe("connected")
	})

	it("server.config は展開前の宣言を載せる（webview に送られるのでシークレットを含めない）", () => {
		const declared = config({ env: { TOKEN: "${env:SECRET}" } })

		const conn = createConnectedConnection({
			name: "srv",
			declaredConfig: declared,
			source: "global",
			projectPath: undefined,
			client,
			transport,
		})

		expect(conn.declaredConfig).toBe(declared)
		expect(JSON.parse(conn.server.config).env).toEqual({ TOKEN: "${env:SECRET}" })
	})

	it("client と transport をそのまま保持する", () => {
		const conn = createConnectedConnection({
			name: "srv",
			declaredConfig: config(),
			source: "global",
			projectPath: undefined,
			client,
			transport,
		})

		expect(conn.client).toBe(client)
		expect(conn.transport).toBe(transport)
	})
})

/** 名前で引ける最小の store スタブ。 */
const lookupOf = (...connections: McpConnection[]): ConnectionLookup => ({
	find: (name, source) =>
		connections.find((c) => c.server.name === name && (source === undefined || c.server.source === source)),
})

const connectionFor = (name: string, status: McpServer["status"]): McpConnection =>
	({
		type: "connected",
		declaredConfig: config(),
		server: { name, config: "{}", status, source: "global", errorHistory: [] },
		client: null,
		transport: null,
	}) as unknown as McpConnection

describe("makeConnectionTransportHandlers", () => {
	let notify: ReturnType<typeof vi.fn>

	beforeEach(() => {
		notify = vi.fn().mockResolvedValue(undefined)
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "log").mockImplementation(() => {})
	})

	it("onDisconnected はエラー付きなら切断状態にして履歴に残す", async () => {
		const conn = connectionFor("srv", "connected")
		const handlers = makeConnectionTransportHandlers({
			connections: lookupOf(conn),
			notify,
			serverName: "srv",
			source: "global",
		})

		await handlers.onDisconnected("kaboom")

		expect(conn.server.status).toBe("disconnected")
		expect(conn.server.error).toBe("kaboom")
		expect(notify).toHaveBeenCalled()
	})

	it("onDisconnected はメッセージ無し（正常クローズ）ならエラー履歴を汚さない", async () => {
		const conn = connectionFor("srv", "connected")
		const handlers = makeConnectionTransportHandlers({
			connections: lookupOf(conn),
			notify,
			serverName: "srv",
			source: "global",
		})

		await handlers.onDisconnected()

		expect(conn.server.status).toBe("disconnected")
		expect(conn.server.errorHistory).toEqual([])
		expect(notify).toHaveBeenCalled()
	})

	it("接続が見つからなくても webview には通知する", async () => {
		const handlers = makeConnectionTransportHandlers({
			connections: lookupOf(),
			notify,
			serverName: "gone",
			source: "global",
		})

		await expect(handlers.onDisconnected("x")).resolves.toBeUndefined()
		expect(notify).toHaveBeenCalled()
	})

	it("接続オブジェクトを閉じ込めず、発火時に名前で引き直す（再接続後の幽霊更新を防ぐ）", async () => {
		const oldConn = connectionFor("srv", "connected")
		const newConn = connectionFor("srv", "connected")

		// ハンドラ生成時点の接続は oldConn。以降 store が newConn に差し替わる。
		let current = oldConn
		const handlers = makeConnectionTransportHandlers({
			connections: { find: () => current },
			notify,
			serverName: "srv",
			source: "global",
		})

		current = newConn
		await handlers.onDisconnected("late failure")

		expect(newConn.server.status).toBe("disconnected")
		expect(oldConn.server.status).toBe("connected")
	})

	it("onStderr の INFO 行はログのみで状態を触らない", async () => {
		const conn = connectionFor("srv", "connected")
		const handlers = makeConnectionTransportHandlers({
			connections: lookupOf(conn),
			notify,
			serverName: "srv",
			source: "global",
		})

		await handlers.onStderr("INFO ready", true)

		expect(conn.server.errorHistory).toEqual([])
		expect(notify).not.toHaveBeenCalled()
	})

	it("onStderr のエラー行は履歴に残すが、接続中は通知しない", async () => {
		const conn = connectionFor("srv", "connecting")
		const handlers = makeConnectionTransportHandlers({
			connections: lookupOf(conn),
			notify,
			serverName: "srv",
			source: "global",
		})

		await handlers.onStderr("boom", false)

		expect(conn.server.errorHistory).toHaveLength(1)
		expect(notify).not.toHaveBeenCalled()
	})

	it("既に切断済みのときだけ stderr で通知する", async () => {
		const conn = connectionFor("srv", "disconnected")
		const handlers = makeConnectionTransportHandlers({
			connections: lookupOf(conn),
			notify,
			serverName: "srv",
			source: "global",
		})

		await handlers.onStderr("boom", false)

		expect(notify).toHaveBeenCalled()
	})
})

describe("recordConnectionFailure", () => {
	it("store にレコードがあれば切断状態とエラーを残す", () => {
		const conn = connectionFor("srv", "connecting")

		recordConnectionFailure(lookupOf(conn), "srv", "global", new Error("boom"))

		expect(conn.server.status).toBe("disconnected")
		expect(conn.server.error).toBe("boom")
	})

	it("レコードがまだ無ければ何も残さない（transport 生成前に落ちた場合）", () => {
		expect(() => recordConnectionFailure(lookupOf(), "srv", "global", new Error("early"))).not.toThrow()
	})

	it("Error でない値も文字列化して残す", () => {
		const conn = connectionFor("srv", "connecting")

		recordConnectionFailure(lookupOf(conn), "srv", "global", "plain string")

		expect(conn.server.error).toBe("plain string")
	})
})
