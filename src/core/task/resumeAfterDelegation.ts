import type { AgentMessage } from "@openai-agent/types"
import { itemText } from "../task-persistence/agentMessageUtils"
import type { ContentBlockParam } from "@openai-agent/types"
import { AgentEventName, type ClineApiReqCancelReason } from "@openai-agent/types"

import { getEnvironmentDetails, type EnvironmentDetailsHost } from "../environment/getEnvironmentDetails"
import type { ApiMessage } from "../task-persistence"
import type { AskState } from "./AskState"

/**
 * サブタスク delegation から親タスクへ復帰するときの状態リセットと環境情報の再注入。
 *
 * 履歴の末尾にある user メッセージ（tool_result を含む）に **既存の
 * environment_details ブロックを剥がしてから新しいものを注入**する。新しい user
 * メッセージを作らないのは、consecutive user messages になって Anthropic API の
 * バリデーションを破らないため。
 */
export type ResumeAfterDelegationStateHost = EnvironmentDetailsHost & {
	// Ask states は AskState に集約
	askState: AskState
	// Abort / streaming state
	abort: boolean
	abandoned: boolean
	abortReason?: ClineApiReqCancelReason
	didFinishAbortingStream: boolean
	stream: {
		isStreaming: boolean
		isWaitingForFirstChunk: boolean
	}
	// Continuation state
	isInitialized: boolean
	// History
	messageStore: { apiConversationHistory: ApiMessage[] }

	// host-provided methods to reduce deps callback surface
	getSavedApiConversationHistory: () => Promise<ApiMessage[]>
	saveApiConversationHistory: () => Promise<unknown>
	initiateTaskLoop: (userContent: ContentBlockParam[]) => Promise<void>
	emit: (event: typeof AgentEventName.TaskActive, taskId: string) => unknown
}

export interface ResumeAfterDelegationDeps {
	host: ResumeAfterDelegationStateHost
}

export async function resumeAfterDelegation(deps: ResumeAfterDelegationDeps): Promise<void> {
	const { host } = deps

	// Clear any ask states that might have been set during history load
	host.askState.clearAsks()

	// Reset abort and streaming state to ensure clean continuation
	host.abort = false
	host.abandoned = false
	host.abortReason = undefined
	host.didFinishAbortingStream = false
	host.stream.isStreaming = false
	host.stream.isWaitingForFirstChunk = false

	// Ensure next API call includes full context after delegation

	// Mark as initialized and active
	host.isInitialized = true
	host.emit(AgentEventName.TaskActive, host.taskId)

	// Load conversation history if not already loaded
	if (host.messageStore.apiConversationHistory.length === 0) {
		host.messageStore.apiConversationHistory = await host.getSavedApiConversationHistory()
	}

	// Add environment details to the existing last user message (which contains the tool_result)
	// This avoids creating a new user message which would cause consecutive user messages
	const environmentDetails = await getEnvironmentDetails(host, true)
	// item 列では environment_details は独立した user message item として並ぶ。
	// 古いものを取り除いてから新しいものを末尾に足す。
	const history = host.messageStore.apiConversationHistory
	for (let i = history.length - 1; i >= 0; i--) {
		if (isEnvironmentDetailsItem(history[i])) history.splice(i, 1)
	}
	history.push({ type: "message", role: "user", content: environmentDetails, ts: Date.now() })

	// Save the updated history
	await host.saveApiConversationHistory()

	// Continue task loop - pass empty array to signal no new user content needed
	// The initiateTaskLoop will handle this by skipping user message addition
	await host.initiateTaskLoop([])
}

/** `<environment_details>` だけで構成された user message item か。 */
function isEnvironmentDetailsItem(item: AgentMessage): boolean {
	if (item.type !== "message" || item.role !== "user") return false
	const text = itemText(item).trim()
	return text.startsWith("<environment_details>") && text.endsWith("</environment_details>")
}
