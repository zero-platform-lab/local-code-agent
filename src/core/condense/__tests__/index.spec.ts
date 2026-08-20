// npx vitest core/condense/__tests__/index.spec.ts

import type { Mock } from "vitest"

import { ApiHandler } from "../../../api"
import { ApiMessage } from "../../task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../../../api/transform/image-cleaning"
import {
	summarizeConversation,
	getMessagesSinceLastSummary,
	getEffectiveApiHistory,
	cleanupAfterTruncation,
	extractCommandBlocks,
	injectSyntheticToolResults,
	transformMessagesForCondensing,
} from "../index"

vi.mock("../../../api/transform/image-cleaning", () => ({
	maybeRemoveImageBlocks: vi.fn((messages: ApiMessage[], _apiHandler: ApiHandler) => [...messages]),
}))

const taskId = "test-task-id"

describe("extractCommandBlocks", () => {
	it("should extract command blocks from string content", () => {
		const message: ApiMessage = {
			type: "message",
			role: "user",
			content: 'Some text <command name="prr">/prr #123</command> more text',
		}

		const result = extractCommandBlocks(message)
		expect(result).toBe('<command name="prr">/prr #123</command>')
	})

	it("should extract multiple command blocks", () => {
		const message: ApiMessage = {
			type: "message",
			role: "user",
			content: '<command name="prr">/prr #123</command> text <command name="mode">/mode code</command>',
		}

		const result = extractCommandBlocks(message)
		expect(result).toBe('<command name="prr">/prr #123</command>\n<command name="mode">/mode code</command>')
	})

	it("should extract command blocks from array content", () => {
		const message: ApiMessage = {
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "Some user text" },
				{ type: "input_text", text: '<command name="prr">Help content</command>' },
			],
		}

		const result = extractCommandBlocks(message)
		expect(result).toBe('<command name="prr">Help content</command>')
	})

	it("should return empty string when no command blocks found", () => {
		const message: ApiMessage = {
			type: "message",
			role: "user",
			content: "Just regular text without commands",
		}

		const result = extractCommandBlocks(message)
		expect(result).toBe("")
	})

	it("should handle multiline command blocks", () => {
		const message: ApiMessage = {
			type: "message",
			role: "user",
			content: `<command name="prr">
Line 1
Line 2
</command>`,
		}

		const result = extractCommandBlocks(message)
		expect(result).toContain("Line 1")
		expect(result).toContain("Line 2")
	})

	it("should handle command blocks with attributes", () => {
		const message: ApiMessage = {
			type: "message",
			role: "user",
			content: '<command name="test" attr1="value1" attr2="value2">content</command>',
		}

		const result = extractCommandBlocks(message)
		expect(result).toContain('name="test"')
		expect(result).toContain('attr1="value1"')
	})
})

/** injectSyntheticToolResults が orphan に対して埋める output 文字列。 */
const SYNTHETIC_OUTPUT = "Context condensation triggered. Tool execution deferred."

describe("injectSyntheticToolResults", () => {
	it("should return messages unchanged when no orphan tool_calls exist", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{
				type: "function_call",
				call_id: "tool-1",
				name: "read_file",
				arguments: JSON.stringify({ path: "test.ts" }),
				ts: 2,
			},
			{ type: "function_call_output", call_id: "tool-1", output: "file contents", ts: 3 },
		]

		const result = injectSyntheticToolResults(messages)
		expect(result).toEqual(messages)
	})

	it("should inject synthetic tool_result for orphan tool_call", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{
				type: "function_call",
				call_id: "tool-orphan",
				name: "attempt_completion",
				arguments: JSON.stringify({ result: "Done" }),
				ts: 2,
			},
			// No function_call_output for tool-orphan
		]

		const result = injectSyntheticToolResults(messages)

		// item 列では tool_result を持つ user メッセージではなく、
		// 独立した function_call_output item が末尾に足される。
		expect(result.length).toBe(3)
		expect(result[2]).toEqual({
			type: "function_call_output",
			call_id: "tool-orphan",
			output: SYNTHETIC_OUTPUT,
			ts: expect.any(Number),
		})
	})

	it("should inject synthetic tool_results for multiple orphan tool_calls", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{
				type: "function_call",
				call_id: "tool-1",
				name: "read_file",
				arguments: JSON.stringify({ path: "test.ts" }),
				ts: 2,
			},
			{
				type: "function_call",
				call_id: "tool-2",
				name: "write_file",
				arguments: JSON.stringify({ path: "out.ts", content: "code" }),
				ts: 3,
			},
			// No outputs for either
		]

		const result = injectSyntheticToolResults(messages)

		// orphan 1 件につき 1 item なので 2 件足される。
		expect(result.length).toBe(5)
		expect(result.slice(3)).toEqual([
			{ type: "function_call_output", call_id: "tool-1", output: SYNTHETIC_OUTPUT, ts: expect.any(Number) },
			{ type: "function_call_output", call_id: "tool-2", output: SYNTHETIC_OUTPUT, ts: expect.any(Number) },
		])
	})

	it("should only inject for orphan tool_calls, not matched ones", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{
				type: "function_call",
				call_id: "matched-tool",
				name: "read_file",
				arguments: JSON.stringify({ path: "test.ts" }),
				ts: 2,
			},
			{
				type: "function_call",
				call_id: "orphan-tool",
				name: "attempt_completion",
				arguments: JSON.stringify({ result: "Done" }),
				ts: 3,
			},
			{ type: "function_call_output", call_id: "matched-tool", output: "file contents", ts: 4 },
			// No output for orphan-tool
		]

		const result = injectSyntheticToolResults(messages)

		expect(result.length).toBe(5)
		expect(result[4]).toEqual({
			type: "function_call_output",
			call_id: "orphan-tool",
			output: SYNTHETIC_OUTPUT,
			ts: expect.any(Number),
		})
	})

	it("should handle messages with string content (no tool items)", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there!", ts: 2 },
		]

		const result = injectSyntheticToolResults(messages)
		expect(result).toEqual(messages)
	})

	it("should handle empty messages array", () => {
		const result = injectSyntheticToolResults([])
		expect(result).toEqual([])
	})

	it("should match outputs to calls regardless of their position in the item list", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{
				type: "function_call",
				call_id: "tool-1",
				name: "read_file",
				arguments: JSON.stringify({ path: "a.ts" }),
				ts: 2,
			},
			{
				type: "function_call",
				call_id: "tool-2",
				name: "read_file",
				arguments: JSON.stringify({ path: "b.ts" }),
				ts: 3,
			},
			// 対応する output が間に別 item を挟んで離れていても orphan 扱いしない
			{ type: "function_call_output", call_id: "tool-2", output: "contents b", ts: 4 },
			{ type: "message", role: "assistant", content: "thinking", ts: 5 },
			{ type: "function_call_output", call_id: "tool-1", output: "contents a", ts: 6 },
		]

		const result = injectSyntheticToolResults(messages)
		// Both calls have matching outputs, no injection needed
		expect(result).toEqual(messages)
	})
})

describe("getMessagesSinceLastSummary", () => {
	it("should return all messages when there is no summary", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
		]

		const result = getMessagesSinceLastSummary(messages)
		expect(result).toEqual(messages)
	})

	it("should return messages since the last summary", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "Summary of conversation", ts: 3, isSummary: true },
			{ type: "message", role: "assistant", content: "How are you?", ts: 4 },
			{ type: "message", role: "user", content: "I'm good", ts: 5 },
		]

		const result = getMessagesSinceLastSummary(messages)
		expect(result).toEqual([
			{ type: "message", role: "user", content: "Summary of conversation", ts: 3, isSummary: true },
			{ type: "message", role: "assistant", content: "How are you?", ts: 4 },
			{ type: "message", role: "user", content: "I'm good", ts: 5 },
		])
	})

	it("should handle multiple summary messages and return since the last one", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "user", content: "First summary", ts: 2, isSummary: true },
			{ type: "message", role: "assistant", content: "How are you?", ts: 3 },
			{ type: "message", role: "user", content: "Second summary", ts: 4, isSummary: true },
			{ type: "message", role: "assistant", content: "What's new?", ts: 5 },
		]

		const result = getMessagesSinceLastSummary(messages)
		expect(result).toEqual([
			{ type: "message", role: "user", content: "Second summary", ts: 4, isSummary: true },
			{ type: "message", role: "assistant", content: "What's new?", ts: 5 },
		])
	})

	it("should handle empty messages array", () => {
		const result = getMessagesSinceLastSummary([])
		expect(result).toEqual([])
	})

	it("should return messages from user summary (fresh start model)", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1, condenseParent: "cond-1" },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2, condenseParent: "cond-1" },
			{ type: "message", role: "user", content: "Summary content", ts: 3, isSummary: true, condenseId: "cond-1" },
			{ type: "message", role: "assistant", content: "Response after summary", ts: 4 },
		]

		const result = getMessagesSinceLastSummary(messages)
		expect(asMsg(result[0]).isSummary).toBe(true)
		expect(asMsg(result[0]).role).toBe("user")
	})
})

describe("getEffectiveApiHistory", () => {
	it("should return only summary when summary exists (fresh start model)", () => {
		const condenseId = "test-condense-id"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First", condenseParent: condenseId },
			{ type: "message", role: "assistant", content: "Second", condenseParent: condenseId },
			{ type: "message", role: "user", content: "Third", condenseParent: condenseId },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary content" }],
				isSummary: true,
				condenseId,
			},
		]

		const result = getEffectiveApiHistory(messages)

		expect(result).toHaveLength(1)
		expect(asMsg(result[0]).isSummary).toBe(true)
	})

	it("should include messages after summary in fresh start model", () => {
		const condenseId = "test-condense-id"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First", condenseParent: condenseId },
			{ type: "message", role: "assistant", content: "Second", condenseParent: condenseId },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary content" }],
				isSummary: true,
				condenseId,
			},
			{ type: "message", role: "assistant", content: "New response after summary" },
			{ type: "message", role: "user", content: "New user message" },
		]

		const result = getEffectiveApiHistory(messages)

		expect(result).toHaveLength(3)
		expect(asMsg(result[0]).isSummary).toBe(true)
		expect(asMsg(result[1]).content).toBe("New response after summary")
		expect(asMsg(result[2]).content).toBe("New user message")
	})

	it("should return all messages when no summary exists", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First" },
			{ type: "message", role: "assistant", content: "Second" },
			{ type: "message", role: "user", content: "Third" },
		]

		const result = getEffectiveApiHistory(messages)

		expect(result).toEqual(messages)
	})

	it("should restore messages when summary is deleted (rewind - orphaned condenseParent)", () => {
		const orphanedCondenseId = "deleted-summary-id"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First", condenseParent: orphanedCondenseId },
			{ type: "message", role: "assistant", content: "Second", condenseParent: orphanedCondenseId },
			{ type: "message", role: "user", content: "Third", condenseParent: orphanedCondenseId },
			// Summary was deleted - no isSummary message exists
		]

		const result = getEffectiveApiHistory(messages)

		// With no summary, all messages should be included (orphaned condenseParent is ignored)
		expect(result).toHaveLength(3)
	})

	it("should filter out truncated messages within summary range", () => {
		const condenseId = "cond-1"
		const truncationId = "trunc-1"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First", condenseParent: condenseId },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary" }],
				isSummary: true,
				condenseId,
			},
			{ type: "message", role: "assistant", content: "Response", truncationParent: truncationId },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "input_text", text: "..." }],
				isTruncationMarker: true,
				truncationId,
			},
			{ type: "message", role: "user", content: "After truncation" },
		]

		const result = getEffectiveApiHistory(messages)

		// Summary + truncation marker + after truncation (the truncated response is filtered out)
		expect(result).toHaveLength(3)
		expect(asMsg(result[0]).isSummary).toBe(true)
		expect(asMsg(result[1]).isTruncationMarker).toBe(true)
		expect(asMsg(result[2]).content).toBe("After truncation")
	})

	it("should filter out orphan function_call_output items after fresh start condensation", () => {
		const condenseId = "cond-1"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", condenseParent: condenseId },
			{
				type: "function_call",
				call_id: "tool-orphan",
				name: "attempt_completion",
				arguments: JSON.stringify({ result: "Done" }),
				condenseParent: condenseId,
			},
			// Summary comes after the function_call (so the call is condensed away)
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary content" }],
				isSummary: true,
				condenseId,
			},
			// This output references a function_call that was condensed away (orphan!)
			{ type: "function_call_output", call_id: "tool-orphan", output: "Rejected by user" },
		]

		const result = getEffectiveApiHistory(messages)

		// Should only return the summary, orphan output item should be filtered out
		expect(result).toHaveLength(1)
		expect(asMsg(result[0]).isSummary).toBe(true)
	})

	it("should keep function_call_output items that have a matching call in fresh start", () => {
		const condenseId = "cond-1"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", condenseParent: condenseId },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary content" }],
				isSummary: true,
				condenseId,
			},
			// This function_call is AFTER the summary, so it's not condensed away
			{
				type: "function_call",
				call_id: "tool-valid",
				name: "read_file",
				arguments: JSON.stringify({ path: "test.ts" }),
			},
			// This output has a matching call, so it should be kept
			{ type: "function_call_output", call_id: "tool-valid", output: "file contents" },
		]

		const result = getEffectiveApiHistory(messages)

		// All messages after summary should be included
		expect(result).toHaveLength(3)
		expect(asMsg(result[0]).isSummary).toBe(true)
		expect(asMsg(result[1]).type).toBe("function_call")
		expect(asMsg(result[1]).call_id).toBe("tool-valid")
		expect(asMsg(result[2]).type).toBe("function_call_output")
		expect(asMsg(result[2]).call_id).toBe("tool-valid")
	})

	it("should drop only the orphan output when orphan and valid outputs are mixed", () => {
		const condenseId = "cond-1"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", condenseParent: condenseId },
			{
				type: "function_call",
				call_id: "tool-orphan",
				name: "attempt_completion",
				arguments: JSON.stringify({ result: "Done" }),
				condenseParent: condenseId,
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary content" }],
				isSummary: true,
				condenseId,
			},
			// This function_call is AFTER the summary
			{
				type: "function_call",
				call_id: "tool-valid",
				name: "read_file",
				arguments: JSON.stringify({ path: "test.ts" }),
			},
			// 旧: 1 つの user メッセージに tool_result が並んでいた。item 列では独立 item。
			{ type: "function_call_output", call_id: "tool-orphan", output: "Orphan result" },
			{ type: "function_call_output", call_id: "tool-valid", output: "Valid result" },
		]

		const result = getEffectiveApiHistory(messages)

		// Summary + function_call + the valid output only
		expect(result).toHaveLength(3)
		expect(asMsg(result[0]).isSummary).toBe(true)
		expect(asMsg(result[1]).call_id).toBe("tool-valid")
		expect(asMsg(result[2]).type).toBe("function_call_output")
		expect(asMsg(result[2]).call_id).toBe("tool-valid")
	})

	it("should handle multiple orphan outputs after the summary", () => {
		const condenseId = "cond-1"
		const messages: ApiMessage[] = [
			{
				type: "function_call",
				call_id: "orphan-1",
				name: "read_file",
				arguments: JSON.stringify({ path: "a.ts" }),
				condenseParent: condenseId,
			},
			{
				type: "function_call",
				call_id: "orphan-2",
				name: "write_file",
				arguments: JSON.stringify({ path: "b.ts", content: "code" }),
				condenseParent: condenseId,
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary content" }],
				isSummary: true,
				condenseId,
			},
			// Both outputs are orphans - both should be removed
			{ type: "function_call_output", call_id: "orphan-1", output: "Result 1" },
			{ type: "function_call_output", call_id: "orphan-2", output: "Result 2" },
		]

		const result = getEffectiveApiHistory(messages)

		// Only summary should remain
		expect(result).toHaveLength(1)
		expect(asMsg(result[0]).isSummary).toBe(true)
	})

	it("should preserve user message items next to a dropped orphan output", () => {
		const condenseId = "cond-1"
		const messages: ApiMessage[] = [
			{
				type: "function_call",
				call_id: "tool-orphan",
				name: "attempt_completion",
				arguments: JSON.stringify({ result: "Done" }),
				condenseParent: condenseId,
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary content" }],
				isSummary: true,
				condenseId,
			},
			// 旧: text と tool_result が同じ user メッセージに同居していた。
			// item 列では別 item なので、text 側は残り output 側だけが落ちる。
			{ type: "message", role: "user", content: [{ type: "input_text", text: "User added some text" }] },
			{ type: "function_call_output", call_id: "tool-orphan", output: "Orphan result" },
		]

		const result = getEffectiveApiHistory(messages)

		// Summary + user text message (orphan output filtered)
		expect(result).toHaveLength(2)
		expect(asMsg(result[0]).isSummary).toBe(true)
		const userContent = asMsg(result[1]).content as any[]
		expect(userContent).toHaveLength(1)
		expect(userContent[0].type).toBe("input_text")
		expect(userContent[0].text).toBe("User added some text")
	})
})

describe("cleanupAfterTruncation", () => {
	it("should clear orphaned condenseParent references", () => {
		const orphanedCondenseId = "deleted-summary"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First", condenseParent: orphanedCondenseId },
			{ type: "message", role: "assistant", content: "Second", condenseParent: orphanedCondenseId },
			{ type: "message", role: "user", content: "Third" },
		]

		const result = cleanupAfterTruncation(messages)

		expect(asMsg(result[0]).condenseParent).toBeUndefined()
		expect(asMsg(result[1]).condenseParent).toBeUndefined()
		expect(asMsg(result[2]).condenseParent).toBeUndefined()
	})

	it("should keep condenseParent when summary still exists", () => {
		const condenseId = "existing-summary"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First", condenseParent: condenseId },
			{ type: "message", role: "assistant", content: "Second", condenseParent: condenseId },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary" }],
				isSummary: true,
				condenseId,
			},
		]

		const result = cleanupAfterTruncation(messages)

		expect(asMsg(result[0]).condenseParent).toBe(condenseId)
		expect(asMsg(result[1]).condenseParent).toBe(condenseId)
	})

	it("should clear orphaned truncationParent references", () => {
		const orphanedTruncationId = "deleted-truncation"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First", truncationParent: orphanedTruncationId },
			{ type: "message", role: "assistant", content: "Second" },
		]

		const result = cleanupAfterTruncation(messages)

		expect(result[0].truncationParent).toBeUndefined()
	})

	it("should keep truncationParent when marker still exists", () => {
		const truncationId = "existing-truncation"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First", truncationParent: truncationId },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "input_text", text: "..." }],
				isTruncationMarker: true,
				truncationId,
			},
		]

		const result = cleanupAfterTruncation(messages)

		expect(result[0].truncationParent).toBe(truncationId)
	})

	it("should handle mixed orphaned and valid references", () => {
		const validCondenseId = "valid-cond"
		const orphanedCondenseId = "orphaned-cond"
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "First", condenseParent: orphanedCondenseId },
			{ type: "message", role: "assistant", content: "Second", condenseParent: validCondenseId },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary" }],
				isSummary: true,
				condenseId: validCondenseId,
			},
		]

		const result = cleanupAfterTruncation(messages)

		expect(asMsg(result[0]).condenseParent).toBeUndefined() // orphaned, cleared
		expect(asMsg(result[1]).condenseParent).toBe(validCondenseId) // valid, kept
	})
})

describe("summarizeConversation", () => {
	// Mock ApiHandler
	let mockApiHandler: ApiHandler
	let mockStream: AsyncGenerator<any, void, unknown>

	beforeEach(() => {
		// Reset mocks
		vi.clearAllMocks()

		// Setup mock stream with usage information
		mockStream = (async function* () {
			yield { type: "text" as const, text: "This is " }
			yield { type: "text" as const, text: "a summary" }
			yield { type: "usage" as const, totalCost: 0.05, outputTokens: 150 }
		})()

		// Setup mock API handler
		mockApiHandler = {
			createMessage: vi.fn().mockReturnValue(mockStream),
			countTokens: vi.fn().mockImplementation(() => Promise.resolve(100)),
			getModel: vi.fn().mockReturnValue({
				id: "test-model",
				info: {
					contextWindow: 8000,
					supportsImages: true,
					supportsVision: true,
					maxTokens: 4000,
					supportsPromptCache: true,
					maxCachePoints: 10,
					minTokensPerCachePoint: 100,
					cachableFields: ["system", "messages"],
				},
			}),
		} as unknown as ApiHandler
	})

	// Default system prompt for tests
	const defaultSystemPrompt = "You are a helpful assistant."

	it("should not summarize when there are not enough messages", async () => {
		const messages: ApiMessage[] = [{ type: "message", role: "user", content: "Hello", ts: 1 }]

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})
		expect(result.messages).toEqual(messages)
		expect(result.cost).toBe(0)
		expect(result.summary).toBe("")
		expect(result.newContextTokens).toBeUndefined()
		expect(result.error).toBeTruthy() // Error should be set for not enough messages
		expect(mockApiHandler.createMessage).not.toHaveBeenCalled()
	})

	it("should create summary with user role (fresh start model)", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "What's new?", ts: 5 },
			{ type: "message", role: "assistant", content: "Not much", ts: 6 },
			{ type: "message", role: "user", content: "Tell me more", ts: 7 },
		]

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		// Check that the API was called correctly
		expect(mockApiHandler.createMessage).toHaveBeenCalled()
		expect(maybeRemoveImageBlocks).toHaveBeenCalled()

		// Result contains all original messages (tagged) plus summary at end
		expect(result.messages.length).toBe(messages.length + 1)

		// All original messages should be tagged with condenseParent
		const summaryMessage = result.messages.find((m) => m.isSummary)
		expect(summaryMessage).toBeDefined()
		const condenseId = summaryMessage!.condenseId
		expect(condenseId).toBeDefined()
		for (const msg of result.messages.filter((m) => !m.isSummary)) {
			expect(asMsg(msg).condenseParent).toBe(condenseId)
		}

		// Summary message is a user message with just text (fresh start model).
		// item 列では message の content は文字列（summaryParts.join("\n\n")）。
		expect(asMsg(summaryMessage!).role).toBe("user")
		const content = asMsg(summaryMessage!).content as string
		expect(typeof content).toBe("string")
		expect(content).toContain("## Conversation Summary")
		expect(content).toContain("This is a summary")

		// Fresh start: effective API history should contain only the summary
		const effectiveHistory = getEffectiveApiHistory(result.messages)
		expect(effectiveHistory).toHaveLength(1)
		expect(asMsg(effectiveHistory[0]).isSummary).toBe(true)
		expect(asMsg(effectiveHistory[0]).role).toBe("user")

		// Check the cost and token counts
		expect(result.cost).toBe(0.05)
		expect(result.summary).toBe("This is a summary")
		// newContextTokens = countTokens(systemPrompt + summaryMessage) - counts actual content, not outputTokens
		expect(result.newContextTokens).toBe(100) // countTokens mock returns 100
		expect(result.error).toBeUndefined()
	})

	it("should preserve command blocks from first message in summary", async () => {
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "user",
				content: 'Hello <command name="prr">/prr #123</command>',
				ts: 1,
			},
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "What's new?", ts: 5 },
		]

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		const summaryMessage = result.messages.find((m) => m.isSummary)
		expect(summaryMessage).toBeDefined()

		// 旧: ブロック配列。item 列ではパートを "\n\n" で連結した 1 本の文字列。
		const content = asMsg(summaryMessage!).content as string
		expect(typeof content).toBe("string")
		const parts = content.split("\n\n")
		expect(parts[0]).toContain("## Conversation Summary")
		expect(content).toContain("<system-reminder>")
		expect(content).toContain("Active Workflows")
		expect(content).toContain('<command name="prr">')
	})

	it("should not include command blocks wrapper when no commands in first message", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "What's new?", ts: 5 },
		]

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		const summaryMessage = result.messages.find((m) => m.isSummary)
		expect(summaryMessage).toBeDefined()

		const content = asMsg(summaryMessage!).content as string
		expect(content).not.toContain("<system-reminder>")
		expect(content).not.toContain("Active Workflows")
	})

	it("should handle empty summary response and return error", async () => {
		// We need enough messages to trigger summarization
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "What's new?", ts: 5 },
			{ type: "message", role: "assistant", content: "Not much", ts: 6 },
			{ type: "message", role: "user", content: "Tell me more", ts: 7 },
		]

		// Setup empty summary response with usage information
		const emptyStream = (async function* () {
			yield { type: "text" as const, text: "" }
			yield { type: "usage" as const, totalCost: 0.02, outputTokens: 0 }
		})()

		// Create a new mock for createMessage that returns empty stream
		const createMessageMock = vi.fn().mockReturnValue(emptyStream)
		mockApiHandler.createMessage = createMessageMock as any

		// item 列では role/content だけを抜き出せない（function_call 等は role を持たない）ので、
		// 既定モックと同じく素通しさせる。
		;(maybeRemoveImageBlocks as Mock).mockImplementationOnce((messages: ApiMessage[]) => [...messages])

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		// Should return original messages when summary is empty
		expect(result.messages).toEqual(messages)
		expect(result.cost).toBe(0.02)
		expect(result.summary).toBe("")
		expect(result.error).toBeTruthy() // Error should be set
		expect(result.newContextTokens).toBeUndefined()
	})

	it("should correctly format the request to the API", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "What's new?", ts: 5 },
			{ type: "message", role: "assistant", content: "Not much", ts: 6 },
			{ type: "message", role: "user", content: "Tell me more", ts: 7 },
		]

		await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		// Verify that createMessage was called with the SUMMARY_PROMPT (which contains CRITICAL instructions), messages array, and optional metadata
		expect(mockApiHandler.createMessage).toHaveBeenCalledWith(
			expect.stringContaining("You are a helpful AI assistant tasked with summarizing conversations."),
			expect.any(Array),
			undefined, // metadata is undefined when not passed to summarizeConversation
		)
		// Verify the CRITICAL instructions are included in the prompt
		const actualPrompt = (mockApiHandler.createMessage as Mock).mock.calls[0][0]
		expect(actualPrompt).toContain("CRITICAL: This is a summarization-only request")
		expect(actualPrompt).toContain("CRITICAL: This summarization request is a SYSTEM OPERATION")

		// Check that maybeRemoveImageBlocks was called with the correct messages
		// The final request message now contains the detailed CONDENSE instructions
		const mockCallArgs = (maybeRemoveImageBlocks as Mock).mock.calls[0][0] as any[]
		const finalMessage = mockCallArgs[mockCallArgs.length - 1]
		expect(asMsg(finalMessage).role).toBe("user")
		expect(asMsg(finalMessage).content).toContain("Your task is to create a detailed summary of the conversation")
	})

	it("should include the original first user message in summarization input", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Initial ask", ts: 1 },
			{ type: "message", role: "assistant", content: "Ack", ts: 2 },
			{ type: "message", role: "user", content: "Follow-up", ts: 3 },
			{ type: "message", role: "assistant", content: "Response", ts: 4 },
			{ type: "message", role: "user", content: "More", ts: 5 },
			{ type: "message", role: "assistant", content: "Later", ts: 6 },
			{ type: "message", role: "user", content: "Newest", ts: 7 },
		]

		await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		const mockCallArgs = (maybeRemoveImageBlocks as Mock).mock.calls[0][0] as any[]

		// Expect the original first user message to be present in the messages sent to the summarizer
		const hasInitialAsk = mockCallArgs.some(
			(m) =>
				m.type === "message" &&
				m.role === "user" &&
				(typeof m.content === "string"
					? m.content === "Initial ask"
					: Array.isArray(m.content) &&
						m.content.some((b: any) => b.type === "input_text" && b.text === "Initial ask")),
		)
		expect(hasInitialAsk).toBe(true)
	})

	it("should calculate newContextTokens correctly with systemPrompt", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "What's new?", ts: 5 },
			{ type: "message", role: "assistant", content: "Not much", ts: 6 },
			{ type: "message", role: "user", content: "Tell me more", ts: 7 },
		]

		const systemPrompt = "You are a helpful assistant."

		// Create a stream with usage information
		const streamWithUsage = (async function* () {
			yield { type: "text" as const, text: "This is a summary with system prompt" }
			yield { type: "usage" as const, totalCost: 0.06, outputTokens: 200 }
		})()

		// Override the mock for this test
		mockApiHandler.createMessage = vi.fn().mockReturnValue(streamWithUsage) as any

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt,
			taskId,
		})

		// Verify that countTokens was called with system prompt + summary message
		expect(mockApiHandler.countTokens).toHaveBeenCalled()

		// newContextTokens = countTokens(systemPrompt + summaryMessage) - counts actual content
		expect(result.newContextTokens).toBe(100) // countTokens mock returns 100
		expect(result.cost).toBe(0.06)
		expect(result.summary).toBe("This is a summary with system prompt")
		expect(result.error).toBeUndefined()
	})

	it("should successfully summarize conversation", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "What's new?", ts: 5 },
			{ type: "message", role: "assistant", content: "Not much", ts: 6 },
			{ type: "message", role: "user", content: "Tell me more", ts: 7 },
		]

		// Create a stream that produces a summary with reasonable token count
		const streamWithSmallTokens = (async function* () {
			yield { type: "text" as const, text: "Concise summary" }
			yield { type: "usage" as const, totalCost: 0.03, outputTokens: 50 }
		})()

		// Override the mock for this test
		mockApiHandler.createMessage = vi.fn().mockReturnValue(streamWithSmallTokens) as any

		// Mock countTokens to return a small value
		mockApiHandler.countTokens = vi.fn().mockImplementation(() => Promise.resolve(30)) as any

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		// Result contains all messages plus summary
		expect(result.messages.length).toBe(messages.length + 1)

		// Fresh start: effective history should contain only the summary
		const effectiveHistory = getEffectiveApiHistory(result.messages)
		expect(effectiveHistory.length).toBe(1)
		expect(asMsg(effectiveHistory[0]).isSummary).toBe(true)

		expect(result.cost).toBe(0.03)
		expect(result.summary).toBe("Concise summary")
		expect(result.error).toBeUndefined()
		// newContextTokens = countTokens(systemPrompt + summaryMessage) - counts actual content
		expect(result.newContextTokens).toBe(30) // countTokens mock returns 30
	})

	it("should return error when API handler is invalid", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "What's new?", ts: 5 },
			{ type: "message", role: "assistant", content: "Not much", ts: 6 },
			{ type: "message", role: "user", content: "Tell me more", ts: 7 },
		]

		// Create invalid handler (missing createMessage)
		const invalidHandler = {
			countTokens: vi.fn(),
			getModel: vi.fn(),
			// createMessage is missing
		} as unknown as ApiHandler

		// Mock console.error to verify error message
		const originalError = console.error
		const mockError = vi.fn()
		console.error = mockError

		const result = await summarizeConversation({
			messages,
			apiHandler: invalidHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		// Should return original messages when handler is invalid
		expect(result.messages).toEqual(messages)
		expect(result.cost).toBe(0)
		expect(result.summary).toBe("")
		expect(result.error).toBeTruthy() // Error should be set
		expect(result.newContextTokens).toBeUndefined()

		// Verify error was logged
		expect(mockError).toHaveBeenCalledWith(expect.stringContaining("API handler is invalid for condensing"))

		// Restore console.error
		console.error = originalError
	})

	it("should tag all messages with condenseParent (fresh start model)", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "Thanks", ts: 5 },
		]

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		const summaryMessage = result.messages.find((m) => m.isSummary)
		expect(summaryMessage).toBeDefined()
		const condenseId = summaryMessage!.condenseId

		// ALL original messages should be tagged (fresh start model tags everything)
		for (const msg of result.messages.filter((m) => !m.isSummary)) {
			expect(asMsg(msg).condenseParent).toBe(condenseId)
		}
	})

	it("should place summary message at end of messages array", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
			{ type: "message", role: "user", content: "How are you?", ts: 3 },
			{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
			{ type: "message", role: "user", content: "Thanks", ts: 5 },
		]

		const result = await summarizeConversation({
			messages,
			apiHandler: mockApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId,
		})

		// Summary should be the last message
		const lastMessage = result.messages[result.messages.length - 1]
		expect(asMsg(lastMessage).isSummary).toBe(true)
		expect(asMsg(lastMessage).role).toBe("user")
	})
})

describe("summarizeConversation with custom settings", () => {
	// Mock necessary dependencies
	let mockMainApiHandler: ApiHandler
	const defaultSystemPrompt = "Default prompt"
	const localTaskId = "test-task"

	// Sample messages for testing
	const sampleMessages: ApiMessage[] = [
		{ type: "message", role: "user", content: "Hello", ts: 1 },
		{ type: "message", role: "assistant", content: "Hi there", ts: 2 },
		{ type: "message", role: "user", content: "How are you?", ts: 3 },
		{ type: "message", role: "assistant", content: "I'm good", ts: 4 },
		{ type: "message", role: "user", content: "What's new?", ts: 5 },
		{ type: "message", role: "assistant", content: "Not much", ts: 6 },
		{ type: "message", role: "user", content: "Tell me more", ts: 7 },
	]

	beforeEach(() => {
		// Reset mocks
		vi.clearAllMocks()

		// Setup mock API handler
		mockMainApiHandler = {
			createMessage: vi.fn().mockImplementation(() => {
				return (async function* () {
					yield { type: "text" as const, text: "Summary from main handler" }
					yield { type: "usage" as const, totalCost: 0.05, outputTokens: 100 }
				})()
			}),
			countTokens: vi.fn().mockImplementation(() => Promise.resolve(50)),
			getModel: vi.fn().mockReturnValue({
				id: "main-model",
				info: {
					contextWindow: 8000,
					supportsImages: true,
					supportsVision: true,
					maxTokens: 4000,
					supportsPromptCache: true,
					maxCachePoints: 10,
					minTokensPerCachePoint: 100,
					cachableFields: ["system", "messages"],
				},
			}),
		} as unknown as ApiHandler
	})

	/**
	 * Test that custom prompt is used when provided
	 */
	it("should use custom prompt when provided", async () => {
		const customPrompt = "Custom summarization prompt"

		await summarizeConversation({
			messages: sampleMessages,
			apiHandler: mockMainApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId: localTaskId,
			isAutomaticTrigger: false,
			customCondensingPrompt: customPrompt,
		})

		// Verify the custom prompt was used in the user message content
		const createMessageCalls = (mockMainApiHandler.createMessage as Mock).mock.calls
		expect(createMessageCalls.length).toBe(1)
		// The custom prompt should be in the last message (the finalRequestMessage)
		const requestMessages = createMessageCalls[0][1]
		const lastMessage = requestMessages[requestMessages.length - 1]
		expect(asMsg(lastMessage).role).toBe("user")
		expect(asMsg(lastMessage).content).toBe(customPrompt)
	})

	/**
	 * Test that default system prompt is used when custom prompt is empty
	 */
	it("should use default systemPrompt when custom prompt is empty or not provided", async () => {
		// Test with empty string
		await summarizeConversation({
			messages: sampleMessages,
			apiHandler: mockMainApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId: localTaskId,
			isAutomaticTrigger: false,
			customCondensingPrompt: "  ",
		})

		// Verify the default SUMMARY_PROMPT was used (contains CRITICAL instructions)
		let createMessageCalls = (mockMainApiHandler.createMessage as Mock).mock.calls
		expect(createMessageCalls.length).toBe(1)
		expect(createMessageCalls[0][0]).toContain(
			"You are a helpful AI assistant tasked with summarizing conversations.",
		)
		expect(createMessageCalls[0][0]).toContain("CRITICAL: This is a summarization-only request")

		// Reset mock and test with undefined
		vi.clearAllMocks()
		await summarizeConversation({
			messages: sampleMessages,
			apiHandler: mockMainApiHandler,
			systemPrompt: defaultSystemPrompt,
			taskId: localTaskId,
			isAutomaticTrigger: false,
		})

		// Verify the default SUMMARY_PROMPT was used again (contains CRITICAL instructions)
		createMessageCalls = (mockMainApiHandler.createMessage as Mock).mock.calls
		expect(createMessageCalls.length).toBe(1)
		expect(createMessageCalls[0][0]).toContain(
			"You are a helpful AI assistant tasked with summarizing conversations.",
		)
		expect(createMessageCalls[0][0]).toContain("CRITICAL: This is a summarization-only request")
	})
})

describe("transformMessagesForCondensing", () => {
	it("should flatten tool items into text message items", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello" },
			{
				type: "function_call",
				call_id: "tool-1",
				name: "read_file",
				arguments: JSON.stringify({ path: "test.ts" }),
			},
			{ type: "function_call_output", call_id: "tool-1", output: "file contents" },
		]

		const result = transformMessagesForCondensing(messages)

		expect(result).toHaveLength(3)
		// message item はそのまま素通し
		expect(result[0]).toEqual(messages[0])
		// function_call → assistant のテキスト message
		expect(asMsg(result[1]).type).toBe("message")
		expect(asMsg(result[1]).role).toBe("assistant")
		expect(asMsg(result[1]).content).toContain("[Tool Call: read_file]")
		expect(asMsg(result[1]).content).toContain('{"path":"test.ts"}')
		// function_call_output → user のテキスト message
		expect(asMsg(result[2]).type).toBe("message")
		expect(asMsg(result[2]).role).toBe("user")
		expect(asMsg(result[2]).content).toContain("[Tool Result]")
		expect(asMsg(result[2]).content).toContain("file contents")
	})

	it("should preserve the ts of the converted tool items", () => {
		const messages: ApiMessage[] = [
			{
				type: "function_call",
				call_id: "tool-1",
				name: "execute",
				arguments: JSON.stringify({ cmd: "ls" }),
				ts: 42,
			},
			{ type: "function_call_output", call_id: "tool-1", output: "a.ts", ts: 43 },
		]

		const result = transformMessagesForCondensing(messages)

		expect(asMsg(result[0]).role).toBe("assistant")
		expect(result[0].ts).toBe(42)
		expect(asMsg(result[1]).role).toBe("user")
		expect(result[1].ts).toBe(43)
	})

	it("should handle empty messages array", () => {
		const result = transformMessagesForCondensing([])

		expect(result).toEqual([])
	})

	it("should not mutate original messages", () => {
		const messages: ApiMessage[] = [
			{
				type: "function_call",
				call_id: "tool-1",
				name: "read_file",
				arguments: JSON.stringify({ path: "test.ts" }),
			},
		]

		transformMessagesForCondensing(messages)

		// Original should still be a function_call item
		expect(messages[0].type).toBe("function_call")
	})
})

/** テスト用: item を message item として narrow する（型アサーションのみ）。 */
function asMsg(item: unknown): { role: string; content: any; [k: string]: any } {
	return item as { role: string; content: any; [k: string]: any }
}
