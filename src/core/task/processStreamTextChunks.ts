import type { ClineSay } from "@openai-agent/types"

import type { AssistantMessageContent } from "../assistant-message/types"

/**
 * reasoning / text chunk の処理を Task の中核ループから切り出したもの。
 *
 * どちらも「外側で累積している message 文字列に chunk のテキストを足して、
 * 現在の状態に反映する」だけの処理。呼び出し側から現在値を受け取り、
 * 更新後の値を返す。
 */

/**
 * reasoning chunk 処理。累積 reasoning message に chunk.text を足して整形し、
 * webview に partial として流す。
 *
 * `**Title**` が sentence-ending punctuation の直後にある場合は改行を挿入する
 * （section header を視認しやすくするためのフォーマット）。
 */
export interface ProcessReasoningChunkDeps {
	say: (type: ClineSay, text: string, images: undefined, partial: true) => Promise<unknown>
}

export async function processReasoningChunk(
	deps: ProcessReasoningChunkDeps,
	chunkText: string,
	currentReasoningMessage: string,
): Promise<string> {
	const reasoningMessage = currentReasoningMessage + chunkText

	// Only apply formatting if the message contains sentence-ending punctuation followed by **
	let formattedReasoning = reasoningMessage
	if (reasoningMessage.includes("**")) {
		// Add line breaks before **Title** patterns that appear after sentence endings
		// This targets section headers like "...end of sentence.**Title Here**"
		// Handles periods, exclamation marks, and question marks
		formattedReasoning = reasoningMessage.replace(/([.!?])\*\*([^*\n]+)\*\*/g, "$1\n\n**$2**")
	}

	await deps.say("reasoning", formattedReasoning, undefined, true)

	return reasoningMessage
}

/**
 * text chunk 処理。累積 assistant message に chunk.text を足して、
 * assistantMessageContent の末尾の partial text block を更新（無ければ新規作成）。
 */
export interface ProcessTextChunkStateHost {
	stream: {
		assistantMessageContent: AssistantMessageContent[]
		userMessageContentReady: boolean
	}
}

export interface ProcessTextChunkDeps {
	host: ProcessTextChunkStateHost
	presentAssistantMessage: () => void
}

export function processTextChunk(
	deps: ProcessTextChunkDeps,
	chunkText: string,
	currentAssistantMessage: string,
): string {
	const { host } = deps
	const assistantMessage = currentAssistantMessage + chunkText

	// Native tool calling: text chunks are plain text.
	// Create or update a text content block directly
	const lastBlock = host.stream.assistantMessageContent[host.stream.assistantMessageContent.length - 1]
	if (lastBlock?.type === "text" && lastBlock.partial) {
		lastBlock.content = assistantMessage
	} else {
		host.stream.assistantMessageContent.push({
			type: "text",
			content: assistantMessage,
			partial: true,
		})
		host.stream.userMessageContentReady = false
	}
	deps.presentAssistantMessage()

	return assistantMessage
}
