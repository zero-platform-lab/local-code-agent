import type { AgentMessageContentPart } from "@openai-agent/types"

import { ApiMessage } from "../../core/task-persistence/apiMessages"

import { ApiHandler } from "../index"

/**
 * 画像を扱えないモデル向けに、message item 中の `input_image` をテキストに置き換える。
 *
 * 実際の画像を送れない代わりに「会話に画像があった」ことだけ残す。画像を扱えるモデルでは
 * 何もしない（#344 以前は変換段でこれを無条件に落としていた）。
 */
export function maybeRemoveImageBlocks(messages: ApiMessage[], apiHandler: ApiHandler): ApiMessage[] {
	// Check model capability ONCE instead of for every message
	const supportsImages = apiHandler.getModel().info.supportsImages
	if (supportsImages) return messages

	return messages.map((message) => {
		if (message.type !== "message" || !Array.isArray(message.content)) return message

		const content: AgentMessageContentPart[] = message.content.map((part) =>
			part.type === "input_image" ? { type: "input_text", text: "[Referenced image in conversation]" } : part,
		)
		return { ...message, content }
	})
}
