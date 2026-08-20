import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../services/mcp/McpServerManager", () => ({ McpServerManager: { getInstance: vi.fn() } }))

import { getEnabledMcpToolsCount } from "../getEnabledMcpToolsCount"
import { McpServerManager } from "../../../services/mcp/McpServerManager"

const mockedGetInstance = (McpServerManager as unknown as { getInstance: ReturnType<typeof vi.fn> }).getInstance

// server1: connected/enabled → +1 server, tools = true + undefined(=default enabled) を数え false は除外 → +2 tools
// server2: disabled → 除外 / server3: not connected → 除外 / server4: connected but tools 無し → +1 server, +0 tools
const servers = [
	{
		disabled: false,
		status: "connected",
		tools: [{ enabledForPrompt: true }, { enabledForPrompt: undefined }, { enabledForPrompt: false }],
	},
	{ disabled: true, status: "connected", tools: [{ enabledForPrompt: true }] },
	{ disabled: false, status: "connecting", tools: [{ enabledForPrompt: true }] },
	{ disabled: false, status: "connected", tools: undefined },
]

const hub = { getServers: vi.fn(() => servers) }

function makeProvider(getStateImpl: () => Promise<{ mcpEnabled?: boolean } | undefined>) {
	return { context: { extId: "ctx-1" }, getState: vi.fn(getStateImpl) }
}

function makeRef(provider: unknown) {
	return { deref: () => provider } as never
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("getEnabledMcpToolsCount", () => {
	it("provider が既に破棄されている（deref undefined）なら 0 を返し hub 生成に進まない", async () => {
		const result = await getEnabledMcpToolsCount(makeRef(undefined))

		expect(result).toEqual({ enabledToolCount: 0, enabledServerCount: 0 })
		expect(mockedGetInstance).not.toHaveBeenCalled()
	})

	it("mcpEnabled が明示 false なら hub を生成せず 0 を返す", async () => {
		const provider = makeProvider(async () => ({ mcpEnabled: false }))

		const result = await getEnabledMcpToolsCount(makeRef(provider))

		expect(result).toEqual({ enabledToolCount: 0, enabledServerCount: 0 })
		expect(mockedGetInstance).not.toHaveBeenCalled()
	})

	it("getState が undefined を返しても mcpEnabled 既定 true とみなして集計に進む", async () => {
		mockedGetInstance.mockResolvedValue(hub)
		const provider = makeProvider(async () => undefined)

		const result = await getEnabledMcpToolsCount(makeRef(provider))

		expect(mockedGetInstance).toHaveBeenCalledWith(provider.context, provider)
		expect(result).toEqual({ enabledToolCount: 2, enabledServerCount: 2 })
	})

	it("McpServerManager.getInstance が hub を返さない（null）なら 0 を返す", async () => {
		mockedGetInstance.mockResolvedValue(null)
		const provider = makeProvider(async () => ({ mcpEnabled: true }))

		const result = await getEnabledMcpToolsCount(makeRef(provider))

		expect(result).toEqual({ enabledToolCount: 0, enabledServerCount: 0 })
	})

	it("有効サーバー配下の有効ツールを数える（disabled / 未接続 / enabledForPrompt=false は除外）", async () => {
		mockedGetInstance.mockResolvedValue(hub)
		const provider = makeProvider(async () => ({ mcpEnabled: true }))

		const result = await getEnabledMcpToolsCount(makeRef(provider))

		expect(hub.getServers).toHaveBeenCalledTimes(1)
		expect(result).toEqual({ enabledToolCount: 2, enabledServerCount: 2 })
	})

	it("集計中に例外が起きても console.error して 0 を返す（throw を吸収する）", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const provider = makeProvider(async () => {
			throw new Error("boom")
		})

		const result = await getEnabledMcpToolsCount(makeRef(provider))

		expect(result).toEqual({ enabledToolCount: 0, enabledServerCount: 0 })
		expect(errSpy).toHaveBeenCalledWith(
			"[Task#getEnabledMcpToolsCount] Error counting MCP tools:",
			expect.any(Error),
		)
		errSpy.mockRestore()
	})
})
