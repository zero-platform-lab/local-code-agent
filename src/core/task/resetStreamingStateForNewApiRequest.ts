import type { ToolResultBlockParam, TextBlockParam, ImageBlockParam } from "@openai-agent/types"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import type { AssistantMessageContent } from "../assistant-message/types"

/**
 * 新規 API リクエスト開始時に Task の streaming 関連 state をリセットする。
 *
 * 元は recursivelyMakeClineRequests 内のインラインだった 23 行の一括代入。
 * Task 本体は host 型を満たすので `this` を直接渡す形で使う。
 *
 * NativeToolCallParser の parser-global な残留 state もここで一緒にクリアする
 * （前回中断ストリームの残りが次回に混ざらないようにする既存動作）。
 */
export interface TaskStreamingStateHost {
	stream: {
		currentStreamingContentIndex: number
		currentStreamingDidCheckpoint: boolean
		assistantMessageContent: AssistantMessageContent[]
		didCompleteReadingStream: boolean
		userMessageContent: (TextBlockParam | ImageBlockParam | ToolResultBlockParam)[]
		userMessageContentReady: boolean
		didRejectTool: boolean
		didAlreadyUseTool: boolean
		assistantMessageSavedToHistory: boolean
		didToolFailInCurrentTurn: boolean
		presentAssistantMessageLocked: boolean
		presentAssistantMessageHasPendingUpdates: boolean
		streamingToolCallIndices: Map<string, number>
	}
	diffViewProvider: { reset(): Promise<unknown> }
}

export async function resetStreamingStateForNewApiRequest(host: TaskStreamingStateHost): Promise<void> {
	host.stream.currentStreamingContentIndex = 0
	host.stream.currentStreamingDidCheckpoint = false
	host.stream.assistantMessageContent = []
	host.stream.didCompleteReadingStream = false
	host.stream.userMessageContent = []
	host.stream.userMessageContentReady = false
	host.stream.didRejectTool = false
	host.stream.didAlreadyUseTool = false
	host.stream.assistantMessageSavedToHistory = false
	// Reset tool failure flag for each new assistant turn - this ensures that tool failures
	// only prevent attempt_completion within the same assistant message, not across turns
	// (e.g., if a tool fails, then user sends a message saying "just complete anyway")
	host.stream.didToolFailInCurrentTurn = false
	host.stream.presentAssistantMessageLocked = false
	host.stream.presentAssistantMessageHasPendingUpdates = false
	// No legacy text-stream tool parser.
	host.stream.streamingToolCallIndices.clear()
	// Clear any leftover streaming tool call state from previous interrupted streams
	NativeToolCallParser.clearAllStreamingToolCalls()
	NativeToolCallParser.clearRawChunkState()

	await host.diffViewProvider.reset()
}
