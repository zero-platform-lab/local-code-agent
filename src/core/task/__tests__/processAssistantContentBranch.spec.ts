import { describe, it, expect, vi, beforeEach } from "vitest"

import { processAssistantContentBranch } from "../processAssistantContentBranch"

vi.mock("../persistAssistantContentIfAny", () => ({ persistAssistantContentIfAny: vi.fn() }))
vi.mock("../finalizeAssistantIterationForStack", () => ({ finalizeAssistantIterationForStack: vi.fn() }))
vi.mock("../handleEmptyAssistantResponse", () => ({ handleEmptyAssistantResponse: vi.fn() }))

import { persistAssistantContentIfAny } from "../persistAssistantContentIfAny"
import { finalizeAssistantIterationForStack } from "../finalizeAssistantIterationForStack"
import { handleEmptyAssistantResponse } from "../handleEmptyAssistantResponse"

const mockedPersist = vi.mocked(persistAssistantContentIfAny)
const mockedFinalize = vi.mocked(finalizeAssistantIterationForStack)
const mockedHandleEmpty = vi.mocked(handleEmptyAssistantResponse)

function makeDeps(assistantMessageContent: unknown[] = []) {
	return {
		host: { stream: { assistantMessageContent } },
		presentAssistantMessage: vi.fn(),
		say: vi.fn(),
		ask: vi.fn(),
		addToApiConversationHistory: vi.fn(),
		pushToolResultToUserContent: vi.fn(),
		getProviderState: vi.fn(),
		backoffAndAnnounce: vi.fn(),
	} as never
}

const input = (over: Record<string, unknown> = {}) => ({
	assistantMessage: "",
	reasoningMessage: "",
	pendingGroundingSources: [],
	partialBlocks: [],
	currentUserContent: [],
	currentRetryAttempt: 0,
	...over,
})

beforeEach(() => {
	vi.clearAllMocks()
	mockedFinalize.mockResolvedValue({ stack: "item" } as never)
	mockedHandleEmpty.mockResolvedValue({ action: "continue" } as never)
})

describe("processAssistantContentBranch", () => {
	it("テキストありなら保存して finalize、空応答処理は呼ばない", async () => {
		const deps = makeDeps()

		const result = await processAssistantContentBranch(deps, input({ assistantMessage: "hi" }) as never)

		expect(mockedPersist).toHaveBeenCalled()
		expect(mockedFinalize).toHaveBeenCalled()
		expect(mockedHandleEmpty).not.toHaveBeenCalled()
		expect(result).toEqual({ action: "continue", nextStackItem: { stack: "item" } })
	})

	it("tool_use があれば（テキスト無しでも）content 経路を通る", async () => {
		const deps = makeDeps([{ type: "tool_use" }])

		await processAssistantContentBranch(deps, input() as never)

		expect(mockedPersist).toHaveBeenCalled()
		expect(mockedHandleEmpty).not.toHaveBeenCalled()
	})

	it("partialBlocks があれば present する", async () => {
		const deps = makeDeps()

		await processAssistantContentBranch(deps, input({ assistantMessage: "hi", partialBlocks: [{}] }) as never)

		expect((deps as any).presentAssistantMessage).toHaveBeenCalled()
	})

	it("mcp_tool_use があれば content 経路を通る（|| mcp_tool_use を踏む）", async () => {
		const deps = makeDeps([{ type: "mcp_tool_use" }])

		await processAssistantContentBranch(deps, input() as never)

		expect(mockedPersist).toHaveBeenCalled()
		expect(mockedHandleEmpty).not.toHaveBeenCalled()
	})

	it("content 無し・partialBlocks ありでも present してから空応答処理へ委ねる", async () => {
		const deps = makeDeps()

		await processAssistantContentBranch(deps, input({ partialBlocks: [{}] }) as never)

		expect((deps as any).presentAssistantMessage).toHaveBeenCalled()
		expect(mockedHandleEmpty).toHaveBeenCalled()
		expect(mockedPersist).not.toHaveBeenCalled()
	})

	it("空応答処理に渡す addToApiConversationHistory は元の deps に委譲する", async () => {
		const deps = makeDeps()
		mockedHandleEmpty.mockImplementationOnce(async (d: any) => {
			await d.addToApiConversationHistory({ role: "user", content: [] })
			return { action: "continue" }
		})

		await processAssistantContentBranch(deps, input() as never)

		expect((deps as any).addToApiConversationHistory).toHaveBeenCalledWith({ role: "user", content: [] })
	})

	it("content が無ければ handleEmptyAssistantResponse に委ねる（persist/finalize は呼ばない）", async () => {
		const deps = makeDeps()

		await processAssistantContentBranch(deps, input() as never)

		expect(mockedHandleEmpty).toHaveBeenCalled()
		expect(mockedPersist).not.toHaveBeenCalled()
		expect(mockedFinalize).not.toHaveBeenCalled()
	})

	it("空応答が break を返したら break を返す", async () => {
		mockedHandleEmpty.mockResolvedValue({ action: "break" } as never)
		const deps = makeDeps()

		const result = await processAssistantContentBranch(deps, input() as never)

		expect(result).toEqual({ action: "break" })
	})

	it("空応答が retryStackItem を返したら nextStackItem に載せて continue", async () => {
		mockedHandleEmpty.mockResolvedValue({ action: "continue", retryStackItem: { retry: 1 } } as never)
		const deps = makeDeps()

		const result = await processAssistantContentBranch(deps, input() as never)

		expect(result).toEqual({ action: "continue", nextStackItem: { retry: 1 } })
	})
})
