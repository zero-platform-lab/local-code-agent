import type { ApiStreamChunk } from "../../api/transform/stream"

import { processReasoningChunk, processTextChunk, type ProcessTextChunkStateHost } from "./processStreamTextChunks"
import { processCompleteToolCall, type ProcessCompleteToolCallStateHost } from "./processCompleteToolCall"
import { processToolCallPartial, type ProcessToolCallPartialStateHost } from "./processToolCallPartial"
import type { UsageAccumulatorState } from "./drainStreamInBackgroundToFindAllUsage"
import type { ClineSay } from "@openai-agent/types"

/**
 * stream の 1 chunk を種類別に振り分ける薄い dispatcher。
 *
 * 6 種類のいずれか:
 *  - reasoning / text: assistant message / reasoning message の累積文字列を返す（immutable string）
 *  - usage: `tokens` オブジェクトに += で加算（in-place mutation）
 *  - tool_call_partial: NativeToolCallParser で streaming tool_call を段階的に構築
 *  - tool_call: 完成 tool_call を assistantMessageContent に push（legacy）
 *
 * 呼び出し側は message 2 変数を返り値で受け取り、tokens は参照渡しなので再代入不要。
 */
export type ProcessStreamChunkStateHost = ProcessTextChunkStateHost &
	ProcessCompleteToolCallStateHost &
	ProcessToolCallPartialStateHost

export interface ProcessStreamChunkDeps {
	host: ProcessStreamChunkStateHost
	presentAssistantMessage: () => void
	say: (type: ClineSay, text: string, images: undefined, partial: true) => Promise<unknown>
}

export interface ProcessStreamChunkMessages {
	reasoningMessage: string
	assistantMessage: string
}

export async function processStreamChunk(
	deps: ProcessStreamChunkDeps,
	chunk: ApiStreamChunk,
	messages: ProcessStreamChunkMessages,
	tokens: UsageAccumulatorState,
): Promise<ProcessStreamChunkMessages> {
	let { reasoningMessage, assistantMessage } = messages

	switch (chunk.type) {
		case "reasoning": {
			reasoningMessage = await processReasoningChunk({ say: deps.say }, chunk.text, reasoningMessage)
			break
		}
		case "usage":
			tokens.input += chunk.inputTokens
			tokens.output += chunk.outputTokens
			tokens.cacheRead += chunk.cacheReadTokens ?? 0
			tokens.total = chunk.totalCost
			break
		case "tool_call_partial":
			processToolCallPartial(
				{ host: deps.host, presentAssistantMessage: deps.presentAssistantMessage },
				{ index: chunk.index, id: chunk.id, name: chunk.name, arguments: chunk.arguments },
			)
			break
		case "tool_call":
			processCompleteToolCall(
				{ host: deps.host, presentAssistantMessage: deps.presentAssistantMessage },
				{ id: chunk.id, name: chunk.name, arguments: chunk.arguments },
			)
			break
		case "text":
			assistantMessage = processTextChunk(
				{ host: deps.host, presentAssistantMessage: deps.presentAssistantMessage },
				chunk.text,
				assistantMessage,
			)
			break
	}

	return { reasoningMessage, assistantMessage }
}
