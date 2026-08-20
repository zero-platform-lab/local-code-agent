import { describe, it, expect } from "vitest"
import { ApiMessage } from "../../task-persistence/apiMessages"
import { isMessageItem, itemText, type MessageItem } from "../../task-persistence/agentMessageUtils"
import { getEffectiveApiHistory, getMessagesSinceLastSummary } from "../index"

describe("nested condensing scenarios", () => {
	describe("fresh-start model (user-role summaries)", () => {
		it("should return only the latest summary and messages after it", () => {
			const condenseId1 = "condense-1"
			const condenseId2 = "condense-2"

			// Simulate history after two nested condenses with user-role summaries
			const history: ApiMessage[] = [
				// Original task - condensed in first condense
				{ type: "message", role: "user", content: "Build an app", ts: 100, condenseParent: condenseId1 },
				// Messages from first condense
				{ type: "message", role: "assistant", content: "Starting...", ts: 200, condenseParent: condenseId1 },
				{ type: "message", role: "user", content: "Add auth", ts: 300, condenseParent: condenseId1 },
				// First summary (user role, fresh-start model) - then condensed in second condense
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "## Summary 1" }],
					ts: 399,
					isSummary: true,
					condenseId: condenseId1,
					condenseParent: condenseId2, // Tagged during second condense
				},
				// Messages after first condense but before second
				{ type: "message", role: "assistant", content: "Auth added", ts: 400, condenseParent: condenseId2 },
				{ type: "message", role: "user", content: "Add database", ts: 500, condenseParent: condenseId2 },
				// Second summary (user role, fresh-start model)
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "## Summary 2" }],
					ts: 599,
					isSummary: true,
					condenseId: condenseId2,
				},
				// Messages after second condense (kept messages)
				{ type: "message", role: "assistant", content: "Database added", ts: 600 },
				{ type: "message", role: "user", content: "Now test it", ts: 700 },
			]

			// Step 1: Get effective history
			const effectiveHistory = getEffectiveApiHistory(history)

			// Should only contain: Summary2, and messages after it
			expect(effectiveHistory.length).toBe(3)
			expect(asMsg(effectiveHistory[0]).isSummary).toBe(true)
			expect(asMsg(effectiveHistory[0]).condenseId).toBe(condenseId2) // Latest summary
			expect(asMsg(effectiveHistory[1]).content).toBe("Database added")
			expect(asMsg(effectiveHistory[2]).content).toBe("Now test it")

			// Verify NO condensed messages are included
			const hasCondensedMessages = effectiveHistory.some(
				(msg) => msg.condenseParent && history.some((m) => m.isSummary && m.condenseId === msg.condenseParent),
			)
			expect(hasCondensedMessages).toBe(false)

			// Step 2: Get messages since last summary (on effective history)
			const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)

			// Should be the same as effective history since Summary2 is already at the start
			expect(messagesSinceLastSummary.length).toBe(3)
			expect(asMsg(messagesSinceLastSummary[0]).isSummary).toBe(true)
			expect(asMsg(messagesSinceLastSummary[0]).condenseId).toBe(condenseId2)

			// CRITICAL: No previous history (Summary1 or original task) should be included
			const hasSummary1 = messagesSinceLastSummary.some((m) => m.condenseId === condenseId1)
			expect(hasSummary1).toBe(false)

			const hasOriginalTask = messagesSinceLastSummary.some((m) => itemText(m) === "Build an app")
			expect(hasOriginalTask).toBe(false)
		})

		it("should handle triple nested condense correctly", () => {
			const condenseId1 = "condense-1"
			const condenseId2 = "condense-2"
			const condenseId3 = "condense-3"

			const history: ApiMessage[] = [
				// First condense content
				{ type: "message", role: "user", content: "Task", ts: 100, condenseParent: condenseId1 },
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "## Summary 1" }],
					ts: 199,
					isSummary: true,
					condenseId: condenseId1,
					condenseParent: condenseId2,
				},
				// Second condense content
				{ type: "message", role: "assistant", content: "After S1", ts: 200, condenseParent: condenseId2 },
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "## Summary 2" }],
					ts: 299,
					isSummary: true,
					condenseId: condenseId2,
					condenseParent: condenseId3,
				},
				// Third condense content
				{ type: "message", role: "assistant", content: "After S2", ts: 300, condenseParent: condenseId3 },
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "## Summary 3" }],
					ts: 399,
					isSummary: true,
					condenseId: condenseId3,
				},
				// Current messages
				{ type: "message", role: "assistant", content: "Current work", ts: 400 },
			]

			const effectiveHistory = getEffectiveApiHistory(history)

			// Should only contain Summary3 and current work
			expect(effectiveHistory.length).toBe(2)
			expect(asMsg(effectiveHistory[0]).condenseId).toBe(condenseId3)
			expect(asMsg(effectiveHistory[1]).content).toBe("Current work")

			const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
			expect(messagesSinceLastSummary.length).toBe(2)

			// No previous summaries should be included
			const hasPreviousSummaries = messagesSinceLastSummary.some(
				(m) => m.condenseId === condenseId1 || m.condenseId === condenseId2,
			)
			expect(hasPreviousSummaries).toBe(false)
		})
	})

	describe("getMessagesSinceLastSummary behavior with full vs effective history", () => {
		it("should return consistent results when called with full history vs effective history", () => {
			const condenseId = "condense-1"

			const fullHistory: ApiMessage[] = [
				{ type: "message", role: "user", content: "Original task", ts: 100, condenseParent: condenseId },
				{ type: "message", role: "assistant", content: "Response", ts: 200, condenseParent: condenseId },
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Summary" }],
					ts: 299,
					isSummary: true,
					condenseId,
				},
				{ type: "message", role: "assistant", content: "After summary", ts: 300 },
			]

			// Called with FULL history (as in summarizeConversation)
			const fromFullHistory = getMessagesSinceLastSummary(fullHistory)

			// Called with EFFECTIVE history (as in attemptApiRequest)
			const effectiveHistory = getEffectiveApiHistory(fullHistory)
			const fromEffectiveHistory = getMessagesSinceLastSummary(effectiveHistory)

			// Both should return the same messages when summary is user role
			expect(fromFullHistory.length).toBe(fromEffectiveHistory.length)

			// Both should start with the summary
			expect(asMsg(fromFullHistory[0]).isSummary).toBe(true)
			expect(asMsg(fromEffectiveHistory[0]).isSummary).toBe(true)
		})

		it("should not include condensed original task in effective history", () => {
			const condenseId1 = "condense-1"
			const condenseId2 = "condense-2"

			// Scenario: Two nested condenses with user-role summaries
			const fullHistory: ApiMessage[] = [
				{
					type: "message",
					role: "user",
					content: "Original task - should NOT appear",
					ts: 100,
					condenseParent: condenseId1,
				},
				{ type: "message", role: "assistant", content: "Old response", ts: 200, condenseParent: condenseId1 },
				// First summary (user role, fresh-start model), then condensed again
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Summary 1" }],
					ts: 299,
					isSummary: true,
					condenseId: condenseId1,
					condenseParent: condenseId2,
				},
				{ type: "message", role: "assistant", content: "After S1", ts: 300, condenseParent: condenseId2 },
				// Second summary (user role, fresh-start model)
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Summary 2" }],
					ts: 399,
					isSummary: true,
					condenseId: condenseId2,
				},
				{ type: "message", role: "assistant", content: "Current message", ts: 400 },
			]

			const effectiveHistory = getEffectiveApiHistory(fullHistory)
			expect(effectiveHistory.length).toBe(2) // Summary2 + Current message

			const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)

			// The original task should NOT be included
			const hasOriginalTask = messagesSinceLastSummary.some((m) => itemText(m).includes("Original task"))
			expect(hasOriginalTask).toBe(false)

			// Summary1 should not be included (it was condensed)
			const hasSummary1 = messagesSinceLastSummary.some((m) => m.condenseId === condenseId1)
			expect(hasSummary1).toBe(false)
		})
	})
})

/** テスト用: message item であることを実際に検証しつつ narrow する。 */
function asMsg(item: ApiMessage | undefined): MessageItem {
	if (!isMessageItem(item)) {
		throw new Error(`expected a message item, got ${item?.type ?? "undefined"}`)
	}
	return item
}
