import { describe, it, expect, vi, beforeEach } from "vitest"

// build-tools は 3 つの collaborator に委譲するだけの薄い orchestrator なので全て mock する。
// 注意: vi.mock のパスは spec (core/task/__tests__) から見た相対で、ソース (core/task) の指定子より 1 段深い。
vi.mock("../../prompts/tools/native-tools", () => ({
	getNativeTools: vi.fn(),
	getMcpServerTools: vi.fn(),
}))
vi.mock("../../prompts/tools/filter-tools-for-mode", () => ({
	filterNativeToolsForMode: vi.fn(),
	filterMcpToolsForMode: vi.fn(),
	resolveToolAlias: vi.fn(),
}))
// build-tools は動的 import する（await import("../../services/code-index/manager")）が vi.mock で捕捉される。
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: vi.fn() },
}))

import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { getNativeTools, getMcpServerTools } from "../../prompts/tools/native-tools"
import {
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	resolveToolAlias,
} from "../../prompts/tools/filter-tools-for-mode"
import { CodeIndexManager } from "../../../services/code-index/manager"

const tool = (name: string) => ({ type: "function", function: { name } }) as never

// getNativeTools / getMcpServerTools が返す「素の」全 tool 群
const nativeTools = [tool("read_file"), tool("write_to_file")]
const mcpTools = [tool("use_mcp_tool")]
// filter を通過した後の tool 群（別 array にして連結結果の同一性を検証できるようにする）
const filteredNative = [tool("read_file")]
const filteredMcp = [tool("use_mcp_tool")]

const codeIndexManager = { id: "cim" }

function makeProvider() {
	const mcpHub = { id: "mcpHub" }
	return {
		context: { id: "ctx" } as never,
		mcpHub,
		getMcpHub: vi.fn(() => mcpHub),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(getNativeTools).mockReturnValue(nativeTools)
	vi.mocked(getMcpServerTools).mockReturnValue(mcpTools)
	vi.mocked(filterNativeToolsForMode).mockReturnValue(filteredNative)
	vi.mocked(filterMcpToolsForMode).mockReturnValue(filteredMcp)
	vi.mocked(resolveToolAlias).mockImplementation((n: string) => n.replace(/^alias_/, ""))
	vi.mocked(CodeIndexManager.getInstance).mockReturnValue(codeIndexManager as never)
})

describe("buildNativeToolsArrayWithRestrictions", () => {
	it("filter 済みの native+mcp を連結して返す", async () => {
		const provider = makeProvider()

		const result = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/repo",
			mode: "code",
			experiments: undefined,
			apiConfiguration: undefined,
		} as never)

		expect(result.tools).toEqual([...filteredNative, ...filteredMcp])
	})

	it("mcpHub / codeIndexManager / mode 引数を各 collaborator へ正しく配線する", async () => {
		const provider = makeProvider()
		const experiments = { runSlashCommand: true }

		await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: "/work",
			mode: "ask",
			experiments,
			apiConfiguration: undefined,
		} as never)

		expect(provider.getMcpHub).toHaveBeenCalledTimes(1)
		expect(CodeIndexManager.getInstance).toHaveBeenCalledWith(provider.context, "/work")
		expect(getMcpServerTools).toHaveBeenCalledWith(provider.mcpHub)
		// native filter は素の nativeTools・mode・codeIndexManager・settings・mcpHub を受ける
		expect(filterNativeToolsForMode).toHaveBeenCalledWith(
			nativeTools,
			"ask",
			experiments,
			codeIndexManager,
			expect.objectContaining({ todoListEnabled: true }),
			provider.mcpHub,
		)
		// mcp filter は素の mcpTools・mode を受ける
		expect(filterMcpToolsForMode).toHaveBeenCalledWith(mcpTools, "ask", experiments)
	})

	it("apiConfiguration 未指定なら todoListEnabled は true 既定、supportsImages 未指定は false になる", async () => {
		await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider(),
			cwd: "/repo",
			mode: "code",
			experiments: undefined,
			apiConfiguration: undefined,
			modelInfo: undefined,
		} as never)

		expect(getNativeTools).toHaveBeenCalledWith({ supportsImages: false })
		const settings = vi.mocked(filterNativeToolsForMode).mock.calls[0][4]
		expect(settings).toEqual({
			todoListEnabled: true,
			webFetchEnabled: false,
			disabledTools: undefined,
			modelInfo: undefined,
		})
	})

	it("apiConfiguration.todoListEnabled=false / disabledTools / modelInfo.supportsImages を尊重する", async () => {
		const modelInfo = { supportsImages: true } as never

		await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider(),
			cwd: "/repo",
			mode: "code",
			experiments: undefined,
			apiConfiguration: { todoListEnabled: false } as never,
			disabledTools: ["edit"],
			modelInfo,
		} as never)

		expect(getNativeTools).toHaveBeenCalledWith({ supportsImages: true })
		const settings = vi.mocked(filterNativeToolsForMode).mock.calls[0][4]
		expect(settings).toEqual({ todoListEnabled: false, webFetchEnabled: false, disabledTools: ["edit"], modelInfo })
	})

	it("apiConfiguration.webFetchEnabled=true を尊重する", async () => {
		await buildNativeToolsArrayWithRestrictions({
			provider: makeProvider(),
			cwd: "/repo",
			mode: "code",
			experiments: undefined,
			apiConfiguration: { webFetchEnabled: true } as never,
		} as never)

		const settings = vi.mocked(filterNativeToolsForMode).mock.calls[0][4]
		expect(settings?.webFetchEnabled).toBe(true)
	})
})
