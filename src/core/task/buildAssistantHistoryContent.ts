import type { MessageParam, ToolResultBlockParam, TextBlockParam, ToolUseBlockParam } from "@openai-agent/types"
import { sanitizeToolUseId } from "../../utils/tool-id"

import type { AssistantMessageContent } from "../assistant-message/types"
import type { McpToolUse, ToolUse } from "../../shared/tools"

/**
 * ストリーム終了後、assistant のメッセージ本文と tool_use ブロックを API 会話履歴用の
 * `MessageParam` に組み立てて保存するまでの一連の処理。
 *
 * recursivelyMakeClineRequests の中から切り出したもので、以下を担う:
 * 1. text と tool_use ブロックから assistantContent 配列を構築
 * 2. **tool_use ID の重複を pre-flight で排除**（Anthropic API 400: "tool_use ids must be unique" 対策）
 * 3. **new_task isolation**: new_task が他のツールと同ターンで呼ばれたら、後続ツールを truncate して
 *    "not executed" 相当の tool_result を pending queue に積む（delegation で親タスクが dispose される
 *    ため、後続の孤児ツール実行を防ぐ）
 * 4. assistant メッセージを API 会話履歴へ保存（ツール実行より **前** に保存するのが重要:
 *    new_task の delegation 内で flushPendingToolResultsToHistory() が呼ばれるため、assistant メッセージが
 *    先に無いと tool_result が tool_use の前に並んでしまう）
 */
export interface BuildAssistantHistoryDeps {
	taskId: string
	/**
	 * `stream.assistantMessageContent` は Task 側の可変配列（StreamingSession が実体）。
	 * new_task isolation の実行状態同期のため、長さの書き換え（truncate）を含む参照渡し。
	 */
	stream: {
		assistantMessageContent: AssistantMessageContent[]
	}
	addToApiConversationHistory: (message: MessageParam, reasoning?: string) => Promise<unknown>
	pushToolResultToUserContent: (toolResult: ToolResultBlockParam) => boolean
	setAssistantMessageSavedToHistory: (v: boolean) => void
}

export async function buildAssistantHistoryContent(
	deps: BuildAssistantHistoryDeps,
	assistantMessage: string,
	reasoningMessage: string | undefined,
): Promise<void> {
	// Build the assistant message content array
	const assistantContent: Array<TextBlockParam | ToolUseBlockParam> = []

	// Add text content if present
	if (assistantMessage) {
		assistantContent.push({
			type: "text" as const,
			text: assistantMessage,
		})
	}

	// Add tool_use blocks with their IDs for native protocol
	// This handles both regular ToolUse and McpToolUse types
	// IMPORTANT: Track seen IDs to prevent duplicates in the API request.
	// Duplicate tool_use IDs cause Anthropic API 400 errors:
	// "tool_use ids must be unique"
	const seenToolUseIds = new Set<string>()
	const toolUseBlocks = deps.stream.assistantMessageContent.filter(
		(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
	)
	for (const block of toolUseBlocks) {
		if (block.type === "mcp_tool_use") {
			// McpToolUse already has the original tool name (e.g., "mcp_serverName_toolName")
			// The arguments are the raw tool arguments (matching the simplified schema)
			const mcpBlock = block as McpToolUse
			if (mcpBlock.id) {
				const sanitizedId = sanitizeToolUseId(mcpBlock.id)
				// Pre-flight deduplication: Skip if we've already added this ID
				if (seenToolUseIds.has(sanitizedId)) {
					console.warn(
						`[Task#${deps.taskId}] Pre-flight deduplication: Skipping duplicate MCP tool_use ID: ${sanitizedId} (tool: ${mcpBlock.name})`,
					)
					continue
				}
				seenToolUseIds.add(sanitizedId)
				assistantContent.push({
					type: "tool_use" as const,
					id: sanitizedId,
					name: mcpBlock.name,
					input: mcpBlock.arguments,
				})
			}
		} else {
			// Regular ToolUse
			const toolUse = block as ToolUse
			const toolCallId = toolUse.id
			if (toolCallId) {
				const sanitizedId = sanitizeToolUseId(toolCallId)
				// Pre-flight deduplication: Skip if we've already added this ID
				if (seenToolUseIds.has(sanitizedId)) {
					console.warn(
						`[Task#${deps.taskId}] Pre-flight deduplication: Skipping duplicate tool_use ID: ${sanitizedId} (tool: ${toolUse.name})`,
					)
					continue
				}
				seenToolUseIds.add(sanitizedId)
				const input = toolUse.nativeArgs || toolUse.params

				// Use originalName (alias) if present for API history consistency.
				// When tool aliases are used (e.g., "edit_file" -> "search_and_replace" -> "edit" (current canonical name)),
				// we want the alias name in the conversation history to match what the model
				// was told the tool was named, preventing confusion in multi-turn conversations.
				const toolNameForHistory = toolUse.originalName ?? toolUse.name

				assistantContent.push({
					type: "tool_use" as const,
					id: sanitizedId,
					name: toolNameForHistory,
					input,
				})
			}
		}
	}

	// Enforce new_task isolation: if new_task is called alongside other tools,
	// truncate any tools that come after it and inject error tool_results.
	// This prevents orphaned tools when delegation disposes the parent task.
	const newTaskIndex = assistantContent.findIndex((block) => block.type === "tool_use" && block.name === "new_task")

	if (newTaskIndex !== -1 && newTaskIndex < assistantContent.length - 1) {
		const truncatedTools = assistantContent.slice(newTaskIndex + 1)
		assistantContent.length = newTaskIndex + 1

		const executionNewTaskIndex = deps.stream.assistantMessageContent.findIndex(
			(block) => block.type === "tool_use" && block.name === "new_task",
		)
		if (executionNewTaskIndex !== -1) {
			deps.stream.assistantMessageContent.length = executionNewTaskIndex + 1
		}

		for (const tool of truncatedTools) {
			if (tool.type === "tool_use" && (tool as ToolUseBlockParam).id) {
				deps.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: (tool as ToolUseBlockParam).id,
					content:
						"This tool was not executed because new_task was called in the same message turn. The new_task tool must be the last tool in a message.",
					is_error: true,
				})
			}
		}
	}

	// Save assistant message BEFORE executing tools.
	await deps.addToApiConversationHistory(
		{ role: "assistant", content: assistantContent },
		reasoningMessage || undefined,
	)
	deps.setAssistantMessageSavedToHistory(true)
}
