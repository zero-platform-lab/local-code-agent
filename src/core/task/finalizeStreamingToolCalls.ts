import { NativeToolCallParser, type ToolCallStreamEvent } from "../assistant-message/NativeToolCallParser"
import type { AssistantMessageContent } from "../assistant-message/types"

/**
 * ストリームが終端したときに残っている「部分状態の tool_call」を確定させる処理。
 *
 * `NativeToolCallParser.finalizeRawChunks()` から届く finalize イベントを受け取り、
 * 対応する partial な tool_use ブロックを完成版に置き換えて再提示する。
 * 完成版が得られなかった場合（args が不正 or 不完全）は partial フラグだけ外して
 * ツールの validation に判定を委ねる。
 *
 * ここは Task の中核ループから切り出した純度の高い処理で、`presentAssistantMessage` の
 * 呼び出しを含む（結果を UI に反映するため）が、Task 型そのものへは依存しない。
 */

export interface FinalizeStreamingToolCallsStateHost {
	stream: {
		/**
		 * `streamingToolCallIndices[event.id] === assistantMessageContent の index`。
		 * Map と配列は参照渡しで get/delete と添え字書き換えを行う。
		 */
		streamingToolCallIndices: Map<string, number>
		assistantMessageContent: AssistantMessageContent[]
		/** 新しい tool_call が確定したので、次の processing round を待つよう state を戻す。 */
		userMessageContentReady: boolean
	}
}

export interface FinalizeStreamingToolCallsDeps {
	host: FinalizeStreamingToolCallsStateHost
	/** partial → complete への置換後、UI に反映する（実質 `presentAssistantMessage(task)` のラップ）。 */
	presentAssistantMessage: () => void
}

export function finalizeStreamingToolCalls(
	finalizeEvents: ToolCallStreamEvent[],
	deps: FinalizeStreamingToolCallsDeps,
): void {
	const { host } = deps

	for (const event of finalizeEvents) {
		if (event.type !== "tool_call_end") {
			continue
		}

		// Finalize the streaming tool call
		const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id)

		// Get the index for this tool call
		const toolUseIndex = host.stream.streamingToolCallIndices.get(event.id)

		if (finalToolUse) {
			// Store the tool call ID
			;(finalToolUse as any).id = event.id

			// Get the index and replace partial with final
			if (toolUseIndex !== undefined) {
				host.stream.assistantMessageContent[toolUseIndex] = finalToolUse
			}

			// Clean up tracking
			host.stream.streamingToolCallIndices.delete(event.id)

			// Mark that we have new content to process
			host.stream.userMessageContentReady = false

			// Present the finalized tool call
			deps.presentAssistantMessage()
		} else if (toolUseIndex !== undefined) {
			// finalizeStreamingToolCall returned null (malformed JSON or missing args)
			// We still need to mark the tool as non-partial so it gets executed
			// The tool's validation will catch any missing required parameters
			const existingToolUse = host.stream.assistantMessageContent[toolUseIndex]
			if (existingToolUse && existingToolUse.type === "tool_use") {
				existingToolUse.partial = false
				// Ensure it has the ID for native protocol
				;(existingToolUse as any).id = event.id
			}

			// Clean up tracking
			host.stream.streamingToolCallIndices.delete(event.id)

			// Mark that we have new content to process
			host.stream.userMessageContentReady = false

			// Present the tool call - validation will handle missing params
			deps.presentAssistantMessage()
		}
	}
}
