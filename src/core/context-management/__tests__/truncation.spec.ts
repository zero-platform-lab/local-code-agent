import { describe, it, expect, beforeEach } from "vitest"
import { truncateConversation } from "../index"
import { getEffectiveApiHistory, cleanupAfterTruncation } from "../../condense"
import { ApiMessage } from "../../task-persistence/apiMessages"
import { itemRole, itemText } from "../../task-persistence/agentMessageUtils"

describe("Non-Destructive Sliding Window Truncation", () => {
	let messages: ApiMessage[]

	beforeEach(() => {
		// Create a sample conversation with 11 messages (1 initial + 10 conversation messages)
		messages = [
			{ type: "message", role: "user", content: "Initial task", ts: 1000 },
			{ type: "message", role: "assistant", content: "Response 1", ts: 1100 },
			{ type: "message", role: "user", content: "Message 2", ts: 1200 },
			{ type: "message", role: "assistant", content: "Response 2", ts: 1300 },
			{ type: "message", role: "user", content: "Message 3", ts: 1400 },
			{ type: "message", role: "assistant", content: "Response 3", ts: 1500 },
			{ type: "message", role: "user", content: "Message 4", ts: 1600 },
			{ type: "message", role: "assistant", content: "Response 4", ts: 1700 },
			{ type: "message", role: "user", content: "Message 5", ts: 1800 },
			{ type: "message", role: "assistant", content: "Response 5", ts: 1900 },
			{ type: "message", role: "user", content: "Message 6", ts: 2000 },
		]
	})

	describe("truncateConversation()", () => {
		it("should tag messages with truncationParent instead of deleting", () => {
			const result = truncateConversation(messages, 0.5, "test-task-id")

			// All messages should still be present plus the truncation marker
			expect(result.messages.length).toBe(messages.length + 1) // +1 for truncation marker

			// Calculate expected messages to remove: floor((11-1) * 0.5) = 5, rounded to even = 4
			const expectedMessagesToRemove = 4

			// Find which messages have truncationParent set
			const taggedMessages = result.messages.filter((msg) => msg.truncationParent)
			expect(taggedMessages.length).toBe(expectedMessagesToRemove)

			// All tagged messages should point to the truncationId
			for (const msg of taggedMessages) {
				expect(msg.truncationParent).toBe(result.truncationId)
			}

			// First message should not be tagged
			expect(result.messages[0].truncationParent).toBeUndefined()

			// Marker should not have truncationParent
			const marker = result.messages.find((msg) => msg.isTruncationMarker)
			expect(marker?.truncationParent).toBeUndefined()
		})

		it("should insert truncation marker with truncationId", () => {
			const result = truncateConversation(messages, 0.5, "test-task-id")

			// Truncation marker should be at the boundary (after truncated messages)
			// With 4 messages truncated (indices 1-4), marker should be at index 5
			const marker = result.messages.find((msg) => msg.isTruncationMarker)
			expect(marker).toBeDefined()
			expect(marker!.isTruncationMarker).toBe(true)
			expect(marker!.truncationId).toBeDefined()
			expect(marker!.truncationId).toBe(result.truncationId)
			expect(itemRole(marker)).toBe("user")
			expect(itemText(marker)).toContain("Sliding window truncation")

			// 時系列の不変条件: marker は「最後に隠したメッセージ」と「最初に残すメッセージ」の間に入る。
			// 4 件（ts 1100..1400）を隠すと、最初に残るのは ts 1500 のメッセージ。
			// marker.ts = firstKeptTs - 1 = 1499（残すメッセージの直前）でなければならない。
			const markerIndex = result.messages.findIndex((msg) => msg.isTruncationMarker)
			expect(marker!.ts).toBe(1499)
			// marker の直後のメッセージ（最初に残すメッセージ）の ts より前
			expect(marker!.ts!).toBeLessThan(result.messages[markerIndex + 1].ts!)
			// marker の直前（最後に隠したメッセージ ts=1400）より後
			expect(marker!.ts!).toBeGreaterThan(result.messages[markerIndex - 1].ts!)
		})

		it("should return truncationId and messagesRemoved", () => {
			const result = truncateConversation(messages, 0.5, "test-task-id")

			expect(result.truncationId).toBeDefined()
			expect(typeof result.truncationId).toBe("string")
			expect(result.messagesRemoved).toBe(4) // floor((11-1) * 0.5) rounded to even
		})

		it("should round messagesToRemove to an even number", () => {
			// Test with 12 messages (1 initial + 11 conversation)
			const manyMessages: ApiMessage[] = [
				{ type: "message", role: "user", content: "Initial", ts: 1000 },
				...Array.from(
					{ length: 11 },
					(_, i): ApiMessage => ({
						type: "message",
						role: i % 2 === 0 ? "assistant" : "user",
						content: `Message ${i + 1}`,
						ts: 1100 + i * 100,
					}),
				),
			]

			// fracToRemove=0.5 -> rawMessagesToRemove = floor(11 * 0.5) = 5
			// messagesToRemove = 5 - (5 % 2) = 4 (rounded down to even)
			const result = truncateConversation(manyMessages, 0.5, "test-task-id")
			expect(result.messagesRemoved).toBe(4)
		})
	})

	describe("getEffectiveApiHistory()", () => {
		it("should filter out truncated messages when truncation marker exists", () => {
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")
			const effective = getEffectiveApiHistory(truncationResult.messages)

			// Should exclude 4 truncated messages but keep the first message and truncation marker
			// Original: 11 messages
			// After truncation: 11 + 1 marker = 12
			// Effective: 11 - 4 (hidden) + 1 (marker) = 8
			expect(effective.length).toBe(8)

			// First message should be present
			expect(itemText(effective[0])).toBe("Initial task")

			// Truncation marker should be present
			expect(effective[1].isTruncationMarker).toBe(true)

			// Messages with truncationParent should be filtered out
			for (const msg of effective) {
				if (msg.truncationParent) {
					throw new Error("Message with truncationParent should be filtered out")
				}
			}
		})

		it("should include truncated messages when truncation marker is removed", () => {
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")

			// Remove the truncation marker (simulate rewind past truncation)
			const messagesWithoutMarker = truncationResult.messages.filter((msg) => !msg.isTruncationMarker)

			const effective = getEffectiveApiHistory(messagesWithoutMarker)

			// All messages should be visible now
			expect(effective.length).toBe(messages.length)

			// Verify first and last messages are present
			expect(itemText(effective[0])).toBe("Initial task")
			expect(itemText(effective[effective.length - 1])).toBe("Message 6")
		})

		it("should handle both condenseParent and truncationParent filtering", () => {
			// Create a scenario with both condensing and truncation
			const messagesWithCondense: ApiMessage[] = [
				{ type: "message", role: "user", content: "Initial", ts: 1000 },
				{ type: "message", role: "assistant", content: "Msg 1", ts: 1100, condenseParent: "condense-1" },
				{ type: "message", role: "user", content: "Msg 2", ts: 1200, condenseParent: "condense-1" },
				{
					type: "message",
					role: "assistant",
					content: "Summary 1",
					ts: 1250,
					isSummary: true,
					condenseId: "condense-1",
				},
				{ type: "message", role: "user", content: "Msg 3", ts: 1300 },
				{ type: "message", role: "assistant", content: "Msg 4", ts: 1400 },
			]

			const truncationResult = truncateConversation(messagesWithCondense, 0.5, "test-task-id")
			const effective = getEffectiveApiHistory(truncationResult.messages)

			// Should filter both condensed messages and truncated messages
			// Messages with condenseParent="condense-1" should be filtered (summary exists)
			// Messages with truncationParent should be filtered (marker exists)
			const hasCondensedMessage = effective.some((msg) => msg.condenseParent === "condense-1")
			const hasTruncatedMessage = effective.some((msg) => msg.truncationParent)

			expect(hasCondensedMessage).toBe(false)
			expect(hasTruncatedMessage).toBe(false)
		})
	})

	describe("cleanupAfterTruncation()", () => {
		it("should clear orphaned truncationParent tags when marker is deleted", () => {
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")

			// Remove the truncation marker (simulate rewind)
			const messagesWithoutMarker = truncationResult.messages.filter((msg) => !msg.isTruncationMarker)

			const cleaned = cleanupAfterTruncation(messagesWithoutMarker)

			// All truncationParent tags should be cleared
			for (const msg of cleaned) {
				expect(msg.truncationParent).toBeUndefined()
			}
		})

		it("should preserve truncationParent tags when marker still exists", () => {
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")

			const cleaned = cleanupAfterTruncation(truncationResult.messages)

			// truncationParent tags should be preserved (marker still exists)
			const taggedMessages = cleaned.filter((msg) => msg.truncationParent)
			expect(taggedMessages.length).toBeGreaterThan(0)

			// All tagged messages should point to the existing marker
			for (const msg of taggedMessages) {
				expect(msg.truncationParent).toBe(truncationResult.truncationId)
			}
		})

		it("should handle both condenseParent and truncationParent cleanup", () => {
			const messagesWithBoth: ApiMessage[] = [
				{ type: "message", role: "user", content: "Initial", ts: 1000 },
				{ type: "message", role: "assistant", content: "Msg 1", ts: 1100, condenseParent: "orphan-condense" },
				{ type: "message", role: "user", content: "Msg 2", ts: 1200, truncationParent: "orphan-truncation" },
				{ type: "message", role: "assistant", content: "Msg 3", ts: 1300 },
			]

			const cleaned = cleanupAfterTruncation(messagesWithBoth)

			// Both orphaned parent references should be cleared
			expect(cleaned[1].condenseParent).toBeUndefined()
			expect(cleaned[2].truncationParent).toBeUndefined()
		})

		it("should preserve valid parent references", () => {
			const messagesWithValidParents: ApiMessage[] = [
				{ type: "message", role: "user", content: "Initial", ts: 1000 },
				{ type: "message", role: "assistant", content: "Msg 1", ts: 1100, condenseParent: "valid-condense" },
				{
					type: "message",
					role: "assistant",
					content: "Summary",
					ts: 1150,
					isSummary: true,
					condenseId: "valid-condense",
				},
				{ type: "message", role: "user", content: "Msg 2", ts: 1200, truncationParent: "valid-truncation" },
				{
					type: "message",
					role: "assistant",
					content: "Truncation marker",
					ts: 1250,
					isTruncationMarker: true,
					truncationId: "valid-truncation",
				},
			]

			const cleaned = cleanupAfterTruncation(messagesWithValidParents)

			// Valid parent references should be preserved
			expect(cleaned[1].condenseParent).toBe("valid-condense")
			expect(cleaned[3].truncationParent).toBe("valid-truncation")
		})
	})

	describe("Rewind past truncation integration", () => {
		it("should restore hidden messages when rewinding past truncation point", () => {
			// Step 1: Perform truncation
			const truncationResult = truncateConversation(messages, 0.5, "test-task-id")

			// Step 2: Verify messages are hidden initially
			const effectiveBeforeRewind = getEffectiveApiHistory(truncationResult.messages)
			expect(effectiveBeforeRewind.length).toBeLessThan(messages.length)

			// Step 3: Simulate rewind by removing truncation marker and subsequent messages
			// In practice this would be done via removeMessagesThisAndSubsequent
			const markerIndex = truncationResult.messages.findIndex((msg) => msg.isTruncationMarker)
			const messagesAfterRewind = truncationResult.messages.slice(0, markerIndex)

			// Step 4: Clean up orphaned parent references
			const cleanedAfterRewind = cleanupAfterTruncation(messagesAfterRewind)

			// Step 5: Get effective history after cleanup
			const effectiveAfterRewind = getEffectiveApiHistory(cleanedAfterRewind)

			// All original messages before the marker should be restored
			expect(effectiveAfterRewind.length).toBe(markerIndex)

			// No messages should have truncationParent
			for (const msg of effectiveAfterRewind) {
				expect(msg.truncationParent).toBeUndefined()
			}
		})

		it("should handle multiple truncations correctly", () => {
			// Step 1: First truncation
			const firstTruncation = truncateConversation(messages, 0.5, "task-1")

			// Step 2: Get effective history and simulate more messages being added
			getEffectiveApiHistory(firstTruncation.messages)
			const moreMessages: ApiMessage[] = [
				...firstTruncation.messages,
				{ type: "message", role: "user", content: "New message 1", ts: 3000 },
				{ type: "message", role: "assistant", content: "New response 1", ts: 3100 },
				{ type: "message", role: "user", content: "New message 2", ts: 3200 },
				{ type: "message", role: "assistant", content: "New response 2", ts: 3300 },
			]

			// Step 3: Second truncation
			const secondTruncation = truncateConversation(moreMessages, 0.5, "task-1")

			// Step 4: Get effective history after second truncation
			const effectiveAfterSecond = getEffectiveApiHistory(secondTruncation.messages)

			// Should have messages hidden by both truncations filtered out
			const firstMarker = secondTruncation.messages.find(
				(msg) => msg.isTruncationMarker && msg.truncationId === firstTruncation.truncationId,
			)
			const secondMarker = secondTruncation.messages.find(
				(msg) => msg.isTruncationMarker && msg.truncationId === secondTruncation.truncationId,
			)

			expect(firstMarker).toBeDefined()
			expect(secondMarker).toBeDefined()

			// Messages tagged with either truncationId should be filtered
			for (const msg of effectiveAfterSecond) {
				if (msg.truncationParent === firstTruncation.truncationId) {
					throw new Error("First truncation messages should be filtered")
				}
				if (msg.truncationParent === secondTruncation.truncationId) {
					throw new Error("Second truncation messages should be filtered")
				}
			}
		})

		it("should handle rewinding when second truncation affects first truncation marker", () => {
			// Step 1: First truncation
			const firstTruncation = truncateConversation(messages, 0.5, "task-1")

			// Step 2: Add more messages AFTER getting effective history
			// This simulates real usage where we only send effective messages to API
			getEffectiveApiHistory(firstTruncation.messages)
			const moreMessages: ApiMessage[] = [
				...firstTruncation.messages, // Keep full history with tagged messages
				{ type: "message", role: "user", content: "New message 1", ts: 3000 },
				{ type: "message", role: "assistant", content: "New response 1", ts: 3100 },
				{ type: "message", role: "user", content: "New message 2", ts: 3200 },
				{ type: "message", role: "assistant", content: "New response 2", ts: 3300 },
			]

			// Step 3: Second truncation - this will tag some messages including possibly the first marker
			const secondTruncation = truncateConversation(moreMessages, 0.5, "task-1")

			// Step 4: Simulate rewind past second truncation marker
			const secondMarkerIndex = secondTruncation.messages.findIndex(
				(msg) => msg.isTruncationMarker && msg.truncationId === secondTruncation.truncationId,
			)
			const afterSecondRewind = secondTruncation.messages.slice(0, secondMarkerIndex)

			// Step 5: Clean up orphaned references
			const cleaned = cleanupAfterTruncation(afterSecondRewind)

			// Step 6: Get effective history
			const effective = getEffectiveApiHistory(cleaned)

			// The second truncation marker should be removed
			const hasSecondTruncationMarker = effective.some(
				(msg) => msg.isTruncationMarker && msg.truncationId === secondTruncation.truncationId,
			)
			expect(hasSecondTruncationMarker).toBe(false)

			// Messages that were tagged by the second truncation should have those tags cleared
			const hasSecondTruncationParent = cleaned.some(
				(msg) => msg.truncationParent === secondTruncation.truncationId,
			)
			expect(hasSecondTruncationParent).toBe(false)

			// First truncation marker and its tagged messages may or may not be present
			// depending on whether the second truncation affected them
			// The important thing is that cleanup works correctly
			expect(cleaned.length).toBeGreaterThan(0)
		})
	})

	describe("Edge cases", () => {
		it("should handle truncateConversation with fracToRemove=0", () => {
			const result = truncateConversation(messages, 0, "test-task-id")

			// No messages should be tagged (messagesToRemove = 0)
			const taggedMessages = result.messages.filter((msg) => msg.truncationParent)
			expect(taggedMessages.length).toBe(0)
			expect(result.messagesRemoved).toBe(0)

			// When nothing is truncated, no marker is inserted
			expect(result.messages).toEqual(messages)
		})

		it("should handle truncateConversation with very few messages", () => {
			const fewMessages: ApiMessage[] = [
				{ type: "message", role: "user", content: "Initial", ts: 1000 },
				{ type: "message", role: "assistant", content: "Response", ts: 1100 },
			]

			const result = truncateConversation(fewMessages, 0.5, "test-task-id")

			// With only 1 message after first, 0.5 fraction = 0.5, floored to 0, rounded to even = 0
			// So no messages should be removed and no marker inserted
			expect(result.messages.length).toBe(2)
			expect(result.messagesRemoved).toBe(0)
		})

		it("should handle truncating all visible messages except first", () => {
			// This tests the edge case where visibleIndices[messagesToRemove + 1] would be undefined
			// 3 messages total: first is preserved, 2 others can be truncated
			const threeMessages: ApiMessage[] = [
				{ type: "message", role: "user", content: "Initial", ts: 1000 },
				{ type: "message", role: "assistant", content: "Response 1", ts: 1100 },
				{ type: "message", role: "user", content: "Message 2", ts: 1200 },
			]

			// With fracToRemove = 1.0:
			// visibleCount = 3
			// rawMessagesToRemove = floor((3-1) * 1.0) = 2
			// messagesToRemove = 2 (already even)
			// This truncates ALL messages except the first
			const result = truncateConversation(threeMessages, 1.0, "test-task-id")

			expect(result.messagesRemoved).toBe(2)
			// Should have 3 original messages + 1 marker = 4
			expect(result.messages.length).toBe(4)

			// First message should be untouched
			expect(result.messages[0].truncationParent).toBeUndefined()
			expect(itemText(result.messages[0])).toBe("Initial")

			// Messages at indices 1 and 2 should be tagged
			expect(result.messages[1].truncationParent).toBe(result.truncationId)
			expect(result.messages[2].truncationParent).toBe(result.truncationId)

			// Marker should be at the end (index 3)
			expect(result.messages[3].isTruncationMarker).toBe(true)
			expect(itemRole(result.messages[3])).toBe("user")
		})

		it("should handle empty condenseParent and truncationParent gracefully", () => {
			const messagesWithoutTags: ApiMessage[] = [
				{ type: "message", role: "user", content: "Message 1", ts: 1000 },
				{ type: "message", role: "assistant", content: "Response 1", ts: 1100 },
			]

			const cleaned = cleanupAfterTruncation(messagesWithoutTags)

			// Should return same messages unchanged
			expect(cleaned).toEqual(messagesWithoutTags)
		})
	})
})

describe("truncateConversation - tool ペアの保全", () => {
	// 実機検証で見つかった回帰の再発防止。
	// item 列では 1 ターンが複数要素に割れるため、「偶数件に丸める」だけでは
	// function_call とその function_call_output が切り離され、相手のいない
	// tool 応答が送信されて互換サーバが 400 を返していた。
	const hidden = (msgs: ApiMessage[]) => msgs.filter((m) => m.truncationParent)
	const visible = (msgs: ApiMessage[]) => msgs.filter((m) => !m.truncationParent && !m.isTruncationMarker)

	// 単一フィクスチャ（4 ペア）では分割が起きず、修正前の実装でも通ってしまった。
	// ペア数を振って、どの形でもペアが割れないことを確認する。
	const SHAPES = [1, 2, 3, 4, 5, 8]

	function build(pairs: number): ApiMessage[] {
		const out: ApiMessage[] = [{ type: "message", role: "user", content: "task", ts: 1 }]
		for (let i = 1; i <= pairs; i++) {
			out.push({ type: "function_call", call_id: `c${i}`, name: "read_file", arguments: "{}", ts: i * 10 })
			out.push({ type: "function_call_output", call_id: `c${i}`, output: "body", ts: i * 10 + 1 })
			out.push({ type: "message", role: "user", content: "<environment_details>", ts: i * 10 + 2 })
		}
		return out
	}

	it.each(SHAPES)("片方だけ隠れる call_id が存在しない（%i ペア）", (pairs) => {
		const { messages } = truncateConversation(build(pairs), 0.5, "t")

		const hiddenIds = new Set(
			hidden(messages)
				.filter((m) => m.type === "function_call" || m.type === "function_call_output")
				.map((m) => (m as { call_id: string }).call_id),
		)
		const visibleIds = new Set(
			visible(messages)
				.filter((m) => m.type === "function_call" || m.type === "function_call_output")
				.map((m) => (m as { call_id: string }).call_id),
		)

		// 同じ call_id が「隠れた側」と「見える側」の両方に現れてはいけない
		for (const id of hiddenIds) expect(visibleIds.has(id)).toBe(false)
	})

	it.each(SHAPES)("残った function_call_output には必ず対応する function_call がある（%i ペア）", (pairs) => {
		const { messages } = truncateConversation(build(pairs), 0.5, "t")
		const kept = visible(messages)

		const calls = new Set(
			kept.filter((m) => m.type === "function_call").map((m) => (m as { call_id: string }).call_id),
		)
		const outputs = kept
			.filter((m) => m.type === "function_call_output")
			.map((m) => (m as { call_id: string }).call_id)

		for (const id of outputs) expect(calls.has(id)).toBe(true)
	})
})
