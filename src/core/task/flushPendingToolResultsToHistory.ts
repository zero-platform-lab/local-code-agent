import { isAssistantTurn } from "../task-persistence/agentMessageUtils"
import { messageToAgentItems } from "../task-persistence/migrateLegacyApiMessages"
import type { MessageParam, ToolResultBlockParam, TextBlockParam, ImageBlockParam } from "@openai-agent/types"
import pWaitFor from "p-wait-for"

import { getEffectiveApiHistory } from "../condense"
import { type ApiMessage } from "../task-persistence"

import { validateAndFixToolResultIds } from "./validateToolResultIds"

/**
 * 保留中の tool_result ブロックを API 会話履歴へ追記する。
 *
 * Task から切り出した純度の高い処理。並列ツール実行（例: `update_todo_list` + `new_task`）で
 * ツール自体はストリーミング中に実行されるが、その時点ではまだ assistant メッセージが履歴に
 * 保存されていないことがある。`new_task` の delegation でこの関数が呼ばれると、assistant
 * メッセージ保存前に tool_result を書き込んでしまい:
 *
 *   `unexpected tool_use_id found in tool_result blocks`
 *
 * という API エラーになる。そのため `assistantMessageSavedToHistory` が true になるまで
 * 待ってから flush する（timeout 30 秒で fallback）。
 */
export interface FlushPendingToolResultsStateHost {
	taskId: string
	stream: {
		/** 保留中の tool_result を持つ user メッセージ本体（flush 後に空配列で置き換える）。 */
		userMessageContent: (TextBlockParam | ImageBlockParam | ToolResultBlockParam)[]
		/** アシスタントメッセージが履歴に保存されたかを polling するためのフラグ。 */
		assistantMessageSavedToHistory: boolean
	}
	messageStore: { apiConversationHistory: ApiMessage[] }
	abort: boolean
	saveApiConversationHistory: () => Promise<boolean>
}

export interface FlushPendingToolResultsDeps {
	host: FlushPendingToolResultsStateHost
}

export async function flushPendingToolResultsToHistory(deps: FlushPendingToolResultsDeps): Promise<boolean> {
	const { host } = deps

	// Only flush if there's actually pending content to save
	if (host.stream.userMessageContent.length === 0) {
		return true
	}

	// CRITICAL: Wait for the assistant message to be saved to API history first.
	// Without this, tool_result blocks would appear BEFORE tool_use blocks in the
	// conversation history, causing API errors like:
	// "unexpected `tool_use_id` found in `tool_result` blocks"
	//
	// This can happen when parallel tools are called (e.g., update_todo_list + new_task).
	// Tools execute during streaming via presentAssistantMessage, BEFORE the assistant
	// message is saved. When new_task triggers delegation, it calls this method to
	// flush pending results - but the assistant message hasn't been saved yet.
	//
	// The assistantMessageSavedToHistory flag is:
	// - Reset to false at the start of each API request
	// - Set to true after the assistant message is saved in recursivelyMakeClineRequests
	if (!host.stream.assistantMessageSavedToHistory) {
		await pWaitFor(() => host.stream.assistantMessageSavedToHistory || host.abort, {
			interval: 50,
			timeout: 30_000, // 30 second timeout as safety net
		}).catch(() => {
			// If timeout or abort, log and proceed anyway to avoid hanging
			console.warn(
				`[Task#${host.taskId}] flushPendingToolResultsToHistory: timed out waiting for assistant message to be saved`,
			)
		})
	}

	// If task was aborted while waiting, don't flush
	if (host.abort) {
		return false
	}

	// Save the user message with tool_result blocks
	const userMessage: MessageParam = {
		role: "user",
		content: host.stream.userMessageContent,
	}

	// Validate and fix tool_result IDs when the previous *effective* message is an assistant message.
	const history = host.messageStore.apiConversationHistory
	const effectiveHistoryForValidation = getEffectiveApiHistory(history)
	const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
	const historyForValidation = isAssistantTurn(lastEffective) ? effectiveHistoryForValidation : []
	const validatedMessage = validateAndFixToolResultIds(userMessage, historyForValidation)
	history.push(...messageToAgentItems("user", validatedMessage.content, { ts: Date.now() }))

	const saved = await host.saveApiConversationHistory()

	if (saved) {
		// Clear the pending content since it's now saved
		host.stream.userMessageContent = []
	} else {
		console.warn(
			`[Task#${host.taskId}] flushPendingToolResultsToHistory: save failed, retaining pending tool results in memory`,
		)
	}

	return saved
}
