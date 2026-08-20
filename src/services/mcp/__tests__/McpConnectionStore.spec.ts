import { describe, it, expect } from "vitest"

import type { McpServer } from "@openai-agent/types"

import { McpConnectionStore } from "../McpConnectionStore"
import type { McpConnection } from "../mcpConnection"

const conn = (name: string, overrides: Partial<McpServer> = {}): McpConnection =>
	({
		type: "disconnected",
		server: { name, config: "{}", status: "disconnected", ...overrides } as McpServer,
		client: null,
		transport: null,
	}) as McpConnection

const storeWith = (...connections: McpConnection[]) => {
	const store = new McpConnectionStore()
	connections.forEach((c) => store.add(c))
	return store
}

describe("McpConnectionStore", () => {
	it("初期状態は空", () => {
		const store = new McpConnectionStore()

		expect(store.size).toBe(0)
		expect(store.items).toEqual([])
		expect(store.allServers()).toEqual([])
	})

	describe("add / remove", () => {
		it("追加した接続を保持する", () => {
			const store = storeWith(conn("a", { source: "global" }))

			expect(store.size).toBe(1)
			expect(store.find("a")?.server.name).toBe("a")
		})

		it("source 指定の削除は他 source を残す", () => {
			const store = storeWith(conn("a", { source: "global" }), conn("a", { source: "project" }))

			store.remove("a", "global")

			expect(store.size).toBe(1)
			expect(store.find("a")?.server.source).toBe("project")
		})

		it("source 未指定の削除は同名を全部消す", () => {
			const store = storeWith(conn("a", { source: "global" }), conn("a", { source: "project" }))

			store.remove("a")

			expect(store.size).toBe(0)
		})

		it("一致しない名前の削除は何もしない", () => {
			const store = storeWith(conn("a", { source: "global" }))

			store.remove("b")

			expect(store.size).toBe(1)
		})

		it("matching は remove と同じ対象を返す（閉じてから消すため）", () => {
			const store = storeWith(conn("a", { source: "global" }), conn("a", { source: "project" }), conn("b"))

			const targets = store.matching("a", "project")
			expect(targets).toHaveLength(1)

			store.remove("a", "project")
			expect(store.matching("a", "project")).toHaveLength(0)
			expect(store.size).toBe(2)
		})
	})

	// `sanitizeMcpName` はハイフンを温存するので、対応表が効くのは「サニタイズで実際に
	// 文字が変わる名前」（空白・記号入り）のときだけ。ハイフン↔アンダースコアの揺れは
	// 対応表ではなく接続一覧に対するファジー一致で吸収される。
	describe("サニタイズ名の対応", () => {
		it("サニタイズで変形する名前を元に戻せる", () => {
			const store = storeWith(conn("my server!"))
			store.rememberName("my server!")

			expect(store.resolveName("my_server")).toBe("my server!")
		})

		it("接続がまだ無くても解決できる（transport 生成に失敗した直後など）", () => {
			const store = new McpConnectionStore()
			store.rememberName("my server!")

			expect(store.resolveName("my_server")).toBe("my server!")
		})

		it("ハイフン名は対応表を経ずファジー一致で解決する", () => {
			const store = storeWith(conn("my-server"))

			// rememberName していなくても接続一覧から引ける
			expect(store.resolveName("my_server")).toBe("my-server")
		})

		it("その名前の接続が全部消えたら対応も落とす", () => {
			const store = storeWith(conn("my server!", { source: "global" }))
			store.rememberName("my server!")

			store.remove("my server!")

			expect(store.resolveName("my_server")).toBeNull()
		})

		it("同名の接続が残っている間は対応を保つ", () => {
			const store = storeWith(conn("my server!", { source: "global" }), conn("my server!", { source: "project" }))
			store.rememberName("my server!")

			store.remove("my server!", "global")

			expect(store.resolveName("my_server")).toBe("my server!")
		})
	})

	describe("source による絞り込み", () => {
		it("withSource は source 厳密一致（未設定は含めない）", () => {
			const store = storeWith(conn("a", { source: "global" }), conn("b", { source: "project" }), conn("c"))

			expect(store.withSource("project").map((c) => c.server.name)).toEqual(["b"])
			expect(store.withSource("global").map((c) => c.server.name)).toEqual(["a"])
		})

		it("namesOwnedBy は source 未設定を global 扱いにする", () => {
			const store = storeWith(conn("a", { source: "global" }), conn("b", { source: "project" }), conn("c"))

			expect(store.namesOwnedBy("global")).toEqual(new Set(["a", "c"]))
			expect(store.namesOwnedBy("project")).toEqual(new Set(["b"]))
		})
	})

	describe("スナップショットと反復", () => {
		it("snapshot は削除の影響を受けないコピー", () => {
			const store = storeWith(conn("a", { source: "global" }), conn("b", { source: "global" }))
			const snapshot = store.snapshot()

			store.remove("a")

			expect(snapshot).toHaveLength(2)
			expect(store.size).toBe(1)
		})

		it("items の反復中に remove しても反復開始時点の全要素を回る（dispose が依存）", () => {
			const store = storeWith(conn("a", { source: "global" }), conn("b", { source: "global" }))
			const visited: string[] = []

			for (const c of store.items) {
				visited.push(c.server.name)
				store.remove(c.server.name)
			}

			expect(visited).toEqual(["a", "b"])
			expect(store.size).toBe(0)
		})
	})

	describe("replaceAll / clear", () => {
		it("replaceAll は中身を差し替える", () => {
			const store = storeWith(conn("a", { source: "global" }))

			store.replaceAll([conn("b", { source: "global" })])

			expect(store.allServers().map((s) => s.name)).toEqual(["b"])
		})

		it("replaceAll は渡した配列を後から書き換えても影響を受けない", () => {
			const store = new McpConnectionStore()
			const input = [conn("a", { source: "global" })]

			store.replaceAll(input)
			input.push(conn("b", { source: "global" }))

			expect(store.size).toBe(1)
		})

		it("clear は接続を空にする", () => {
			const store = storeWith(conn("a", { source: "global" }))

			store.clear()

			expect(store.size).toBe(0)
		})
	})

	describe("サーバ一覧の投影", () => {
		it("enabledServers は無効サーバを除き、同名は project 優先", () => {
			const store = storeWith(
				conn("a", { source: "global" }),
				conn("a", { source: "project" }),
				conn("b", { source: "global", disabled: true }),
			)

			const servers = store.enabledServers()

			expect(servers).toHaveLength(1)
			expect(servers[0].source).toBe("project")
		})

		it("allServers は状態を問わず全部返す", () => {
			const store = storeWith(conn("a", { source: "global" }), conn("b", { source: "global", disabled: true }))

			expect(store.allServers().map((s) => s.name)).toEqual(["a", "b"])
		})

		it("serversInConfigOrder は project を先に設定順で返す", () => {
			const store = storeWith(
				conn("g2", { source: "global" }),
				conn("p1", { source: "project" }),
				conn("g1", { source: "global" }),
			)

			const servers = store.serversInConfigOrder({ global: ["g1", "g2"], project: ["p1"] })

			expect(servers.map((s) => s.name)).toEqual(["p1", "g1", "g2"])
		})
	})
})
