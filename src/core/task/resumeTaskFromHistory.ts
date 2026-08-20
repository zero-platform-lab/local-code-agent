import { isUserTurn, itemText } from "../task-persistence/agentMessageUtils"
import type { ContentBlockParam } from "@openai-agent/types"
import {
	type ClineAsk,
	type ClineApiReqCancelReason,
	type ClineApiReqInfo,
	type ClineMessage,
	type ClineSay,
} from "@openai-agent/types"

import { ClineAskResponse } from "../../shared/WebviewMessage"
import { findLastIndex } from "../../shared/array"
import { formatResponse } from "../prompts/responses"
import { type ApiMessage } from "../task-persistence"

/**
 * 保存済みタスクを再開するために必要な操作。
 *
 * Task を state host として渡し、`clineMessages` / `apiConversationHistory` /
 * `isInitialized` / `abort*` 系フィールドは host 経由で直接読み書きする。
 * それ以外の外部依存（保存済み履歴の I/O やループ呼び出し）は callback で渡す。
 */
export interface ResumeTaskFromHistoryStateHost {
	messageStore: { clineMessages: ClineMessage[]; apiConversationHistory: ApiMessage[] }
	isInitialized: boolean
	abort: boolean
	abandoned: boolean
	abortReason?: ClineApiReqCancelReason

	// host-provided methods to reduce deps callback surface
	getSavedClineMessages: () => Promise<ClineMessage[]>
	getSavedApiConversationHistory: () => Promise<ApiMessage[]>
	overwriteClineMessages: (messages: ClineMessage[]) => Promise<unknown>
	overwriteApiConversationHistory: (messages: ApiMessage[]) => Promise<unknown>
	ask: (type: ClineAsk) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
	say: (type: ClineSay, text?: string, images?: string[]) => Promise<unknown>
	initiateTaskLoop: (userContent: ContentBlockParam[]) => Promise<void>
}

export interface ResumeTaskFromHistoryDeps {
	host: ResumeTaskFromHistoryStateHost
}

/**
 * 履歴からタスクを再開する。
 *
 * 保存済みメッセージを整形して提示し、ユーザーの再開応答を受けてから API 会話履歴を
 * 復元し、タスクループを再開する。中断された tool call には "interrupted" 相当の
 * tool_result を補完して、API が要求する tool_use / tool_result の対応を保つ。
 */
export async function resumeTaskFromHistory(deps: ResumeTaskFromHistoryDeps): Promise<void> {
	const { host } = deps
	try {
		const modifiedClineMessages = await host.getSavedClineMessages()

		// Remove any resume messages that may have been added before.
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)

		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// Remove any trailing reasoning-only UI messages that were not part of the persisted API conversation
		while (modifiedClineMessages.length > 0) {
			const last = modifiedClineMessages[modifiedClineMessages.length - 1]
			if (last.type === "say" && last.say === "reasoning") {
				modifiedClineMessages.pop()
			} else {
				break
			}
		}

		// Since we don't use `api_req_finished` anymore, we need to check if the
		// last `api_req_started` has a cost value, if it doesn't and no
		// cancellation reason to present, then we remove it since it indicates
		// an api request without any partial content streamed.
		const lastApiReqStartedIndex = findLastIndex(
			modifiedClineMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)

		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
			// text が壊れた JSON でも throw させない。壊れていれば除去判定に使えないため message は残す。
			let info: ClineApiReqInfo | undefined
			try {
				info = JSON.parse(lastApiReqStarted.text || "{}")
			} catch {
				info = undefined
			}

			if (info && info.cost === undefined && info.cancelReason === undefined) {
				modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await host.overwriteClineMessages(modifiedClineMessages)
		host.messageStore.clineMessages = await host.getSavedClineMessages()

		// Now present the cline messages to the user and ask if they want to
		// resume (NOTE: we ran into a bug before where the
		// apiConversationHistory wouldn't be initialized when opening a old
		// task, and it was because we were waiting for resume).
		// This is important in case the user deletes messages without resuming
		// the task first.
		host.messageStore.apiConversationHistory = await host.getSavedApiConversationHistory()

		const lastClineMessage = host.messageStore.clineMessages
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // Could be multiple resume tasks.

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		host.isInitialized = true

		const { response, text, images } = await host.ask(askType) // Calls `postStateToWebview`.

		let responseText: string | undefined
		let responseImages: string[] | undefined

		if (response === "messageResponse") {
			await host.say("user_feedback", text, images)
			responseText = text
			responseImages = images
		}

		// Make sure that the api conversation history can be resumed by the API,
		// even if it goes out of sync with cline messages.
		const existingApiConversationHistory: ApiMessage[] = await host.getSavedApiConversationHistory()

		// Tool blocks are always preserved; native tool calling only.

		// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
		// if there's no tool use and only a text block, then we can just add a user message
		// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

		// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

		let modifiedOldUserContent: ContentBlockParam[] // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: ApiMessage[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastItem = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastItem.isSummary) {
				// IMPORTANT: If the last item is a condensation summary, we must preserve it
				// intact. The summary carries critical metadata (isSummary, condenseId) that
				// getEffectiveApiHistory() uses to filter out condensed messages. Removing or
				// merging it would destroy this metadata, causing all condensed messages to
				// become "orphaned" and restored to active status — effectively undoing the
				// condensation and sending the full history to the API.
				modifiedApiConversationHistory = [...existingApiConversationHistory]
				modifiedOldUserContent = []
			} else {
				// 応答が返らないまま中断された function_call を探し、結果を埋める。
				const dangling = danglingCallIds(existingApiConversationHistory)
				if (dangling.length > 0) {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = dangling.map((callId) => ({
						type: "tool_result" as const,
						tool_use_id: callId,
						content: "Task was interrupted before this tool call could be completed.",
					}))
				} else if (isUserTurn(lastItem)) {
					// 末尾の user ターンは丸ごと外して、新しい user メッセージとして送り直す。
					const turnStart = startOfLastUserTurn(existingApiConversationHistory)
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, turnStart)
					modifiedOldUserContent = existingApiConversationHistory
						.slice(turnStart)
						.map((item) => ({ type: "text" as const, text: itemText(item) }))
						.filter((block) => block.text.length > 0)
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		const newUserContent: ContentBlockParam[] = [...modifiedOldUserContent]

		if (responseText) {
			newUserContent.push({
				type: "text",
				text: `<user_message>\n${responseText}\n</user_message>`,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		// Ensure we have at least some content to send to the API.
		// If newUserContent is empty, add a minimal resumption message.
		if (newUserContent.length === 0) {
			newUserContent.push({
				type: "text",
				text: "[TASK RESUMPTION] Resuming task...",
			})
		}

		await host.overwriteApiConversationHistory(modifiedApiConversationHistory)

		// Task resuming from history item.
		await host.initiateTaskLoop(newUserContent)
	} catch (error) {
		// Resume and cancellation can race when users issue repeated cancels.
		// Treat intentional abort/abandon flows as expected and avoid process-level crashes.
		if (host.abandoned === true || host.abort === true || host.abortReason === "user_cancelled") {
			return
		}
		throw error
	}
}

/** 応答（function_call_output）が付いていない function_call の call_id を、発行順に返す。 */
function danglingCallIds(history: ApiMessage[]): string[] {
	const answered = new Set<string>()
	for (const item of history) {
		if (item.type === "function_call_output") answered.add(item.call_id)
	}
	const out: string[] = []
	for (const item of history) {
		if (item.type === "function_call" && !answered.has(item.call_id) && !out.includes(item.call_id)) {
			out.push(item.call_id)
		}
	}
	return out
}

/** 末尾から連続する user ターンの開始位置。 */
function startOfLastUserTurn(history: ApiMessage[]): number {
	let i = history.length
	while (i > 0 && isUserTurn(history[i - 1])) i--
	return i
}
