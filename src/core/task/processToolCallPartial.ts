import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import type { AssistantMessageContent } from "../assistant-message/types"
import { type ToolName } from "@openai-agent/types"
import type { ToolUse } from "../../shared/tools"

/**
 * ストリーミング中の tool_call chunk 処理。
 *
 * `NativeToolCallParser.processRawChunk` から届く3種のイベント（start / delta / end）を
 * assistantMessageContent の状態に反映する。**同じ ID の重複 tool_call_start は無視**
 * するのが重要（Anthropic API の "tool_use ids must be unique" 対策）。
 *
 * `tool_call_end` の malformed JSON 対応（partial=false にして validation 側で失敗させる）
 * は既に切り出し済みの `finalizeStreamingToolCalls` と同一の設計。streaming 中と
 * ストリーム終端で同じ finalize ロジックが呼ばれる。
 */
export interface ProcessToolCallPartialStateHost {
	taskId: string
	stream: {
		streamingToolCallIndices: Map<string, number>
		assistantMessageContent: AssistantMessageContent[]
		userMessageContentReady: boolean
	}
}

export interface ProcessToolCallPartialDeps {
	host: ProcessToolCallPartialStateHost
	presentAssistantMessage: () => void
}

export function processToolCallPartial(
	deps: ProcessToolCallPartialDeps,
	chunk: { index: number; id?: string; name?: string; arguments?: string },
): void {
	const { host } = deps
	// Process raw tool call chunk through NativeToolCallParser
	// which handles tracking, buffering, and emits events
	const events = NativeToolCallParser.processRawChunk({
		index: chunk.index,
		id: chunk.id,
		name: chunk.name,
		arguments: chunk.arguments,
	})

	for (const event of events) {
		if (event.type === "tool_call_start") {
			// Guard against duplicate tool_call_start events for the same tool ID.
			// This can occur due to stream retry, reconnection, or API quirks.
			// Without this check, duplicate tool_use blocks with the same ID would
			// be added to assistantMessageContent, causing API 400 errors:
			// "tool_use ids must be unique"
			if (host.stream.streamingToolCallIndices.has(event.id)) {
				console.warn(
					`[Task#${host.taskId}] Ignoring duplicate tool_call_start for ID: ${event.id} (tool: ${event.name})`,
				)
				continue
			}

			// Initialize streaming in NativeToolCallParser
			NativeToolCallParser.startStreamingToolCall(event.id, event.name as ToolName)

			// Before adding a new tool, finalize any preceding text block
			// This prevents the text block from blocking tool presentation
			const lastBlock = host.stream.assistantMessageContent[host.stream.assistantMessageContent.length - 1]
			if (lastBlock?.type === "text" && lastBlock.partial) {
				lastBlock.partial = false
			}

			// Track the index where this tool will be stored
			const toolUseIndex = host.stream.assistantMessageContent.length
			host.stream.streamingToolCallIndices.set(event.id, toolUseIndex)

			// Create initial partial tool use
			const partialToolUse: ToolUse = {
				type: "tool_use",
				name: event.name as ToolName,
				params: {},
				partial: true,
			}

			// Store the ID for native protocol
			;(partialToolUse as any).id = event.id

			// Add to content and present
			host.stream.assistantMessageContent.push(partialToolUse)
			host.stream.userMessageContentReady = false
			deps.presentAssistantMessage()
		} else if (event.type === "tool_call_delta") {
			// Process chunk using streaming JSON parser
			const partialToolUse = NativeToolCallParser.processStreamingChunk(event.id, event.delta)

			if (partialToolUse) {
				// Get the index for this tool call
				const toolUseIndex = host.stream.streamingToolCallIndices.get(event.id)
				if (toolUseIndex !== undefined) {
					// Store the ID for native protocol
					;(partialToolUse as any).id = event.id

					// Update the existing tool use with new partial data
					host.stream.assistantMessageContent[toolUseIndex] = partialToolUse

					// Present updated tool use
					deps.presentAssistantMessage()
				}
			}
		} else if (event.type === "tool_call_end") {
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
				// Mark the tool as non-partial so it's presented as complete, but execution
				// will be short-circuited in presentAssistantMessage with a structured tool_result.
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
}
