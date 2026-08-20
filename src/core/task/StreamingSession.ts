import type { ToolResultBlockParam, TextBlockParam, ImageBlockParam } from "@openai-agent/types"
import type { ModelInfo } from "@openai-agent/types"

import type { AssistantMessageContent } from "../assistant-message/types"

/**
 * Task の「1 request 分の streaming 状態」を凝集した collaborator。
 *
 * 元は Task class に 17 field ばら撒きだったのを 1 object に集約:
 *
 * **Buffers**（stream 中に累積、iteration の終わりで clear）:
 * - `assistantMessageContent`: streaming で構築中の assistant message ブロック列
 * - `userMessageContent`: tool_result 保留キュー（flush で API 履歴へ）
 * - `userMessageContentReady`: 上のバッファが flush 可能か
 * - `assistantMessageSavedToHistory`: 並列 tool 呼び出し race guard
 *
 * **Lifecycle flags**（stream の進行状態）:
 * - `isStreaming` / `isWaitingForFirstChunk`: HTTP 受信の位相
 * - `currentStreamingContentIndex`: presentAssistantMessage が処理中の block index
 * - `currentStreamingDidCheckpoint`: 現ストリームで既に checkpoint を作ったか
 * - `presentAssistantMessageLocked` / `HasPendingUpdates`: presentAssistantMessage の
 *   再入禁止 lock と保留フラグ
 * - `streamingToolCallIndices`: native tool call 用（Map<toolId, index>）
 * - `cachedStreamingModel`: getModel() 反復呼び出し回避
 *
 * **Turn flags**（1 iteration 内での tool 実行結果）:
 * - `didRejectTool` / `didAlreadyUseTool` / `didToolFailInCurrentTurn` / `didCompleteReadingStream`
 *
 * **HTTP abort**:
 * - `currentRequestAbortController`: 現在の HTTP request の abort ハンドル
 *
 * これらは cohesion が高く（全て streaming iteration に紐付く）、`resetStreamingStateForNewApiRequest`
 * 相当のリセット処理が明確な単位。
 */
export class StreamingSession {
	// Buffers
	assistantMessageContent: AssistantMessageContent[] = []
	userMessageContent: (TextBlockParam | ImageBlockParam | ToolResultBlockParam)[] = []
	userMessageContentReady = false
	assistantMessageSavedToHistory = false

	// Lifecycle
	isStreaming = false
	isWaitingForFirstChunk = false
	currentStreamingContentIndex = 0
	currentStreamingDidCheckpoint = false
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	streamingToolCallIndices = new Map<string, number>()
	cachedStreamingModel?: { id: string; info: ModelInfo }

	// Per-turn tool flags
	didRejectTool = false
	didAlreadyUseTool = false
	didToolFailInCurrentTurn = false
	didCompleteReadingStream = false

	// HTTP abort
	currentRequestAbortController?: AbortController
}
