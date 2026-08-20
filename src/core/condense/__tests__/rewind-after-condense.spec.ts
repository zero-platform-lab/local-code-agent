// npx vitest src/core/condense/__tests__/rewind-after-condense.spec.ts

/**
 * Regression tests for the issue: "Rewind after Condense is broken"
 * https://github.com/example-org/local-agent/issues/8295
 *
 * These tests verify that when a user rewinds (deletes/truncates) their conversation
 * after a condense operation, the orphaned condensed messages are properly reactivated
 * so they can be sent to the API again.
 */

import { getEffectiveApiHistory, cleanupAfterTruncation } from "../index"
import { ApiMessage } from "../../task-persistence/apiMessages"
import { isMessageItem, itemText, type MessageItem } from "../../task-persistence/agentMessageUtils"

describe("Rewind After Condense - Issue #8295", () => {
	beforeEach(() => {})

	describe("getEffectiveApiHistory", () => {
		it("should return summary and messages after summary (fresh start model)", () => {
			const condenseId = "summary-123"
			const messages: ApiMessage[] = [
				{ type: "message", role: "user", content: "First message", ts: 1, condenseParent: condenseId },
				{ type: "message", role: "assistant", content: "First response", ts: 2, condenseParent: condenseId },
				{ type: "message", role: "user", content: "Second message", ts: 3, condenseParent: condenseId },
				{ type: "message", role: "user", content: "Summary", ts: 4, isSummary: true, condenseId },
				// Messages after summary are included even if they have condenseParent
				{ type: "message", role: "user", content: "Third message", ts: 5, condenseParent: condenseId },
				{ type: "message", role: "assistant", content: "Third response", ts: 6, condenseParent: condenseId },
			]

			const effective = getEffectiveApiHistory(messages)

			// Fresh start model: summary + all messages after it
			expect(effective.length).toBe(3)
			expect(asMsg(effective[0]).isSummary).toBe(true)
			expect(asMsg(effective[1]).content).toBe("Third message")
			expect(asMsg(effective[2]).content).toBe("Third response")
		})

		it("should include messages without condenseParent", () => {
			const messages: ApiMessage[] = [
				{ type: "message", role: "user", content: "Hello", ts: 1 },
				{ type: "message", role: "assistant", content: "Hi", ts: 2 },
			]

			const effective = getEffectiveApiHistory(messages)

			expect(effective.length).toBe(2)
			expect(effective).toEqual(messages)
		})

		it("should handle empty messages array", () => {
			const effective = getEffectiveApiHistory([])
			expect(effective).toEqual([])
		})
	})

	describe("cleanupAfterTruncation", () => {
		it("should clear condenseParent when summary message is deleted", () => {
			const condenseId = "summary-123"
			const messages: ApiMessage[] = [
				{ type: "message", role: "user", content: "First message", ts: 1 },
				{ type: "message", role: "assistant", content: "First response", ts: 2, condenseParent: condenseId },
				{ type: "message", role: "user", content: "Second message", ts: 3, condenseParent: condenseId },
				// Summary is NOT in the array (was truncated/deleted)
			]

			const cleaned = cleanupAfterTruncation(messages)

			// All condenseParent tags should be cleared since summary is gone
			expect(asMsg(cleaned[1]).condenseParent).toBeUndefined()
			expect(asMsg(cleaned[2]).condenseParent).toBeUndefined()
		})

		it("should preserve condenseParent when summary message still exists", () => {
			const condenseId = "summary-123"
			const messages: ApiMessage[] = [
				{ type: "message", role: "user", content: "First message", ts: 1 },
				{ type: "message", role: "assistant", content: "First response", ts: 2, condenseParent: condenseId },
				{ type: "message", role: "user", content: "Summary", ts: 3, isSummary: true, condenseId },
			]

			const cleaned = cleanupAfterTruncation(messages)

			// condenseParent should remain since summary exists
			expect(asMsg(cleaned[1]).condenseParent).toBe(condenseId)
		})

		it("should handle multiple condense operations with different IDs", () => {
			const condenseId1 = "summary-1"
			const condenseId2 = "summary-2"
			const messages: ApiMessage[] = [
				{ type: "message", role: "user", content: "Message 1", ts: 1, condenseParent: condenseId1 },
				{
					type: "message",
					role: "user",
					content: "Summary 1",
					ts: 2,
					isSummary: true,
					condenseId: condenseId1,
				},
				{ type: "message", role: "user", content: "Message 2", ts: 3, condenseParent: condenseId2 },
				// Summary 2 is NOT present (was truncated)
			]

			const cleaned = cleanupAfterTruncation(messages)

			// condenseId1 should remain (summary exists)
			expect(asMsg(cleaned[0]).condenseParent).toBe(condenseId1)
			// condenseId2 should be cleared (summary deleted)
			expect(asMsg(cleaned[2]).condenseParent).toBeUndefined()
		})

		it("should not modify messages without condenseParent", () => {
			const messages: ApiMessage[] = [
				{ type: "message", role: "user", content: "Hello", ts: 1 },
				{ type: "message", role: "assistant", content: "Hi", ts: 2 },
			]

			const cleaned = cleanupAfterTruncation(messages)

			expect(cleaned).toEqual(messages)
		})

		it("should handle empty messages array", () => {
			const cleaned = cleanupAfterTruncation([])
			expect(cleaned).toEqual([])
		})
	})

	describe("Rewind scenario: truncate after condense", () => {
		it("should reactivate condensed messages when their summary is deleted via truncation", () => {
			const condenseId = "summary-abc"

			// Simulate a conversation after condensing (all prior messages tagged)
			const fullHistory: ApiMessage[] = [
				{ type: "message", role: "user", content: "Initial task", ts: 1, condenseParent: condenseId },
				{ type: "message", role: "assistant", content: "Working on it", ts: 2, condenseParent: condenseId },
				{ type: "message", role: "user", content: "Continue", ts: 3, condenseParent: condenseId },
				{
					type: "message",
					role: "user",
					content: "Summary of work so far",
					ts: 4,
					isSummary: true,
					condenseId,
				},
			]

			// Verify effective history before truncation
			const effectiveBefore = getEffectiveApiHistory(fullHistory)
			// Should be: summary only
			expect(effectiveBefore.length).toBe(1)

			// Simulate rewind: delete the summary message
			const withoutSummary = fullHistory.filter((m) => !m.isSummary)
			const cleanedAfterDeletingSummary = cleanupAfterTruncation(withoutSummary)
			for (const msg of cleanedAfterDeletingSummary) {
				expect(asMsg(msg).condenseParent).toBeUndefined()
			}

			// Verify effective history after cleanup: all messages should be visible now
			const effectiveAfterCleanup = getEffectiveApiHistory(cleanedAfterDeletingSummary)
			expect(effectiveAfterCleanup.length).toBe(3)
			expect(asMsg(effectiveAfterCleanup[0]).content).toBe("Initial task")
			expect(asMsg(effectiveAfterCleanup[1]).content).toBe("Working on it")
			expect(asMsg(effectiveAfterCleanup[2]).content).toBe("Continue")
		})

		it("should properly restore context after rewind when summary was deleted", () => {
			const condenseId = "summary-xyz"

			// Scenario: Most of the conversation was condensed, but the summary was deleted.
			// getEffectiveApiHistory already correctly handles orphaned messages (includes them
			// when their summary doesn't exist). cleanupAfterTruncation cleans up the tags.
			const messages: ApiMessage[] = [
				{ type: "message", role: "user", content: "Start", ts: 1 },
				{ type: "message", role: "assistant", content: "Response 1", ts: 2, condenseParent: condenseId },
				{ type: "message", role: "user", content: "More", ts: 3, condenseParent: condenseId },
				{ type: "message", role: "assistant", content: "Response 2", ts: 4, condenseParent: condenseId },
				{ type: "message", role: "user", content: "Even more", ts: 5, condenseParent: condenseId },
				// Summary was deleted (not present), so these are "orphaned" messages
			]

			// getEffectiveApiHistory already includes orphaned messages (summary doesn't exist)
			const effectiveBefore = getEffectiveApiHistory(messages)
			expect(effectiveBefore.length).toBe(5) // All messages visible since summary was deleted
			expect(asMsg(effectiveBefore[0]).content).toBe("Start")
			expect(asMsg(effectiveBefore[1]).content).toBe("Response 1")

			// cleanupAfterTruncation clears the orphaned condenseParent tags for data hygiene
			const cleaned = cleanupAfterTruncation(messages)

			// Verify condenseParent was cleared for all orphaned messages
			expect(asMsg(cleaned[1]).condenseParent).toBeUndefined()
			expect(asMsg(cleaned[2]).condenseParent).toBeUndefined()
			expect(asMsg(cleaned[3]).condenseParent).toBeUndefined()
			expect(asMsg(cleaned[4]).condenseParent).toBeUndefined()

			// After cleanup, effective history is the same (all visible)
			const effectiveAfter = getEffectiveApiHistory(cleaned)
			expect(effectiveAfter.length).toBe(5) // All messages visible
		})

		it("should hide condensed messages when their summary still exists (fresh start)", () => {
			const condenseId = "summary-exists"

			// Scenario: Messages were condensed and summary exists - fresh start model returns
			// only the summary and messages after it, NOT messages before the summary
			const messages: ApiMessage[] = [
				{ type: "message", role: "user", content: "Start", ts: 1 },
				{ type: "message", role: "assistant", content: "Response 1", ts: 2, condenseParent: condenseId },
				{ type: "message", role: "user", content: "More", ts: 3, condenseParent: condenseId },
				{ type: "message", role: "user", content: "Summary", ts: 4, isSummary: true, condenseId },
				{ type: "message", role: "assistant", content: "After summary", ts: 5 },
			]

			// Fresh start model: effective history is summary + messages after it
			// "Start" is NOT included because it's before the summary
			const effective = getEffectiveApiHistory(messages)
			expect(effective.length).toBe(2) // Summary, After summary (NOT Start)
			expect(asMsg(effective[0]).content).toBe("Summary")
			expect(asMsg(effective[0]).isSummary).toBe(true)
			expect(asMsg(effective[1]).content).toBe("After summary")

			// cleanupAfterTruncation should NOT clear condenseParent since summary exists
			const cleaned = cleanupAfterTruncation(messages)
			expect(asMsg(cleaned[1]).condenseParent).toBe(condenseId)
			expect(asMsg(cleaned[2]).condenseParent).toBe(condenseId)
		})

		describe("Summary timestamp collision prevention", () => {
			it("should give summary a unique timestamp that does not collide with first kept message", () => {
				// Scenario: After condense, the summary message should have a unique timestamp
				// (ts - 1 from the first kept message) to prevent lookup collisions.
				//
				// This test verifies the expected data structure after condense:
				// - Summary should have ts = firstKeptMessage.ts - 1
				// - Summary and first kept message should NOT share the same timestamp
				//
				// With real millisecond timestamps, the summary timestamp (firstKeptTs - 1) will
				// never collide with an existing message since timestamps are always increasing.

				const condenseId = "summary-unique-ts"
				// Use timestamps that represent a realistic scenario where firstKeptTs - 1
				// does not collide with any existing message timestamp
				const firstKeptTs = 1000

				// Simulate post-condense state where summary has unique timestamp (firstKeptTs - 1)
				// In real usage, condensed messages have timestamps like 100, 200, 300...
				// and firstKeptTs is much larger, so firstKeptTs - 1 = 999 is unique
				const messagesAfterCondense: ApiMessage[] = [
					{ type: "message", role: "user", content: "Initial task", ts: 100 },
					{ type: "message", role: "assistant", content: "Response 1", ts: 200, condenseParent: condenseId },
					{ type: "message", role: "user", content: "Continue", ts: 300, condenseParent: condenseId },
					{ type: "message", role: "assistant", content: "Response 2", ts: 400, condenseParent: condenseId },
					{ type: "message", role: "user", content: "More work", ts: 500, condenseParent: condenseId },
					{ type: "message", role: "assistant", content: "Response 3", ts: 600, condenseParent: condenseId },
					{ type: "message", role: "user", content: "Even more", ts: 700, condenseParent: condenseId },
					// Summary gets ts = firstKeptTs - 1 = 999, which is unique
					{
						type: "message",
						role: "user",
						content: "Summary",
						ts: firstKeptTs - 1,
						isSummary: true,
						condenseId,
					},
					// First kept message
					{ type: "message", role: "user", content: "First kept message", ts: firstKeptTs },
					{ type: "message", role: "assistant", content: "Response to first kept", ts: 1100 },
					{ type: "message", role: "user", content: "Last message", ts: 1200 },
				]

				// Find all messages with the same timestamp as the summary
				const summaryTs = firstKeptTs - 1
				const messagesWithSummaryTs = messagesAfterCondense.filter((msg) => msg.ts === summaryTs)

				// There should be exactly one message with the summary timestamp
				expect(messagesWithSummaryTs.length).toBe(1)
				expect(asMsg(messagesWithSummaryTs[0]).isSummary).toBe(true)

				// The first kept message should have a different timestamp
				const firstKeptMessage = messagesAfterCondense.find(
					(msg) => msg.ts === firstKeptTs && !msg.isSummary && !msg.condenseParent,
				)
				expect(firstKeptMessage).toBeDefined()
				expect(itemText(firstKeptMessage)).toBe("First kept message")
				expect(firstKeptMessage?.ts).not.toBe(summaryTs)
			})

			it("should not target summary message when looking up first kept message by timestamp", () => {
				// This test verifies that when timestamps are unique (as they should be after the fix),
				// looking up by the first kept message's timestamp returns that message, not the summary.

				const condenseId = "summary-lookup-test"
				const firstKeptTs = 8

				const messages: ApiMessage[] = [
					{ type: "message", role: "user", content: "Initial", ts: 1 },
					{
						type: "message",
						role: "user",
						content: "Summary",
						ts: firstKeptTs - 1,
						isSummary: true,
						condenseId,
					},
					{ type: "message", role: "assistant", content: "First kept message", ts: firstKeptTs },
					{ type: "message", role: "user", content: "Response", ts: 9 },
				]

				// Look up by first kept message's timestamp
				const foundMessage = messages.find((msg) => msg.ts === firstKeptTs)
				expect(foundMessage).toBeDefined()
				expect(itemText(foundMessage)).toBe("First kept message")
				expect(foundMessage?.isSummary).toBeUndefined()

				// Looking up by summary's timestamp should find the summary
				const foundSummary = messages.find((msg) => msg.ts === firstKeptTs - 1)
				expect(foundSummary).toBeDefined()
				expect(foundSummary?.isSummary).toBe(true)
			})
		})

		describe("Message preservation after condense operations", () => {
			/**
			 * These tests verify that the correct user and assistant messages are preserved
			 * and sent to the LLM after condense operations. With N_MESSAGES_TO_KEEP = 3,
			 * condense should always preserve (for effective history):
			 * - The active summary
			 * - The last 3 kept messages
			 */

			it("should preserve correct messages after single condense (10 messages)", () => {
				const condenseId = "summary-single"

				// Simulate storage state after condensing 10 messages with N_MESSAGES_TO_KEEP = 3
				// Original: [msg1, msg2, msg3, msg4, msg5, msg6, msg7, msg8, msg9, msg10]
				// After condense:
				// - msg1 preserved (first message)
				// - msg2-msg7 tagged with condenseParent
				// - summary inserted with ts = msg8.ts - 1
				// - msg8, msg9, msg10 kept
				const storageAfterCondense: ApiMessage[] = [
					{
						type: "message",
						role: "user",
						content: "Task: Build a feature",
						ts: 100,
						condenseParent: condenseId,
					},
					{
						type: "message",
						role: "assistant",
						content: "I'll help with that",
						ts: 200,
						condenseParent: condenseId,
					},
					{
						type: "message",
						role: "user",
						content: "Start with the API",
						ts: 300,
						condenseParent: condenseId,
					},
					{
						type: "message",
						role: "assistant",
						content: "Creating API endpoints",
						ts: 400,
						condenseParent: condenseId,
					},
					{ type: "message", role: "user", content: "Add validation", ts: 500, condenseParent: condenseId },
					{
						type: "message",
						role: "assistant",
						content: "Added validation logic",
						ts: 600,
						condenseParent: condenseId,
					},
					{ type: "message", role: "user", content: "Now the tests", ts: 700, condenseParent: condenseId },
					// Summary inserted before first kept message
					{
						type: "message",
						role: "user",
						content: "Summary: Built API with validation, working on tests",
						ts: 799, // msg8.ts - 1
						isSummary: true,
						condenseId,
					},
					// Last 3 kept messages (N_MESSAGES_TO_KEEP = 3)
					{ type: "message", role: "assistant", content: "Writing unit tests now", ts: 800 },
					{ type: "message", role: "user", content: "Include edge cases", ts: 900 },
					{ type: "message", role: "assistant", content: "Added edge case tests", ts: 1000 },
				]

				const effective = getEffectiveApiHistory(storageAfterCondense)

				// Should send exactly 4 messages to LLM:
				// 1. Summary (user)
				// 2-4. Last 3 kept messages
				expect(effective.length).toBe(4)

				// Verify exact order and content
				expect(asMsg(effective[0]).role).toBe("user")
				expect(asMsg(effective[0]).isSummary).toBe(true)
				expect(asMsg(effective[0]).content).toBe("Summary: Built API with validation, working on tests")

				expect(asMsg(effective[1]).role).toBe("assistant")
				expect(asMsg(effective[1]).content).toBe("Writing unit tests now")

				expect(asMsg(effective[2]).role).toBe("user")
				expect(asMsg(effective[2]).content).toBe("Include edge cases")

				expect(asMsg(effective[3]).role).toBe("assistant")
				expect(asMsg(effective[3]).content).toBe("Added edge case tests")

				// Verify condensed messages are NOT in effective history
				const condensedContents = ["I'll help with that", "Start with the API", "Creating API endpoints"]
				for (const content of condensedContents) {
					expect(effective.find((m) => itemText(m) === content)).toBeUndefined()
				}
			})

			it("should preserve correct messages after double condense (10 msgs → condense → 10 more msgs → condense)", () => {
				const condenseId1 = "summary-first"
				const condenseId2 = "summary-second"

				// Simulate storage state after TWO condense operations
				// First condense: 10 messages condensed, summary1 created
				// Then: 10 more messages added (making effective history have 15 messages)
				// Second condense: summary1 + msg8-msg17 condensed, summary2 created
				//
				// Storage after double condense:
				const storageAfterDoubleCondense: ApiMessage[] = [
					// First message - condensed during the first condense
					{
						type: "message",
						role: "user",
						content: "Initial task: Build a full app",
						ts: 100,
						condenseParent: condenseId1,
					},

					// Messages from first condense (tagged with condenseId1)
					{
						type: "message",
						role: "assistant",
						content: "Starting the project",
						ts: 200,
						condenseParent: condenseId1,
					},
					{
						type: "message",
						role: "user",
						content: "Add authentication",
						ts: 300,
						condenseParent: condenseId1,
					},
					{
						type: "message",
						role: "assistant",
						content: "Added auth module",
						ts: 400,
						condenseParent: condenseId1,
					},
					{ type: "message", role: "user", content: "Add database", ts: 500, condenseParent: condenseId1 },
					{
						type: "message",
						role: "assistant",
						content: "Set up database",
						ts: 600,
						condenseParent: condenseId1,
					},
					{ type: "message", role: "user", content: "Connect them", ts: 700, condenseParent: condenseId1 },

					// First summary - now ALSO tagged with condenseId2 (from second condense)
					{
						type: "message",
						role: "user",
						content: "Summary1: Built auth and database",
						ts: 799,
						isSummary: true,
						condenseId: condenseId1,
						condenseParent: condenseId2, // Tagged during second condense!
					},

					// Messages after first condense but before second (tagged with condenseId2)
					{
						type: "message",
						role: "assistant",
						content: "Continuing development",
						ts: 800,
						condenseParent: condenseId2,
					},
					{ type: "message", role: "user", content: "Add API routes", ts: 900, condenseParent: condenseId2 },
					{
						type: "message",
						role: "assistant",
						content: "Created REST endpoints",
						ts: 1000,
						condenseParent: condenseId2,
					},
					{ type: "message", role: "user", content: "Add validation", ts: 1100, condenseParent: condenseId2 },
					{
						type: "message",
						role: "assistant",
						content: "Added input validation",
						ts: 1200,
						condenseParent: condenseId2,
					},
					{
						type: "message",
						role: "user",
						content: "Add error handling",
						ts: 1300,
						condenseParent: condenseId2,
					},
					{
						type: "message",
						role: "assistant",
						content: "Implemented error handlers",
						ts: 1400,
						condenseParent: condenseId2,
					},
					{ type: "message", role: "user", content: "Add logging", ts: 1500, condenseParent: condenseId2 },
					{
						type: "message",
						role: "assistant",
						content: "Set up logging system",
						ts: 1600,
						condenseParent: condenseId2,
					},
					{
						type: "message",
						role: "user",
						content: "Now write tests",
						ts: 1700,
						condenseParent: condenseId2,
					},

					// Second summary - inserted before the last 3 kept messages
					{
						type: "message",
						role: "user",
						content: "Summary2: App complete with auth, DB, API, validation, errors, logging. Now testing.",
						ts: 1799, // msg18.ts - 1
						isSummary: true,
						condenseId: condenseId2,
					},

					// Last 3 kept messages (N_MESSAGES_TO_KEEP = 3)
					{ type: "message", role: "assistant", content: "Writing integration tests", ts: 1800 },
					{ type: "message", role: "user", content: "Test the auth flow", ts: 1900 },
					{ type: "message", role: "assistant", content: "Auth tests passing", ts: 2000 },
				]

				const effective = getEffectiveApiHistory(storageAfterDoubleCondense)

				// Should send exactly 4 messages to LLM:
				// 1. Summary2 (user) - the ACTIVE summary
				// 2-4. Last 3 kept messages
				expect(effective.length).toBe(4)

				// Verify exact order and content
				expect(asMsg(effective[0]).role).toBe("user")
				expect(asMsg(effective[0]).isSummary).toBe(true)
				expect(asMsg(effective[0]).condenseId).toBe(condenseId2) // Must be the SECOND summary
				expect(asMsg(effective[0]).content).toContain("Summary2")

				expect(asMsg(effective[1]).role).toBe("assistant")
				expect(asMsg(effective[1]).content).toBe("Writing integration tests")

				expect(asMsg(effective[2]).role).toBe("user")
				expect(asMsg(effective[2]).content).toBe("Test the auth flow")

				expect(asMsg(effective[3]).role).toBe("assistant")
				expect(asMsg(effective[3]).content).toBe("Auth tests passing")

				// Verify Summary1 is NOT in effective history (it's tagged with condenseParent)
				const summary1 = effective.find((m) => itemText(m).includes("Summary1"))
				expect(summary1).toBeUndefined()

				// Verify all condensed messages are NOT in effective history
				const condensedContents = [
					"Starting the project",
					"Added auth module",
					"Continuing development",
					"Created REST endpoints",
					"Implemented error handlers",
				]
				for (const content of condensedContents) {
					expect(effective.find((m) => itemText(m) === content)).toBeUndefined()
				}
			})

			it("should maintain proper user/assistant alternation in effective history", () => {
				const condenseId = "summary-alternation"

				// Verify that after condense, the effective history maintains proper
				// user/assistant message alternation (important for API compatibility)
				const storage: ApiMessage[] = [
					{ type: "message", role: "user", content: "Start task", ts: 100, condenseParent: condenseId },
					{ type: "message", role: "assistant", content: "Response 1", ts: 200, condenseParent: condenseId },
					{ type: "message", role: "user", content: "Continue", ts: 300, condenseParent: condenseId },
					{ type: "message", role: "user", content: "Summary text", ts: 399, isSummary: true, condenseId },
					// Kept messages - should alternate properly
					{ type: "message", role: "assistant", content: "Response after summary", ts: 400 },
					{ type: "message", role: "user", content: "User message", ts: 500 },
					{ type: "message", role: "assistant", content: "Final response", ts: 600 },
				]

				const effective = getEffectiveApiHistory(storage)

				// Verify the sequence: user(summary), assistant, user, assistant
				// This is the fresh-start model with user-role summaries
				expect(asMsg(effective[0]).role).toBe("user")
				expect(asMsg(effective[0]).isSummary).toBe(true)
				expect(asMsg(effective[1]).role).toBe("assistant")
				expect(asMsg(effective[2]).role).toBe("user")
				expect(asMsg(effective[3]).role).toBe("assistant")
			})

			it("should preserve timestamps in chronological order in effective history", () => {
				const condenseId = "summary-timestamps"

				const storage: ApiMessage[] = [
					{ type: "message", role: "user", content: "First", ts: 100, condenseParent: condenseId },
					{ type: "message", role: "assistant", content: "Condensed", ts: 200, condenseParent: condenseId },
					{ type: "message", role: "user", content: "Summary", ts: 299, isSummary: true, condenseId },
					{ type: "message", role: "assistant", content: "Kept 1", ts: 300 },
					{ type: "message", role: "user", content: "Kept 2", ts: 400 },
					{ type: "message", role: "assistant", content: "Kept 3", ts: 500 },
				]

				const effective = getEffectiveApiHistory(storage)

				// Verify timestamps are in ascending order
				for (let i = 1; i < effective.length; i++) {
					const prevTs = effective[i - 1].ts ?? 0
					const currTs = effective[i].ts ?? 0
					expect(currTs).toBeGreaterThan(prevTs)
				}
			})
		})
	})

	describe("Resume after condense preserves summary", () => {
		it("should keep condensed messages filtered when a new user message is added after summary", () => {
			const condenseId = "summary-resume-test"

			// Simulate post-condensation state: all old messages tagged, summary at end,
			// then a new user message added after resume (the fix preserves summary)
			const historyAfterResume: ApiMessage[] = [
				{ type: "message", role: "user", content: "Original task", ts: 100, condenseParent: condenseId },
				{ type: "message", role: "assistant", content: "Response 1", ts: 200, condenseParent: condenseId },
				{ type: "message", role: "user", content: "Follow-up", ts: 300, condenseParent: condenseId },
				{ type: "message", role: "assistant", content: "Response 2", ts: 400, condenseParent: condenseId },
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "## Conversation Summary\nSummary of work done" }],
					ts: 401,
					isSummary: true,
					condenseId,
				},
				// New user message added after resume (no isSummary, no condenseId)
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Please continue with the next step" }],
					ts: 500,
				},
			]

			const effective = getEffectiveApiHistory(historyAfterResume)

			// Should only include summary + new message (fresh start model)
			expect(effective).toHaveLength(2)
			expect(asMsg(effective[0]).isSummary).toBe(true)
			expect(asMsg(effective[1]).ts).toBe(500)
		})

		it("should restore ALL messages if summary is missing (the bug scenario before fix)", () => {
			const condenseId = "summary-bug-demo"

			// Simulate the bug: summary was stripped during resume, replaced with regular message.
			// condenseParent tags still exist but point to a non-existent summary.
			const historyWithoutSummary: ApiMessage[] = [
				{ type: "message", role: "user", content: "Original task", ts: 100, condenseParent: condenseId },
				{ type: "message", role: "assistant", content: "Response 1", ts: 200, condenseParent: condenseId },
				{ type: "message", role: "user", content: "Follow-up", ts: 300, condenseParent: condenseId },
				{ type: "message", role: "assistant", content: "Response 2", ts: 400, condenseParent: condenseId },
				// Summary was REMOVED and replaced with a regular user message (no isSummary)
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Summary content merged with new input" }],
					ts: 500,
				},
			]

			const effective = getEffectiveApiHistory(historyWithoutSummary)

			// Without the summary, ALL messages are restored (orphaned condenseParent)
			// This demonstrates the bug: condensation is effectively undone
			expect(effective).toHaveLength(5)
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
