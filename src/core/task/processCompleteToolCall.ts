import type { ToolName } from "@openai-agent/types"

import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import type { AssistantMessageContent } from "../assistant-message/types"

/**
 * Legacy: 完成した tool_call chunk（全 argument が一度に届くケース）の処理を
 * Task の中核ループから切り出したもの。
 *
 * `tool_call_partial` は別モジュール（processToolCallPartial）が担当する。
 * 完成 chunk は Native tool 形式を ToolUse へ変換して assistantMessageContent
 * に push し、presentAssistantMessage で逐次 tool を実行する。
 */
export interface ProcessCompleteToolCallStateHost {
	taskId: string
	stream: {
		assistantMessageContent: AssistantMessageContent[]
		userMessageContentReady: boolean
	}

	/**
	 * 伏せ字を元の値へ戻す（`FR-PII-02a`）。
	 *
	 * **解釈の前に戻す。** モデルは伏せ字のまま応答するので、戻さずにファイルへ書くと
	 * `{{email-001}}` という文字列がそのまま書かれる。引数を 1 つの文字列として戻せば、
	 * どの道具のどの欄でも一度に戻る。host に置くのは、完成の経路と逐次の経路が同じ
	 * host を持ち回るためである。
	 */
	unmask?: (text: string) => string
}

export interface ProcessCompleteToolCallDeps {
	host: ProcessCompleteToolCallStateHost
	presentAssistantMessage: () => void
}

export interface CompleteToolCallChunk {
	id: string
	name: string
	arguments: string
}

export function processCompleteToolCall(deps: ProcessCompleteToolCallDeps, chunk: CompleteToolCallChunk): void {
	const { host } = deps

	// Convert native tool call to ToolUse format
	const toolUse = NativeToolCallParser.parseToolCall(
		{
			id: chunk.id,
			name: chunk.name as ToolName,
			arguments: chunk.arguments,
		},
		deps.host.unmask,
	)

	if (!toolUse) {
		console.error(`Failed to parse tool call for task ${host.taskId}:`, chunk)
		return
	}

	// Store the tool call ID on the ToolUse object for later reference
	// This is needed to create tool_result blocks that reference the correct tool_use_id
	toolUse.id = chunk.id

	// Add the tool use to assistant message content
	host.stream.assistantMessageContent.push(toolUse)

	// Mark that we have new content to process
	host.stream.userMessageContentReady = false

	// Present the tool call to user - presentAssistantMessage will execute
	// tools sequentially and accumulate all results in userMessageContent
	deps.presentAssistantMessage()
}
