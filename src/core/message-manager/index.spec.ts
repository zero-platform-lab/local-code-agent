import { MessageManager } from "./index"
import * as condenseModule from "../condense"
import { getTaskDirectoryPath } from "../../utils/storage"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"

vi.mock("../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(),
}))

vi.mock("../../integrations/terminal/OutputInterceptor", () => ({
	OutputInterceptor: { cleanupByIds: vi.fn() },
}))

/** fire-and-forget（await されない cleanup）を流し切るためのヘルパ。 */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("MessageManager", () => {
	let mockTask: any
	let manager: MessageManager
	let cleanupAfterTruncationSpy: any

	beforeEach(() => {
		mockTask = {
			messageStore: {
				clineMessages: [],
				apiConversationHistory: [],
			} as any,
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
		}
		manager = new MessageManager(mockTask)

		// Mock cleanupAfterTruncation to track calls and return input by default
		cleanupAfterTruncationSpy = vi.spyOn(condenseModule, "cleanupAfterTruncation")
		cleanupAfterTruncationSpy.mockImplementation((messages: any[]) => messages)
	})

	afterEach(() => {
		cleanupAfterTruncationSpy.mockRestore()
	})

	describe("Basic rewind operations", () => {
		it("should remove messages at and after the target timestamp", async () => {
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
				{ ts: 300, say: "user", text: "Second" },
				{ ts: 400, say: "assistant", text: "Response 2" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "assistant", content: "Response" },
				{ ts: 300, type: "message", role: "user", content: "Second" },
				{ ts: 400, type: "message", role: "assistant", content: "Response 2" },
			]

			await manager.rewindToTimestamp(300)

			// Should keep messages before ts=300
			expect(mockTask.overwriteClineMessages).toHaveBeenCalledWith([
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
			])

			// Should keep API messages before ts=300
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			expect(apiCall).toHaveLength(2)
			expect(apiCall[0].ts).toBe(100)
			expect(apiCall[1].ts).toBe(200)
		})

		it("should keep target message when includeTargetMessage is true", async () => {
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
				{ ts: 300, say: "user", text: "Second" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "assistant", content: "Response" },
				{ ts: 300, type: "message", role: "user", content: "Second" },
			]

			await manager.rewindToTimestamp(300, { includeTargetMessage: true })

			// Should keep messages up to and including ts=300 in clineMessages
			expect(mockTask.overwriteClineMessages).toHaveBeenCalledWith([
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
				{ ts: 300, say: "user", text: "Second" },
			])

			// API history uses ts < cutoffTs, so excludes the message at ts=300
			// This is correct for edit scenarios - keep UI message but truncate API before it
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			expect(apiCall).toHaveLength(2)
			expect(apiCall[0].ts).toBe(100)
			expect(apiCall[1].ts).toBe(200)
		})

		it("should throw error when timestamp not found", async () => {
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
			]

			await expect(manager.rewindToTimestamp(999)).rejects.toThrow(
				"Message with timestamp 999 not found in clineMessages",
			)
		})

		it("should remove messages at and after the target index", async () => {
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
				{ ts: 300, say: "user", text: "Second" },
				{ ts: 400, say: "assistant", text: "Response 2" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "assistant", content: "Response" },
				{ ts: 300, type: "message", role: "user", content: "Second" },
				{ ts: 400, type: "message", role: "assistant", content: "Response 2" },
			]

			await manager.rewindToIndex(2)

			// Should keep messages [0, 2) - index 0 and 1
			expect(mockTask.overwriteClineMessages).toHaveBeenCalledWith([
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
			])

			// Should keep API messages before ts=300
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			expect(apiCall).toHaveLength(2)
		})
	})

	describe("Condense handling", () => {
		it("should preserve Summary when condense_context is preserved", async () => {
			const condenseId = "summary-123"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
				{ ts: 300, say: "condense_context", contextCondense: { condenseId, summary: "Summary" } },
				{ ts: 400, say: "user", text: "After condense" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{
					ts: 200,
					role: "assistant",
					content: [{ type: "text", text: "Response" }],
					condenseParent: condenseId,
				},
				{
					ts: 299,
					role: "user",
					content: [{ type: "text", text: "Summary" }],
					isSummary: true,
					condenseId,
				},
				{ ts: 400, type: "message", role: "user", content: "After condense" },
			]

			// Rewind to ts=400, which preserves condense_context at ts=300
			await manager.rewindToTimestamp(400)

			// Summary should still exist
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasSummary = apiCall.some((m: any) => m.isSummary && m.condenseId === condenseId)
			expect(hasSummary).toBe(true)
		})

		it("should remove Summary when condense_context is removed", async () => {
			const condenseId = "summary-123"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
				{ ts: 300, say: "user", text: "Second" },
				{ ts: 400, say: "condense_context", contextCondense: { condenseId, summary: "Summary" } },
				{ ts: 500, say: "user", text: "Third" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{
					ts: 200,
					role: "assistant",
					content: [{ type: "text", text: "Response" }],
					condenseParent: condenseId,
				},
				{
					ts: 299,
					role: "user",
					content: [{ type: "text", text: "Summary" }],
					isSummary: true,
					condenseId,
				},
				{ ts: 300, type: "message", role: "user", content: "Second" },
				{ ts: 500, type: "message", role: "user", content: "Third" },
			]

			// Rewind to ts=300, which removes condense_context at ts=400
			await manager.rewindToTimestamp(300)

			// Summary should be removed
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasSummary = apiCall.some((m: any) => m.isSummary)
			expect(hasSummary).toBe(false)
		})

		it("should clear orphaned condenseParent tags via cleanup", async () => {
			const condenseId = "summary-123"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "condense_context", contextCondense: { condenseId, summary: "Summary" } },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{
					ts: 150,
					role: "assistant",
					content: [{ type: "text", text: "Response" }],
					condenseParent: condenseId,
				},
				{
					ts: 199,
					role: "user",
					content: [{ type: "text", text: "Summary" }],
					isSummary: true,
					condenseId,
				},
			]

			// Rewind to ts=100, which removes condense_context
			await manager.rewindToTimestamp(100)

			// cleanupAfterTruncation should be called to remove orphaned tags
			expect(cleanupAfterTruncationSpy).toHaveBeenCalled()
		})

		it("should handle multiple condense_context removals", async () => {
			const condenseId1 = "summary-1"
			const condenseId2 = "summary-2"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{
					ts: 200,
					say: "condense_context",
					contextCondense: { condenseId: condenseId1, summary: "Summary 1" },
				},
				{ ts: 300, say: "user", text: "Second" },
				{
					ts: 400,
					say: "condense_context",
					contextCondense: { condenseId: condenseId2, summary: "Summary 2" },
				},
				{ ts: 500, say: "user", text: "Third" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{
					ts: 199,
					role: "user",
					content: [{ type: "text", text: "Summary 1" }],
					isSummary: true,
					condenseId: condenseId1,
				},
				{ ts: 300, type: "message", role: "user", content: "Second" },
				{
					ts: 399,
					role: "user",
					content: [{ type: "text", text: "Summary 2" }],
					isSummary: true,
					condenseId: condenseId2,
				},
				{ ts: 500, type: "message", role: "user", content: "Third" },
			]

			// Rewind to ts=200, which removes both condense_context messages
			await manager.rewindToTimestamp(200)

			// Both summaries should be removed
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasSummary1 = apiCall.some((m: any) => m.condenseId === condenseId1)
			const hasSummary2 = apiCall.some((m: any) => m.condenseId === condenseId2)
			expect(hasSummary1).toBe(false)
			expect(hasSummary2).toBe(false)
		})
	})

	describe("Truncation handling", () => {
		it("should preserve truncation marker when sliding_window_truncation is preserved", async () => {
			const truncationId = "trunc-123"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "sliding_window_truncation", contextTruncation: { truncationId, reason: "window" } },
				{ ts: 300, say: "user", text: "After truncation" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, role: "user", content: [{ type: "text", text: "First" }], truncationParent: truncationId },
				{
					ts: 199,
					role: "assistant",
					content: [{ type: "text", text: "..." }],
					isTruncationMarker: true,
					truncationId,
				},
				{ ts: 300, type: "message", role: "user", content: "After truncation" },
			]

			// Rewind to ts=300, which preserves sliding_window_truncation at ts=200
			await manager.rewindToTimestamp(300)

			// Truncation marker should still exist
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasMarker = apiCall.some((m: any) => m.isTruncationMarker && m.truncationId === truncationId)
			expect(hasMarker).toBe(true)
		})

		it("should remove truncation marker when sliding_window_truncation is removed", async () => {
			const truncationId = "trunc-123"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user", text: "Second" },
				{ ts: 300, say: "sliding_window_truncation", contextTruncation: { truncationId, reason: "window" } },
				{ ts: 400, say: "user", text: "Third" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, role: "user", content: [{ type: "text", text: "First" }], truncationParent: truncationId },
				{ ts: 200, type: "message", role: "user", content: "Second" },
				{
					ts: 299,
					role: "assistant",
					content: [{ type: "text", text: "..." }],
					isTruncationMarker: true,
					truncationId,
				},
				{ ts: 400, type: "message", role: "user", content: "Third" },
			]

			// Rewind to ts=200, which removes sliding_window_truncation at ts=300
			await manager.rewindToTimestamp(200)

			// Truncation marker should be removed
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasMarker = apiCall.some((m: any) => m.isTruncationMarker)
			expect(hasMarker).toBe(false)
		})

		it("should clear orphaned truncationParent tags via cleanup", async () => {
			const truncationId = "trunc-123"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "sliding_window_truncation", contextTruncation: { truncationId, reason: "window" } },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, role: "user", content: [{ type: "text", text: "First" }], truncationParent: truncationId },
				{
					ts: 199,
					role: "assistant",
					content: [{ type: "text", text: "..." }],
					isTruncationMarker: true,
					truncationId,
				},
			]

			// Rewind to ts=100, which removes sliding_window_truncation
			await manager.rewindToTimestamp(100)

			// cleanupAfterTruncation should be called to remove orphaned tags
			expect(cleanupAfterTruncationSpy).toHaveBeenCalled()
		})

		it("should handle multiple truncation removals", async () => {
			const truncationId1 = "trunc-1"
			const truncationId2 = "trunc-2"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{
					ts: 200,
					say: "sliding_window_truncation",
					contextTruncation: { truncationId: truncationId1, reason: "window" },
				},
				{ ts: 300, say: "user", text: "Second" },
				{
					ts: 400,
					say: "sliding_window_truncation",
					contextTruncation: { truncationId: truncationId2, reason: "window" },
				},
				{ ts: 500, say: "user", text: "Third" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{
					ts: 199,
					role: "assistant",
					content: [{ type: "text", text: "..." }],
					isTruncationMarker: true,
					truncationId: truncationId1,
				},
				{ ts: 300, type: "message", role: "user", content: "Second" },
				{
					ts: 399,
					role: "assistant",
					content: [{ type: "text", text: "..." }],
					isTruncationMarker: true,
					truncationId: truncationId2,
				},
				{ ts: 500, type: "message", role: "user", content: "Third" },
			]

			// Rewind to ts=200, which removes both truncation messages
			await manager.rewindToTimestamp(200)

			// Both markers should be removed
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasMarker1 = apiCall.some((m: any) => m.truncationId === truncationId1)
			const hasMarker2 = apiCall.some((m: any) => m.truncationId === truncationId2)
			expect(hasMarker1).toBe(false)
			expect(hasMarker2).toBe(false)
		})
	})

	describe("Checkpoint scenarios", () => {
		it("should preserve Summary when checkpoint restore is BEFORE condense", async () => {
			const condenseId = "summary-abc"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "Task" },
				{ ts: 500, say: "condense_context", contextCondense: { condenseId, summary: "Summary" } },
				{ ts: 600, say: "checkpoint_saved", text: "checkpoint-hash" },
				{ ts: 700, say: "user", text: "After checkpoint" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "Task" },
				{
					ts: 200,
					role: "assistant",
					content: [{ type: "text", text: "Response 1" }],
					condenseParent: condenseId,
				},
				{
					ts: 499,
					role: "user",
					content: [{ type: "text", text: "Summary" }],
					isSummary: true,
					condenseId,
				},
				{ ts: 700, type: "message", role: "user", content: "After checkpoint" },
			]

			// Restore checkpoint at ts=600 (like checkpoint restore does)
			await manager.rewindToTimestamp(600, { includeTargetMessage: true })

			// Since condense_context (ts=500) is BEFORE checkpoint, it should be preserved
			const clineCall = mockTask.overwriteClineMessages.mock.calls[0][0]
			const hasCondenseContext = clineCall.some((m: any) => m.say === "condense_context")
			expect(hasCondenseContext).toBe(true)

			// And the Summary should still exist
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasSummary = apiCall.some((m: any) => m.isSummary)
			expect(hasSummary).toBe(true)
		})

		it("should remove Summary when checkpoint restore is AFTER condense", async () => {
			const condenseId = "summary-xyz"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "Task" },
				{ ts: 200, say: "checkpoint_saved", text: "checkpoint-hash" },
				{ ts: 300, say: "condense_context", contextCondense: { condenseId, summary: "Summary" } },
				{ ts: 400, say: "user", text: "After condense" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "Task" },
				{
					ts: 150,
					role: "assistant",
					content: [{ type: "text", text: "Response" }],
					condenseParent: condenseId,
				},
				{
					ts: 299,
					role: "assistant",
					content: [{ type: "text", text: "Summary" }],
					isSummary: true,
					condenseId,
				},
				{ ts: 400, type: "message", role: "user", content: "After condense" },
			]

			// Restore checkpoint at ts=200 (before the condense happened)
			await manager.rewindToTimestamp(200, { includeTargetMessage: true })

			// condense_context (ts=300) is AFTER checkpoint, so it should be removed
			const clineCall = mockTask.overwriteClineMessages.mock.calls[0][0]
			const hasCondenseContext = clineCall.some((m: any) => m.say === "condense_context")
			expect(hasCondenseContext).toBe(false)

			// And the Summary should be removed too
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasSummary = apiCall.some((m: any) => m.isSummary)
			expect(hasSummary).toBe(false)
		})

		it("should preserve truncation marker when checkpoint restore is BEFORE truncation", async () => {
			const truncationId = "trunc-abc"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "Task" },
				{ ts: 500, say: "sliding_window_truncation", contextTruncation: { truncationId, reason: "window" } },
				{ ts: 600, say: "checkpoint_saved", text: "checkpoint-hash" },
				{ ts: 700, say: "user", text: "After checkpoint" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, role: "user", content: [{ type: "text", text: "Task" }], truncationParent: truncationId },
				{
					ts: 499,
					role: "assistant",
					content: [{ type: "text", text: "..." }],
					isTruncationMarker: true,
					truncationId,
				},
				{ ts: 700, type: "message", role: "user", content: "After checkpoint" },
			]

			// Restore checkpoint at ts=600
			await manager.rewindToTimestamp(600, { includeTargetMessage: true })

			// Truncation should be preserved
			const clineCall = mockTask.overwriteClineMessages.mock.calls[0][0]
			const hasTruncation = clineCall.some((m: any) => m.say === "sliding_window_truncation")
			expect(hasTruncation).toBe(true)

			// Marker should still exist
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasMarker = apiCall.some((m: any) => m.isTruncationMarker)
			expect(hasMarker).toBe(true)
		})

		it("should remove truncation marker when checkpoint restore is AFTER truncation", async () => {
			const truncationId = "trunc-xyz"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "Task" },
				{ ts: 200, say: "checkpoint_saved", text: "checkpoint-hash" },
				{ ts: 300, say: "sliding_window_truncation", contextTruncation: { truncationId, reason: "window" } },
				{ ts: 400, say: "user", text: "After truncation" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, role: "user", content: [{ type: "text", text: "Task" }], truncationParent: truncationId },
				{
					ts: 299,
					role: "assistant",
					content: [{ type: "text", text: "..." }],
					isTruncationMarker: true,
					truncationId,
				},
				{ ts: 400, type: "message", role: "user", content: "After truncation" },
			]

			// Restore checkpoint at ts=200 (before truncation happened)
			await manager.rewindToTimestamp(200, { includeTargetMessage: true })

			// Truncation should be removed
			const clineCall = mockTask.overwriteClineMessages.mock.calls[0][0]
			const hasTruncation = clineCall.some((m: any) => m.say === "sliding_window_truncation")
			expect(hasTruncation).toBe(false)

			// Marker should be removed
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasMarker = apiCall.some((m: any) => m.isTruncationMarker)
			expect(hasMarker).toBe(false)
		})
	})

	describe("Skip cleanup option", () => {
		it("should NOT call cleanupAfterTruncation when skipCleanup is true", async () => {
			const condenseId = "summary-123"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "condense_context", contextCondense: { condenseId, summary: "Summary" } },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{
					ts: 150,
					role: "assistant",
					content: [{ type: "text", text: "Response" }],
					condenseParent: condenseId,
				},
				{
					ts: 199,
					role: "assistant",
					content: [{ type: "text", text: "Summary" }],
					isSummary: true,
					condenseId,
				},
			]

			// Rewind with skipCleanup
			await manager.rewindToTimestamp(100, { skipCleanup: true })

			// cleanupAfterTruncation should NOT be called
			expect(cleanupAfterTruncationSpy).not.toHaveBeenCalled()
		})

		it("should call cleanupAfterTruncation by default", async () => {
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user", text: "Second" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "user", content: "Second" },
			]

			// Rewind without options (skipCleanup defaults to false)
			await manager.rewindToTimestamp(100)

			// cleanupAfterTruncation should be called
			expect(cleanupAfterTruncationSpy).toHaveBeenCalled()
		})

		it("should call cleanupAfterTruncation when skipCleanup is explicitly false", async () => {
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user", text: "Second" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "user", content: "Second" },
			]

			// Rewind with skipCleanup explicitly false
			await manager.rewindToTimestamp(100, { skipCleanup: false })

			// cleanupAfterTruncation should be called
			expect(cleanupAfterTruncationSpy).toHaveBeenCalled()
		})
	})

	describe("Combined scenarios", () => {
		it("should handle both condense and truncation removal in the same rewind", async () => {
			const condenseId = "summary-123"
			const truncationId = "trunc-456"

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "condense_context", contextCondense: { condenseId, summary: "Summary" } },
				{ ts: 300, say: "sliding_window_truncation", contextTruncation: { truncationId, reason: "window" } },
				{ ts: 400, say: "user", text: "After both" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{
					ts: 199,
					role: "assistant",
					content: [{ type: "text", text: "Summary" }],
					isSummary: true,
					condenseId,
				},
				{
					ts: 299,
					role: "assistant",
					content: [{ type: "text", text: "..." }],
					isTruncationMarker: true,
					truncationId,
				},
				{ ts: 400, type: "message", role: "user", content: "After both" },
			]

			// Rewind to ts=100, which removes both
			await manager.rewindToTimestamp(100)

			// Both Summary and marker should be removed
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			const hasSummary = apiCall.some((m: any) => m.isSummary)
			const hasMarker = apiCall.some((m: any) => m.isTruncationMarker)
			expect(hasSummary).toBe(false)
			expect(hasMarker).toBe(false)
		})

		it("should handle empty clineMessages array", async () => {
			mockTask.messageStore.clineMessages = []
			mockTask.messageStore.apiConversationHistory = []

			await manager.rewindToIndex(0)

			expect(mockTask.overwriteClineMessages).toHaveBeenCalledWith([])
			// API history write is skipped when nothing changed (optimization)
			expect(mockTask.overwriteApiConversationHistory).not.toHaveBeenCalled()
		})

		it("should handle messages without timestamps in API history", async () => {
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user", text: "Second" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ role: "system", content: [{ type: "text", text: "System message" }] }, // No ts
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "user", content: "Second" },
			]

			await manager.rewindToTimestamp(100)

			// Should keep system message (no ts) and message at ts=100
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			expect(apiCall).toHaveLength(1)
			expect(apiCall[0].role).toBe("system")
		})
	})

	describe("Orphaned artifact cleanup", () => {
		const mockedGetTaskDir = vi.mocked(getTaskDirectoryPath)
		const mockedCleanupByIds = vi.mocked(OutputInterceptor.cleanupByIds)

		beforeEach(() => {
			mockedGetTaskDir.mockReset().mockResolvedValue("/storage/tasks/task-1")
			mockedCleanupByIds.mockReset().mockResolvedValue(undefined)
			// cleanupOrphanedArtifacts が早期 return しないよう storage 情報を持たせる
			mockTask.globalStoragePath = "/storage"
			mockTask.taskId = "task-1"
		})

		it("残存メッセージの ts を valid ID として command-output を掃除する", async () => {
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user", text: "Second" },
			]
			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "user", content: "Second" },
			]

			await manager.rewindToTimestamp(200)
			await flushMicrotasks()

			expect(mockedGetTaskDir).toHaveBeenCalledWith("/storage", "task-1")
			expect(mockedCleanupByIds).toHaveBeenCalledTimes(1)
			const [dir, ids] = mockedCleanupByIds.mock.calls[0]
			expect(dir).toContain("command-output")
			// 残った API メッセージ(ts=100)の ts が valid ID に含まれる
			expect(ids.has("100")).toBe(true)
		})

		it("globalStoragePath / taskId が無ければ何もしない（早期 return）", async () => {
			mockTask.globalStoragePath = undefined
			mockTask.taskId = undefined
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user", text: "Second" },
			]
			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "user", content: "Second" },
			]

			await manager.rewindToTimestamp(200)
			await flushMicrotasks()

			expect(mockedGetTaskDir).not.toHaveBeenCalled()
			expect(mockedCleanupByIds).not.toHaveBeenCalled()
		})

		it("片方（taskId のみ）が欠けても何もしない（|| ガードの不変条件）", async () => {
			// globalStoragePath はあるが taskId が無い → || なので早期 return する。
			// （&& に退化するとここを素通りして getTaskDir を呼んでしまう）
			mockTask.globalStoragePath = "/storage"
			mockTask.taskId = undefined
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user", text: "Second" },
			]
			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "user", content: "Second" },
			]

			await manager.rewindToTimestamp(200)
			await flushMicrotasks()

			expect(mockedGetTaskDir).not.toHaveBeenCalled()
			expect(mockedCleanupByIds).not.toHaveBeenCalled()
		})

		it("掃除が失敗しても内部で握りつぶす（best-effort・console.debug 経由）", async () => {
			const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
			mockedCleanupByIds.mockRejectedValue(new Error("cleanup failed"))

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user", text: "Second" },
			]
			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "user", content: "Second" },
			]

			// 例外が rewind の外へ漏れない（不変条件: best-effort）
			await expect(manager.rewindToTimestamp(200)).resolves.toBeUndefined()
			await flushMicrotasks()

			expect(debugSpy).toHaveBeenCalledWith("[MessageManager] Artifact cleanup skipped:", expect.any(Error))
			debugSpy.mockRestore()
		})

		it("内部 catch すら投げても fire-and-forget の .catch が最後に握りつぶす", async () => {
			// cleanupByIds が reject → 内部 catch の console.debug を投げさせ、
			// cleanupOrphanedArtifacts 自体を reject させる → 外側 .catch(console.error) が処理する。
			mockedCleanupByIds.mockRejectedValue(new Error("cleanup failed"))
			const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {
				throw new Error("debug boom")
			})
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user", text: "Second" },
			]
			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 200, type: "message", role: "user", content: "Second" },
			]

			await expect(manager.rewindToTimestamp(200)).resolves.toBeUndefined()
			await flushMicrotasks()

			expect(errorSpy).toHaveBeenCalledWith(
				"[MessageManager] Error cleaning up orphaned command output artifacts:",
				expect.any(Error),
			)
			debugSpy.mockRestore()
			errorSpy.mockRestore()
		})
	})

	describe("Race condition handling", () => {
		it("should preserve assistant message when clineMessage timestamp is earlier due to async execution", async () => {
			// This test reproduces the bug where deleting a user_feedback clineMessage
			// incorrectly removes an assistant API message that was added AFTER the
			// clineMessage (due to async tool execution during streaming).
			//
			// Timeline (race condition scenario):
			// - T1 (100): clineMessage "user_feedback" created during tool execution
			// - T2 (200): assistant API message added when stream completes
			// - T3 (300): user API message (tool_result) added after pWaitFor
			//
			// When deleting the clineMessage at T1, we should:
			// - Keep the assistant message at T2
			// - Remove the user message at T3

			mockTask.messageStore.clineMessages = [
				{ ts: 50, say: "user", text: "Initial request" },
				{ ts: 100, say: "user_feedback", text: "tell me a joke 3" }, // Race: created BEFORE assistant API msg
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 50, type: "message", role: "user", content: "Initial request" },
				{
					ts: 200, // Race: added AFTER clineMessage at ts=100
					type: "function_call",
					call_id: "tool_1",
					name: "attempt_completion",
					arguments: "{}",
				},
				{
					ts: 300,
					type: "function_call_output",
					call_id: "tool_1",
					output: "tell me a joke 3",
				},
			]

			// Delete the user_feedback clineMessage at ts=100
			await manager.rewindToTimestamp(100)

			// The fix ensures we find the first API user message at or after cutoff (ts=300)
			// and use that as the actual cutoff, preserving the assistant message (ts=200)
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			expect(apiCall).toHaveLength(2)
			expect(apiCall[0].ts).toBe(50) // Initial user message preserved
			expect(apiCall[1].ts).toBe(200) // Assistant message preserved (was incorrectly removed before fix)
			// item 列では assistant のツール呼び出しは function_call item（role は持たない）
			expect(apiCall[1].type).toBe("function_call")
		})

		it("should handle normal case where timestamps are properly ordered", async () => {
			// Normal case: clineMessage timestamp aligns with API message timestamp
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "user_feedback", text: "Feedback" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 150, type: "message", role: "assistant", content: "Response" },
				{ ts: 200, type: "message", role: "user", content: "Feedback" },
			]

			await manager.rewindToTimestamp(200)

			// Should keep messages before the user message at ts=200
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			expect(apiCall).toHaveLength(2)
			expect(apiCall[0].ts).toBe(100)
			expect(apiCall[1].ts).toBe(150)
		})

		it("should fall back to original cutoff when no user message found at or after cutoff", async () => {
			// Edge case: no API user message at or after the cutoff timestamp
			mockTask.messageStore.clineMessages = [
				{ ts: 100, say: "user", text: "First" },
				{ ts: 200, say: "assistant", text: "Response" },
				{ ts: 300, say: "assistant", text: "Another response" },
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 100, type: "message", role: "user", content: "First" },
				{ ts: 150, type: "message", role: "assistant", content: "Response" },
				{ ts: 250, type: "message", role: "assistant", content: "Another response" },
				// No user message at or after ts=200
			]

			await manager.rewindToTimestamp(200)

			// Falls back to original behavior: keep messages with ts < 200
			// This removes the assistant message at ts=250
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			expect(apiCall).toHaveLength(2)
			expect(apiCall[0].ts).toBe(100)
			expect(apiCall[1].ts).toBe(150)
		})

		it("should handle multiple assistant messages before the user message in race condition", async () => {
			// Complex race scenario: multiple assistant messages added before user message
			mockTask.messageStore.clineMessages = [
				{ ts: 50, say: "user", text: "Initial" },
				{ ts: 100, say: "user_feedback", text: "Feedback" }, // Race condition
			]

			mockTask.messageStore.apiConversationHistory = [
				{ ts: 50, type: "message", role: "user", content: "Initial" },
				{ ts: 150, type: "message", role: "assistant", content: "First assistant msg" }, // After clineMessage
				{ ts: 200, type: "message", role: "assistant", content: "Second assistant msg" }, // After clineMessage
				{ ts: 250, type: "message", role: "user", content: "Feedback" },
			]

			await manager.rewindToTimestamp(100)

			// Should preserve both assistant messages (ts=150, ts=200) because the first
			// user message at or after cutoff is at ts=250
			const apiCall = mockTask.overwriteApiConversationHistory.mock.calls[0][0]
			expect(apiCall).toHaveLength(3)
			expect(apiCall[0].ts).toBe(50)
			expect(apiCall[1].ts).toBe(150)
			expect(apiCall[1].role).toBe("assistant")
			expect(apiCall[2].ts).toBe(200)
			expect(apiCall[2].role).toBe("assistant")
		})
	})
})
