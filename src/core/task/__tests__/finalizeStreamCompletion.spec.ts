import { describe, it, expect, vi, beforeEach } from "vitest"

import { finalizeStreamCompletion } from "../finalizeStreamCompletion"

vi.mock("../../assistant-message/NativeToolCallParser", () => ({
	NativeToolCallParser: { finalizeRawChunks: vi.fn() },
}))
vi.mock("../finalizeStreamingToolCalls", () => ({ finalizeStreamingToolCalls: vi.fn() }))
vi.mock("../finalizeReasoningMessage", () => ({ finalizeReasoningMessage: vi.fn() }))

import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { finalizeStreamingToolCalls } from "../finalizeStreamingToolCalls"
import { finalizeReasoningMessage } from "../finalizeReasoningMessage"

const mockedFinalizeRaw = vi.mocked(NativeToolCallParser.finalizeRawChunks)
const mockedRunFinalize = vi.mocked(finalizeStreamingToolCalls)
const mockedReasoning = vi.mocked(finalizeReasoningMessage)

function makeDeps(content: Array<{ partial: boolean; id: number }>) {
	const host = {
		stream: {
			streamingToolCallIndices: new Map<string, number>(),
			assistantMessageContent: content,
			userMessageContentReady: false,
		},
		messageStore: { clineMessages: [] },
	}
	return {
		host,
		presentAssistantMessage: vi.fn(),
		updateClineMessage: vi.fn(async () => {}),
		saveClineMessages: vi.fn(async () => {}),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedFinalizeRaw.mockReturnValue(["EVENT"] as never)
	mockedReasoning.mockResolvedValue(undefined as never)
})

describe("finalizeStreamCompletion", () => {
	it("finalizeRawChunks の event を finalizeStreamingToolCalls へ渡す", async () => {
		const deps = makeDeps([{ partial: false, id: 1 }])

		await finalizeStreamCompletion(deps as never, "reasoning")

		expect(mockedFinalizeRaw).toHaveBeenCalledTimes(1)
		expect(mockedRunFinalize).toHaveBeenCalledWith(["EVENT"], {
			host: deps.host,
			presentAssistantMessage: deps.presentAssistantMessage,
		})
	})

	it("partial な block だけを集めて non-partial に落とし partialBlocks として返す", async () => {
		const b1 = { partial: true, id: 1 }
		const b2 = { partial: false, id: 2 }
		const b3 = { partial: true, id: 3 }
		const deps = makeDeps([b1, b2, b3])

		const result = await finalizeStreamCompletion(deps as never, "reasoning")

		expect(result.partialBlocks).toEqual([
			{ partial: false, id: 1 },
			{ partial: false, id: 3 },
		])
		// 元 block も in-place で partial=false になる
		expect(b1.partial).toBe(false)
		expect(b3.partial).toBe(false)
		expect(b2.partial).toBe(false)
	})

	it("partial block が無ければ partialBlocks は空", async () => {
		const deps = makeDeps([{ partial: false, id: 1 }])

		const result = await finalizeStreamCompletion(deps as never, "reasoning")

		expect(result.partialBlocks).toEqual([])
	})

	it("reasoning 確定 → save → postState の順で呼ぶ", async () => {
		const deps = makeDeps([])
		const order: string[] = []
		mockedReasoning.mockImplementation((async () => {
			order.push("reasoning")
		}) as never)
		deps.saveClineMessages = vi.fn(async () => {
			order.push("save")
		})
		deps.postStateToWebviewWithoutTaskHistory = vi.fn(async () => {
			order.push("postState")
		})

		await finalizeStreamCompletion(deps as never, "the-reasoning")

		expect(mockedReasoning).toHaveBeenCalledWith(
			{ host: deps.host, updateClineMessage: deps.updateClineMessage },
			"the-reasoning",
		)
		expect(order).toEqual(["reasoning", "save", "postState"])
	})
})
