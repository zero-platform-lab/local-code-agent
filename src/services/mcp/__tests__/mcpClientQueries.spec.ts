import { describe, it, expect, vi, beforeEach } from "vitest"

import type { McpServer } from "@openai-agent/types"

import type { ConnectedMcpConnection, DisconnectedMcpConnection } from "../mcpConnection"
import {
	fetchServerResources,
	fetchServerResourceTemplates,
	fetchServerTools,
	requestResourceRead,
	requestToolCall,
} from "../mcpClientQueries"

vi.mock("../mcpSettingsFile", () => ({
	readServerEntries: vi.fn(),
}))
import { readServerEntries } from "../mcpSettingsFile"

const mockedReadServerEntries = vi.mocked(readServerEntries)

const settingsPaths = {} as never // readServerEntries はモックなので中身は使わない

function connected(overrides: {
	name?: string
	source?: "global" | "project"
	config?: string
	request?: ReturnType<typeof vi.fn>
}): ConnectedMcpConnection {
	const request = overrides.request ?? vi.fn().mockResolvedValue({})
	return {
		type: "connected",
		server: {
			name: overrides.name ?? "srv",
			source: overrides.source ?? "global",
			config: overrides.config ?? JSON.stringify({ type: "stdio", command: "node", timeout: 30 }),
		} as unknown as McpServer,
		client: { request } as never,
		transport: {} as never,
		declaredConfig: {} as never,
	}
}

const disconnected = {
	type: "disconnected",
	server: { name: "srv", source: "global" } as unknown as McpServer,
	client: null,
	transport: null,
	declaredConfig: {} as never,
} as DisconnectedMcpConnection

beforeEach(() => {
	mockedReadServerEntries.mockReset()
	mockedReadServerEntries.mockResolvedValue(null)
})

describe("fetchServerTools", () => {
	it("接続が無ければ空配列", async () => {
		expect(await fetchServerTools(undefined, settingsPaths)).toEqual([])
	})

	it("connected でなければ空配列", async () => {
		expect(await fetchServerTools(disconnected, settingsPaths)).toEqual([])
	})

	it("設定ファイルの alwaysAllow/disabledTools をツールに反映する", async () => {
		const request = vi.fn().mockResolvedValue({ tools: [{ name: "a" }, { name: "b" }] })
		mockedReadServerEntries.mockResolvedValue({ srv: { alwaysAllow: ["a"], disabledTools: ["b"] } } as never)

		const tools = await fetchServerTools(connected({ request }), settingsPaths)

		expect(tools.find((t) => t.name === "a")?.alwaysAllow).toBe(true)
		expect(tools.find((t) => t.name === "b")?.enabledForPrompt).toBe(false)
	})

	it("フラグは接続実体の source/name に基づいて引く", async () => {
		const request = vi.fn().mockResolvedValue({ tools: [] })
		await fetchServerTools(connected({ request, name: "proj-srv", source: "project" }), settingsPaths)

		expect(mockedReadServerEntries).toHaveBeenCalledWith(settingsPaths, "project")
	})

	it("設定読み取りが失敗してもツールは既定フラグで返す", async () => {
		const request = vi.fn().mockResolvedValue({ tools: [{ name: "a" }] })
		mockedReadServerEntries.mockRejectedValue(new Error("boom"))

		const tools = await fetchServerTools(connected({ request }), settingsPaths)

		expect(tools).toMatchObject([{ name: "a", alwaysAllow: false, enabledForPrompt: true }])
	})

	it("tools/list 自体が失敗したら空配列（best-effort）", async () => {
		const request = vi.fn().mockRejectedValue(new Error("down"))
		expect(await fetchServerTools(connected({ request }), settingsPaths)).toEqual([])
	})

	it("source が未設定なら global の設定を引く（|| 'global' の既定側）", async () => {
		const request = vi.fn().mockResolvedValue({ tools: [] })
		// server.source を空文字にして falsy 側の分岐を通す。
		await fetchServerTools(connected({ request, source: "" as never }), settingsPaths)

		expect(mockedReadServerEntries).toHaveBeenCalledWith(settingsPaths, "global")
	})

	it("応答に tools が無ければ空配列（response?.tools || [] の既定側）", async () => {
		// || [] を外すと applyToolConfigFlags(undefined) が .map で throw し、外側の
		// try/catch に握られて同じ [] を返してしまう。そのすり抜けを塞ぐため、
		// 「エラー経路に落ちていない」ことまで固定する。
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const request = vi.fn().mockResolvedValue({})
			expect(await fetchServerTools(connected({ request }), settingsPaths)).toEqual([])
			expect(errorSpy).not.toHaveBeenCalled()
		} finally {
			errorSpy.mockRestore()
		}
	})

	it("応答自体が undefined でも落ちず空配列（response?. の nullish 側）", async () => {
		const request = vi.fn().mockResolvedValue(undefined)
		expect(await fetchServerTools(connected({ request }), settingsPaths)).toEqual([])
	})
})

describe("fetchServerResources / fetchServerResourceTemplates", () => {
	it("接続が無ければ空配列", async () => {
		expect(await fetchServerResources(undefined)).toEqual([])
		expect(await fetchServerResourceTemplates(undefined)).toEqual([])
	})

	it("resources/list の結果を返す", async () => {
		const request = vi.fn().mockResolvedValue({ resources: [{ uri: "file://x" }] })
		expect(await fetchServerResources(connected({ request }))).toEqual([{ uri: "file://x" }])
	})

	it("resources/templates/list の結果を返す", async () => {
		const request = vi.fn().mockResolvedValue({ resourceTemplates: [{ uriTemplate: "file://{id}" }] })
		expect(await fetchServerResourceTemplates(connected({ request }))).toEqual([{ uriTemplate: "file://{id}" }])
	})

	it("失敗時は空配列（例外を伝播しない）", async () => {
		const request = vi.fn().mockRejectedValue(new Error("down"))
		expect(await fetchServerResources(connected({ request }))).toEqual([])
		expect(await fetchServerResourceTemplates(connected({ request }))).toEqual([])
	})

	it("応答に resources / resourceTemplates が無ければ空配列（|| [] の既定側）", async () => {
		const emptyResources = vi.fn().mockResolvedValue({})
		expect(await fetchServerResources(connected({ request: emptyResources }))).toEqual([])

		const emptyTemplates = vi.fn().mockResolvedValue({})
		expect(await fetchServerResourceTemplates(connected({ request: emptyTemplates }))).toEqual([])
	})

	it("応答自体が undefined でも落ちず空配列（response?. の nullish 側）", async () => {
		const nullResources = vi.fn().mockResolvedValue(undefined)
		expect(await fetchServerResources(connected({ request: nullResources }))).toEqual([])

		const nullTemplates = vi.fn().mockResolvedValue(undefined)
		expect(await fetchServerResourceTemplates(connected({ request: nullTemplates }))).toEqual([])
	})
})

describe("requestToolCall", () => {
	it("server.config の timeout（秒）をミリ秒に換算して渡す", async () => {
		const request = vi.fn().mockResolvedValue({ content: [] })
		const config = JSON.stringify({ type: "stdio", command: "node", args: [], timeout: 30 })
		await requestToolCall(connected({ request, config }), "t", { x: 1 })

		expect(request).toHaveBeenCalledWith(
			{ method: "tools/call", params: { name: "t", arguments: { x: 1 } } },
			expect.anything(),
			{ timeout: 30000 },
		)
	})

	it("config が壊れていたら timeout 60 秒を既定にする", async () => {
		const request = vi.fn().mockResolvedValue({ content: [] })
		await requestToolCall(connected({ request, config: "not-json" }), "t")

		expect(request).toHaveBeenCalledWith(expect.anything(), expect.anything(), { timeout: 60000 })
	})
})

describe("requestResourceRead", () => {
	it("resources/read を uri 付きで投げる", async () => {
		const request = vi.fn().mockResolvedValue({ contents: [] })
		await requestResourceRead(connected({ request }), "file://y")

		expect(request).toHaveBeenCalledWith(
			{ method: "resources/read", params: { uri: "file://y" } },
			expect.anything(),
		)
	})
})
