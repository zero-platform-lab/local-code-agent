import { describe, it, expect, vi, beforeEach } from "vitest"

import { buildSystemPrompt } from "../buildSystemPrompt"

vi.mock("../../prompts/system", () => ({ SYSTEM_PROMPT: vi.fn(() => "PROMPT") }))
vi.mock("../../../services/mcp/McpServerManager", () => ({ McpServerManager: { getInstance: vi.fn() } }))
vi.mock("../../../services/mcp/McpHub", () => ({ McpHub: class {} }))
// 実 pWaitFor と同じく predicate を評価する（predicate arrow のカバレッジも取る）。
vi.mock("p-wait-for", () => ({ default: vi.fn(async (predicate?: () => unknown) => void predicate?.()) }))
vi.mock("../../../shared/package", () => ({ Package: { name: "test-ext" } }))

import { SYSTEM_PROMPT } from "../../prompts/system"
import { McpServerManager } from "../../../services/mcp/McpServerManager"
import pWaitFor from "p-wait-for"

const mockedPWaitFor = vi.mocked(pWaitFor)

const mockedSystemPrompt = vi.mocked(SYSTEM_PROMPT)
const mockedGetInstance = (McpServerManager as unknown as { getInstance: ReturnType<typeof vi.fn> }).getInstance

const fakeVscode = {
	workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) },
} as never

function makeDeps(opts: { state?: Record<string, unknown>; providerLost?: boolean } = {}) {
	const provider = {
		context: {},
		getState: vi.fn(async () => opts.state ?? {}),
		getSkillsManager: vi.fn(() => ({})),
	}
	const deps = {
		providerRef: { deref: () => (opts.providerLost ? undefined : provider) },
		api: { getModel: () => ({ info: {}, id: "m1" }) },
		cwd: "/cwd",
		rooIgnoreController: { getInstructions: () => undefined },
		vscode: fakeVscode,
	}
	return deps as never
}

// SYSTEM_PROMPT の引数: (context, cwd, _, mcpHub, diffStrategy, mode, ..., options=arg[12], ...)
const optionsArg = () => mockedSystemPrompt.mock.calls[0][11] as unknown as Record<string, unknown>
const mcpHubArg = () => mockedSystemPrompt.mock.calls[0][3]

beforeEach(() => {
	vi.clearAllMocks()
	mockedGetInstance.mockResolvedValue({ isConnecting: false })
})

describe("buildSystemPrompt", () => {
	it("mcpEnabled 既定（未指定=true）で MCP hub を取得し SYSTEM_PROMPT を返す", async () => {
		const result = await buildSystemPrompt(makeDeps({ state: {} }))

		expect(mockedGetInstance).toHaveBeenCalled()
		expect(mcpHubArg()).toBeDefined()
		expect(result).toBe("PROMPT")
	})

	it("mcpEnabled=false なら MCP を取得せず mcpHub は undefined", async () => {
		await buildSystemPrompt(makeDeps({ state: { mcpEnabled: false } }))

		expect(mockedGetInstance).not.toHaveBeenCalled()
		expect(mcpHubArg()).toBeUndefined()
	})

	it("provider が失われていたら throw する", async () => {
		await expect(buildSystemPrompt(makeDeps({ providerLost: true }))).rejects.toThrow(
			"Provider reference lost during view transition",
		)
	})

	it("設定が無いときは既定値を SYSTEM_PROMPT に渡す（todoListEnabled=true, enableSubfolderRules=false）", async () => {
		await buildSystemPrompt(makeDeps({ state: {} }))

		expect(optionsArg()).toMatchObject({ todoListEnabled: true, enableSubfolderRules: false })
	})

	it("設定があればそれを渡す（todoListEnabled=false, enableSubfolderRules=true）", async () => {
		await buildSystemPrompt(
			makeDeps({ state: { apiConfiguration: { todoListEnabled: false }, enableSubfolderRules: true } }),
		)

		expect(optionsArg()).toMatchObject({ todoListEnabled: false, enableSubfolderRules: true })
	})

	it("MCP hub が取得できなければ throw する", async () => {
		mockedGetInstance.mockResolvedValue(undefined)

		await expect(buildSystemPrompt(makeDeps({ state: {} }))).rejects.toThrow(
			"Failed to get MCP hub from server manager",
		)
	})

	it("MCP 接続待ちが失敗しても握り潰して続行する", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		mockedPWaitFor.mockRejectedValueOnce(new Error("timeout"))

		const result = await buildSystemPrompt(makeDeps({ state: {} }))

		expect(errSpy).toHaveBeenCalledWith("MCP servers failed to connect in time")
		expect(result).toBe("PROMPT")
		errSpy.mockRestore()
	})

	it("2 回目の getState が undefined でも既定にフォールバックする（state ?? {}）", async () => {
		const provider = {
			context: {},
			getState: vi.fn(async () => undefined),
			getSkillsManager: vi.fn(() => ({})),
		}
		const deps = {
			providerRef: { deref: () => provider },
			api: { getModel: () => ({ info: {}, id: "m1" }) },
			cwd: "/cwd",
			rooIgnoreController: { getInstructions: () => undefined },
			vscode: fakeVscode,
		} as never

		const result = await buildSystemPrompt(deps)

		expect(result).toBe("PROMPT")
		// state 未取得でも既定値が渡る
		expect(optionsArg()).toMatchObject({ todoListEnabled: true, enableSubfolderRules: false })
	})

	it("view 遷移で provider が途中で失われたら Provider not available を throw する", async () => {
		const provider = {
			context: {},
			getState: vi.fn(async () => ({ mcpEnabled: false })),
			getSkillsManager: vi.fn(() => ({})),
		}
		let n = 0
		const deps = {
			// deref 3 回目（最後の provider チェック）だけ undefined を返す
			providerRef: { deref: () => (++n >= 3 ? undefined : provider) },
			api: { getModel: () => ({ info: {}, id: "m1" }) },
			cwd: "/cwd",
			rooIgnoreController: { getInstructions: () => undefined },
			vscode: fakeVscode,
		} as never

		await expect(buildSystemPrompt(deps)).rejects.toThrow("Provider not available")
	})
})
