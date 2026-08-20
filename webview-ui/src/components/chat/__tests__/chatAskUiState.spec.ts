// npx vitest run src/components/chat/__tests__/chatAskUiState.spec.ts

import type { ClineMessage } from "@openai-agent/types"

import { deriveChatAskUiPatch, isCompletedSubtask, type ChatAskUiContext } from "../chatAskUiState"

const ctx = (overrides: Partial<ChatAskUiContext> = {}): ChatAskUiContext => ({
	queuedMessageCount: 0,
	isCompletedSubtask: false,
	...overrides,
})

const ask = (kind: string, extra: Partial<ClineMessage> = {}): ClineMessage =>
	({ type: "ask", ask: kind, ts: 1, ...extra }) as ClineMessage

const say = (kind: string, extra: Partial<ClineMessage> = {}): ClineMessage =>
	({ type: "say", say: kind, ts: 1, ...extra }) as ClineMessage

const toolAsk = (tool: Record<string, unknown>, extra: Partial<ClineMessage> = {}) =>
	ask("tool", { text: JSON.stringify(tool), ...extra })

describe("deriveChatAskUiPatch — nothing to derive", () => {
	it("leaves state untouched when there is no message", () => {
		expect(deriveChatAskUiPatch(undefined, ctx())).toEqual({})
	})

	it("leaves state untouched for an unrelated message type", () => {
		expect(deriveChatAskUiPatch({ type: "other", ts: 1 } as unknown as ClineMessage, ctx())).toEqual({})
	})

	it("leaves state untouched for an unknown ask", () => {
		expect(deriveChatAskUiPatch(ask("something_new"), ctx())).toEqual({})
	})
})

describe("deriveChatAskUiPatch — asks that need attention", () => {
	it("offers retry when the API request failed", () => {
		expect(deriveChatAskUiPatch(ask("api_req_failed"), ctx())).toMatchObject({
			sendingDisabled: true,
			clineAsk: "api_req_failed",
			enableButtons: true,
			primaryButtonKey: "chat:retry.title",
			secondaryButtonKey: "chat:startNewTask.title",
		})
	})

	it("keeps the input usable when the mistake limit is reached", () => {
		// リトライ不能ではなく「それでも続ける」を選べるので送信欄は生かす。
		expect(deriveChatAskUiPatch(ask("mistake_limit_reached"), ctx())).toMatchObject({
			sendingDisabled: false,
			primaryButtonKey: "chat:proceedAnyways.title",
			secondaryButtonKey: "chat:startNewTask.title",
		})
	})

	it("clears both buttons for a follow-up but leaves them enabled", () => {
		// enableButtons を false にするとテキストエリア有効化時にフォーカスを奪う (#1358)。
		expect(deriveChatAskUiPatch(ask("followup"), ctx())).toMatchObject({
			clineAsk: "followup",
			enableButtons: true,
			primaryButtonKey: null,
			secondaryButtonKey: null,
		})
	})
})

describe("deriveChatAskUiPatch — partial asks", () => {
	it.each(["followup", "tool", "command", "use_mcp_server", "completion_result"])(
		"disables sending and buttons while %s is still streaming",
		(kind) => {
			const patch = deriveChatAskUiPatch(ask(kind, { partial: true, text: "{}" }), ctx())

			expect(patch.sendingDisabled).toBe(true)
			if (kind !== "followup") {
				expect(patch.enableButtons).toBe(false)
			}
		},
	)

	it.each(["command_output", "resume_task", "resume_completed_task", "mistake_limit_reached"])(
		"keeps sending enabled for %s even when marked partial",
		(kind) => {
			expect(deriveChatAskUiPatch(ask(kind, { partial: true }), ctx()).sendingDisabled).toBe(false)
		},
	)
})

describe("deriveChatAskUiPatch — tool approval wording", () => {
	it.each(["editedExistingFile", "appliedDiff", "newFileCreated"])("offers save/reject for %s", (tool) => {
		expect(deriveChatAskUiPatch(toolAsk({ tool }), ctx())).toMatchObject({
			primaryButtonKey: "chat:save.title",
			secondaryButtonKey: "chat:reject.title",
		})
	})

	it.each(["editedExistingFile", "appliedDiff", "newFileCreated"])(
		"switches to batch wording for %s when batchDiffs is an array",
		(tool) => {
			expect(deriveChatAskUiPatch(toolAsk({ tool, batchDiffs: [] }), ctx())).toMatchObject({
				primaryButtonKey: "chat:edit-batch.approve.title",
				secondaryButtonKey: "chat:edit-batch.deny.title",
			})
		},
	)

	it("ignores a non-array batchDiffs and falls back to single-file wording", () => {
		expect(deriveChatAskUiPatch(toolAsk({ tool: "appliedDiff", batchDiffs: "nope" }), ctx())).toMatchObject({
			primaryButtonKey: "chat:save.title",
		})
	})

	it("offers only a primary button for finishTask", () => {
		expect(deriveChatAskUiPatch(toolAsk({ tool: "finishTask" }), ctx())).toMatchObject({
			primaryButtonKey: "chat:completeSubtaskAndReturn",
			secondaryButtonKey: null,
		})
	})

	it("uses batch wording for readFile only when batchFiles is an array", () => {
		expect(deriveChatAskUiPatch(toolAsk({ tool: "readFile" }), ctx())).toMatchObject({
			primaryButtonKey: "chat:approve.title",
			secondaryButtonKey: "chat:reject.title",
		})
		expect(deriveChatAskUiPatch(toolAsk({ tool: "readFile", batchFiles: [] }), ctx())).toMatchObject({
			primaryButtonKey: "chat:read-batch.approve.title",
			secondaryButtonKey: "chat:read-batch.deny.title",
		})
	})

	it.each(["listFilesTopLevel", "listFilesRecursive"])("uses batch wording for %s with batchDirs", (tool) => {
		expect(deriveChatAskUiPatch(toolAsk({ tool }), ctx())).toMatchObject({ primaryButtonKey: "chat:approve.title" })
		expect(deriveChatAskUiPatch(toolAsk({ tool, batchDirs: [] }), ctx())).toMatchObject({
			primaryButtonKey: "chat:list-batch.approve.title",
			secondaryButtonKey: "chat:list-batch.deny.title",
		})
	})

	it("falls back to approve/reject for an unrecognised tool", () => {
		expect(deriveChatAskUiPatch(toolAsk({ tool: "brand_new_tool" }), ctx())).toMatchObject({
			primaryButtonKey: "chat:approve.title",
			secondaryButtonKey: "chat:reject.title",
		})
	})

	it("survives malformed tool JSON instead of throwing", () => {
		expect(deriveChatAskUiPatch(ask("tool", { text: "{not json" }), ctx())).toMatchObject({
			clineAsk: "tool",
			primaryButtonKey: "chat:approve.title",
		})
	})

	it("survives a missing tool payload", () => {
		expect(deriveChatAskUiPatch(ask("tool"), ctx())).toMatchObject({ primaryButtonKey: "chat:approve.title" })
	})
})

describe("deriveChatAskUiPatch — commands", () => {
	it("offers run/reject for a command", () => {
		expect(deriveChatAskUiPatch(ask("command"), ctx())).toMatchObject({
			clineAsk: "command",
			primaryButtonKey: "chat:runCommand.title",
			secondaryButtonKey: "chat:reject.title",
		})
	})

	it("offers proceed/kill while a command is producing output", () => {
		expect(deriveChatAskUiPatch(ask("command_output"), ctx())).toMatchObject({
			clineAsk: "command_output",
			sendingDisabled: false,
			enableButtons: true,
			primaryButtonKey: "chat:proceedWhileRunning.title",
			secondaryButtonKey: "chat:killCommand.title",
		})
	})
})

describe("deriveChatAskUiPatch — completion", () => {
	it("offers only a new-task button", () => {
		expect(deriveChatAskUiPatch(ask("completion_result"), ctx())).toMatchObject({
			primaryButtonKey: "chat:startNewTask.title",
			secondaryButtonKey: null,
		})
	})
})

describe("deriveChatAskUiPatch — resuming", () => {
	it("offers resume/terminate for an ordinary task", () => {
		expect(deriveChatAskUiPatch(ask("resume_task"), ctx())).toMatchObject({
			primaryButtonKey: "chat:resumeTask.title",
			secondaryButtonKey: "chat:terminate.title",
			resetDidClickCancel: true,
		})
	})

	it("offers a new task instead of resume for a completed subtask", () => {
		expect(deriveChatAskUiPatch(ask("resume_task"), ctx({ isCompletedSubtask: true }))).toMatchObject({
			primaryButtonKey: "chat:startNewTask.title",
			secondaryButtonKey: null,
		})
	})

	it("offers a new task for an already completed task", () => {
		expect(deriveChatAskUiPatch(ask("resume_completed_task"), ctx())).toMatchObject({
			primaryButtonKey: "chat:startNewTask.title",
			secondaryButtonKey: null,
			resetDidClickCancel: true,
		})
	})
})

describe("deriveChatAskUiPatch — says", () => {
	it.each(["api_req_retry_delayed", "api_req_rate_limit_wait"])(
		"only blocks sending for %s, leaving the buttons as they were",
		(kind) => {
			// 差分にキーが無い = 前の値を維持、が意図。
			expect(deriveChatAskUiPatch(say(kind), ctx())).toEqual({ sendingDisabled: true })
		},
	)

	it("clears the ask and both buttons when a new API request starts", () => {
		expect(deriveChatAskUiPatch(say("api_req_started"), ctx())).toEqual({
			sendingDisabled: true,
			clineAsk: null,
			enableButtons: false,
			primaryButtonKey: null,
			secondaryButtonKey: null,
		})
	})

	it.each(["api_req_finished", "error", "text", "command_output", "mcp_server_response", "completion_result"])(
		"leaves everything alone for say:%s",
		(kind) => {
			// ask の応答待ち中に say が挟まっても状態を壊さない。
			expect(deriveChatAskUiPatch(say(kind), ctx())).toEqual({})
		},
	)
})

describe("isCompletedSubtask", () => {
	const completion = (kind: "ask" | "say") =>
		({ type: kind, [kind]: "completion_result", ts: 1 }) as unknown as ClineMessage

	it("is false without a parent task, however the conversation ended", () => {
		expect(isCompletedSubtask({ messages: [completion("ask")] })).toBe(false)
		expect(isCompletedSubtask({ parentTaskId: undefined, messages: [completion("say")] })).toBe(false)
	})

	it("is false for a subtask that has not reported completion", () => {
		expect(isCompletedSubtask({ parentTaskId: "parent", messages: [say("text")] })).toBe(false)
	})

	it("is false for a subtask with no messages at all", () => {
		expect(isCompletedSubtask({ parentTaskId: "parent", messages: [] })).toBe(false)
	})

	it("accepts completion reported as either an ask or a say", () => {
		expect(isCompletedSubtask({ parentTaskId: "parent", messages: [completion("ask")] })).toBe(true)
		expect(isCompletedSubtask({ parentTaskId: "parent", messages: [completion("say")] })).toBe(true)
	})

	it("finds the completion anywhere in the conversation, not just last", () => {
		const messages = [say("text"), completion("say"), say("text")]

		expect(isCompletedSubtask({ parentTaskId: "parent", messages })).toBe(true)
	})
})
