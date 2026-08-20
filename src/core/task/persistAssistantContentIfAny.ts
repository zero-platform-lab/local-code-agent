import type { MessageParam, ToolResultBlockParam } from "@openai-agent/types"
import type { AssistantMessageContent } from "../assistant-message/types"
import { buildAssistantHistoryContent } from "./buildAssistantHistoryContent"

/**
 * ストリーム完了後、アシスタント側に何かしらの content（text か tool_use）が
 * あった場合に走る一連の処理:
 *
 * 1. consecutiveNoAssistantMessagesCount を 0 にリセット
 * 3. buildAssistantHistoryContent で assistant message を API 履歴に保存
 *
 * 呼び出し側は「hasContent かどうか」を判定してから、hasContent 時のみ本関数を呼ぶ。
 * hasContent が false の場合の分岐（empty response）は handleEmptyAssistantResponse
 * が別途担当する。
 */
export interface PersistAssistantContentStateHost {
	taskId: string
	stream: {
		assistantMessageContent: AssistantMessageContent[]
		assistantMessageSavedToHistory: boolean
	}
	graceRetry: { noAssistantMessages: number }
}

export interface PersistAssistantContentDeps {
	host: PersistAssistantContentStateHost
	say: (
		type: "text",
		text: string,
		images: undefined,
		partial: false,
		checkpoint: undefined,
		progressStatus: undefined,
		options: { isNonInteractive: boolean },
	) => Promise<unknown>
	addToApiConversationHistory: (message: MessageParam, reasoning?: string) => Promise<unknown>
	pushToolResultToUserContent: (toolResult: ToolResultBlockParam) => boolean
}

export async function persistAssistantContentIfAny(
	deps: PersistAssistantContentDeps,
	assistantMessage: string,
	reasoningMessage: string,
): Promise<void> {
	const { host } = deps

	// Reset counter when we get a successful response with content
	host.graceRetry.noAssistantMessages = 0

	await buildAssistantHistoryContent(
		{
			taskId: host.taskId,
			stream: host.stream,
			addToApiConversationHistory: deps.addToApiConversationHistory,
			pushToolResultToUserContent: deps.pushToolResultToUserContent,
			setAssistantMessageSavedToHistory: (v) => {
				host.stream.assistantMessageSavedToHistory = v
			},
		},
		assistantMessage,
		reasoningMessage,
	)
}
