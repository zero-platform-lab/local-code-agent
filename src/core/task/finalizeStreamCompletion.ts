import type { AssistantMessageContent } from "../assistant-message/types"
import type { ClineMessage } from "@openai-agent/types"

import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import { finalizeStreamingToolCalls as runFinalizeStreamingToolCalls } from "./finalizeStreamingToolCalls"
import { finalizeReasoningMessage } from "./finalizeReasoningMessage"

/**
 * stream 完了直後にまとめて行う 5 段のクリーンアップ:
 *
 * 1. `NativeToolCallParser.finalizeRawChunks()` で残っている stream event を回収
 * 2. `finalizeStreamingToolCalls` で partial tool_call を final に置換
 * 3. まだ `partial: true` の block を non-partial に落とす（`partialBlocks` として返す）
 * 4. `finalizeReasoningMessage` で reasoning が partial のまま残っていたら確定
 * 5. `saveClineMessages` → `postStateToWebviewWithoutTaskHistory`
 *
 * `partialBlocks` は呼び出し側で「まだ present していない block があれば
 * `presentAssistantMessage` を呼ぶ」のに使う。
 */
export interface FinalizeStreamCompletionStateHost {
	stream: {
		streamingToolCallIndices: Map<string, number>
		assistantMessageContent: AssistantMessageContent[]
		userMessageContentReady: boolean
	}
	messageStore: { clineMessages: ClineMessage[] }
}

export interface FinalizeStreamCompletionDeps {
	host: FinalizeStreamCompletionStateHost
	presentAssistantMessage: () => void
	updateClineMessage: (m: ClineMessage) => Promise<unknown>
	saveClineMessages: () => Promise<unknown>
	postStateToWebviewWithoutTaskHistory: () => Promise<unknown> | undefined
}

export async function finalizeStreamCompletion(
	deps: FinalizeStreamCompletionDeps,
	reasoningMessage: string,
): Promise<{ partialBlocks: AssistantMessageContent[] }> {
	const { host } = deps

	// Finalize any remaining streaming tool calls that weren't explicitly ended
	// This is critical for MCP tools which need tool_call_end events to be properly
	// converted from ToolUse to McpToolUse via finalizeStreamingToolCall()
	const finalizeEvents = NativeToolCallParser.finalizeRawChunks()
	runFinalizeStreamingToolCalls(finalizeEvents, {
		host,
		presentAssistantMessage: deps.presentAssistantMessage,
	})

	// IMPORTANT: Capture partialBlocks AFTER finalizeRawChunks() to avoid double-presentation.
	// Tools finalized above are already presented, so we only want blocks still partial after finalization.
	const partialBlocks = host.stream.assistantMessageContent.filter((block) => block.partial)
	partialBlocks.forEach((block) => (block.partial = false))

	await finalizeReasoningMessage({ host, updateClineMessage: deps.updateClineMessage }, reasoningMessage)

	await deps.saveClineMessages()
	await deps.postStateToWebviewWithoutTaskHistory()

	return { partialBlocks }
}
