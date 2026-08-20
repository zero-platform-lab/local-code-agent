import { describe, it, expect } from "vitest"

import type { McpServer } from "@openai-agent/types"

import type { McpConnection } from "../mcpConnection"
import {
	appendServerError,
	findConnection,
	resolveServerNameFromSanitized,
	selectEnabledServers,
	sortConnectionsByConfigOrder,
} from "../mcpConnectionRegistry"

const conn = (
	name: string,
	overrides: Partial<McpServer> = {},
	type: "connected" | "disconnected" = "disconnected",
): McpConnection =>
	({
		type,
		server: { name, config: "{}", status: "disconnected", ...overrides } as McpServer,
		client: null,
		transport: null,
	}) as McpConnection

describe("findConnection", () => {
	it("source 指定時はその source のものだけを返す", () => {
		const connections = [conn("a", { source: "global" }), conn("a", { source: "project" })]

		expect(findConnection(connections, "a", "global")?.server.source).toBe("global")
		expect(findConnection(connections, "a", "project")?.server.source).toBe("project")
	})

	it("source 未指定なら project を優先する", () => {
		const connections = [conn("a", { source: "global" }), conn("a", { source: "project" })]

		expect(findConnection(connections, "a")?.server.source).toBe("project")
	})

	it("source 未指定で project が無ければ global を返す", () => {
		expect(findConnection([conn("a", { source: "global" })], "a")?.server.source).toBe("global")
	})

	it("source 未設定の接続は global 扱いで拾う（旧設定との互換）", () => {
		expect(findConnection([conn("a")], "a")).toBeDefined()
	})

	it("見つからなければ undefined", () => {
		expect(findConnection([conn("a", { source: "global" })], "b")).toBeUndefined()
		expect(findConnection([conn("a", { source: "global" })], "a", "project")).toBeUndefined()
	})
})

describe("selectEnabledServers", () => {
	it("無効化されたサーバを除外する", () => {
		const servers = selectEnabledServers([
			conn("a", { source: "global" }),
			conn("b", { source: "global", disabled: true }),
		])

		expect(servers.map((s) => s.name)).toEqual(["a"])
	})

	it("同名なら project が global を上書きする（順序に関係なく）", () => {
		const projectFirst = selectEnabledServers([conn("a", { source: "project" }), conn("a", { source: "global" })])
		const globalFirst = selectEnabledServers([conn("a", { source: "global" }), conn("a", { source: "project" })])

		expect(projectFirst).toHaveLength(1)
		expect(projectFirst[0].source).toBe("project")
		expect(globalFirst).toHaveLength(1)
		expect(globalFirst[0].source).toBe("project")
	})
})

describe("sortConnectionsByConfigOrder", () => {
	it("project を先に、それぞれ設定ファイルの記述順で並べる", () => {
		const connections = [
			conn("g2", { source: "global" }),
			conn("p2", { source: "project" }),
			conn("g1", { source: "global" }),
			conn("p1", { source: "project" }),
		]

		const sorted = sortConnectionsByConfigOrder(connections, {
			global: ["g1", "g2"],
			project: ["p1", "p2"],
		})

		expect(sorted.map((c) => c.server.name)).toEqual(["p1", "p2", "g1", "g2"])
	})

	it("入力配列を破壊しない", () => {
		const connections = [conn("b", { source: "global" }), conn("a", { source: "global" })]

		sortConnectionsByConfigOrder(connections, { global: ["a", "b"], project: [] })

		expect(connections.map((c) => c.server.name)).toEqual(["b", "a"])
	})

	it("source 未設定は global として並ぶ", () => {
		const sorted = sortConnectionsByConfigOrder([conn("g"), conn("p", { source: "project" })], {
			global: ["g"],
			project: ["p"],
		})

		expect(sorted.map((c) => c.server.name)).toEqual(["p", "g"])
	})
})

describe("resolveServerNameFromSanitized", () => {
	it("完全一致を最優先で返す", () => {
		const connections = [conn("my-server"), conn("my_server")]

		expect(resolveServerNameFromSanitized(connections, new Map(), "my_server")).toBe("my_server")
	})

	it("登録済みのサニタイズ名から元の名前を引く", () => {
		const registry = new Map([["my_server", "my-server"]])

		expect(resolveServerNameFromSanitized([conn("my-server")], registry, "my_server")).toBe("my-server")
	})

	it("registry に無くてもハイフン/アンダースコアの差はファジーに一致させる", () => {
		expect(resolveServerNameFromSanitized([conn("my-server")], new Map(), "my_server")).toBe("my-server")
	})

	it("解決できなければ null", () => {
		expect(resolveServerNameFromSanitized([conn("other")], new Map(), "my_server")).toBeNull()
	})
})

describe("appendServerError", () => {
	it("履歴に積んで、現在のエラー表示も更新する", () => {
		const server = { name: "a" } as McpServer

		appendServerError(server, "boom")

		expect(server.error).toBe("boom")
		expect(server.errorHistory).toHaveLength(1)
		expect(server.errorHistory![0]).toMatchObject({ message: "boom", level: "error" })
	})

	it("level を指定できる", () => {
		const server = { name: "a" } as McpServer

		appendServerError(server, "note", "info")

		expect(server.errorHistory![0].level).toBe("info")
	})

	it("1000 文字を超えるメッセージは切り詰める", () => {
		const server = { name: "a" } as McpServer

		appendServerError(server, "x".repeat(1500))

		expect(server.error).toHaveLength(1000 + "...(error message truncated)".length)
		expect(server.error!.endsWith("...(error message truncated)")).toBe(true)
	})

	it("履歴は直近 100 件に丸める", () => {
		const server = { name: "a" } as McpServer

		for (let i = 0; i < 105; i++) {
			appendServerError(server, `e${i}`)
		}

		expect(server.errorHistory).toHaveLength(100)
		expect(server.errorHistory![0].message).toBe("e5")
		expect(server.errorHistory![99].message).toBe("e104")
	})
})
