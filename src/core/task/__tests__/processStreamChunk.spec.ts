import { describe, it, expect, vi, beforeEach } from "vitest"

import { processStreamChunk } from "../processStreamChunk"

vi.mock("../processStreamTextChunks", () => ({
	processReasoningChunk: vi.fn(),
	processTextChunk: vi.fn(),
}))
vi.mock("../processCompleteToolCall", () => ({ processCompleteToolCall: vi.fn() }))
vi.mock("../processToolCallPartial", () => ({ processToolCallPartial: vi.fn() }))

import { processReasoningChunk, processTextChunk } from "../processStreamTextChunks"
import { processCompleteToolCall } from "../processCompleteToolCall"
import { processToolCallPartial } from "../processToolCallPartial"

const mockedReasoning = vi.mocked(processReasoningChunk)
const mockedText = vi.mocked(processTextChunk)
const mockedComplete = vi.mocked(processCompleteToolCall)
const mockedPartial = vi.mocked(processToolCallPartial)

function makeDeps() {
	return { host: {}, presentAssistantMessage: vi.fn(), say: vi.fn(async () => {}) } as never
}
const emptyTokens = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: undefined as number | undefined })
const msgs = () => ({ reasoningMessage: "", assistantMessage: "" })

beforeEach(() => vi.clearAllMocks())

describe("processStreamChunk", () => {
	it("usage: tokens に加算する（cache 欠損は 0 既定）", async () => {
		const tokens = emptyTokens()

		await processStreamChunk(
			makeDeps(),
			{ type: "usage", inputTokens: 10, outputTokens: 20, totalCost: 0.5 } as never,
			msgs(),
			tokens as never,
		)

		expect(tokens).toEqual({ input: 10, output: 20, cacheWrite: 0, cacheRead: 0, total: 0.5 })
	})

	it("usage: cacheRead があれば反映する", async () => {
		const tokens = emptyTokens()

		await processStreamChunk(
			makeDeps(),
			{
				type: "usage",
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 3,
				totalCost: 1,
			} as never,
			msgs(),
			tokens as never,
		)

		expect(tokens.cacheRead).toBe(3)
	})

	it("reasoning は processReasoningChunk の結果を reasoningMessage に返す", async () => {
		mockedReasoning.mockResolvedValue("R" as never)

		const out = await processStreamChunk(
			makeDeps(),
			{ type: "reasoning", text: "think" } as never,
			msgs(),
			emptyTokens() as never,
		)

		expect(mockedReasoning).toHaveBeenCalled()
		expect(out.reasoningMessage).toBe("R")
	})

	it("text は processTextChunk の結果を assistantMessage に返す", async () => {
		mockedText.mockReturnValue("A" as never)

		const out = await processStreamChunk(
			makeDeps(),
			{ type: "text", text: "hi" } as never,
			msgs(),
			emptyTokens() as never,
		)

		expect(mockedText).toHaveBeenCalled()
		expect(out.assistantMessage).toBe("A")
	})

	it("tool_call_partial / tool_call はそれぞれの handler へ振り分ける", async () => {
		await processStreamChunk(
			makeDeps(),
			{ type: "tool_call_partial", index: 3, id: "x", name: "n", arguments: "{}" } as never,
			msgs(),
			emptyTokens() as never,
		)
		expect(mockedPartial).toHaveBeenCalledWith(expect.anything(), { index: 3, id: "x", name: "n", arguments: "{}" })

		await processStreamChunk(
			makeDeps(),
			{ type: "tool_call", id: "y", name: "m", arguments: "{}" } as never,
			msgs(),
			emptyTokens() as never,
		)
		expect(mockedComplete).toHaveBeenCalledWith(expect.anything(), { id: "y", name: "m", arguments: "{}" })
	})
})
