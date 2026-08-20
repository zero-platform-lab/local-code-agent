import type { ClineAsk, ClineAskResponse, QueuedMessage } from "@openai-agent/types"

/**
 * `Task.ask()` の中で、queue に貯まった user message を1件取り出して現在の ask に
 * 応答として流し込む共通処理。以下 2 箇所から呼ばれていた同じロジックを1つに集約:
 *
 * - status mutable でない時（メッセージが既に queue に入っている状態で新規 ask が
 *   来た場合、queue 消化を優先する）
 * - pWaitFor ループ中（ask 応答を待っている間に queue にメッセージが arrive
 *   したら task が hang しないよう即 consume する）
 *
 * ツール系 ask（tool / command / use_mcp_server）は yesButtonClicked で
 * 「承認 + 追加テキスト」として扱う。それ以外は messageResponse として直接
 * fulfill する。
 */
export interface DrainQueuedMessageForAskHost {
	messageQueueService: { dequeueMessage(): QueuedMessage | undefined }
	handleWebviewAskResponse: (askResponse: ClineAskResponse, text?: string, images?: string[]) => void
}

export function drainQueuedMessageForAsk(host: DrainQueuedMessageForAskHost, type: ClineAsk): void {
	const message = host.messageQueueService.dequeueMessage()
	if (!message) {
		return
	}

	// For tool approvals, we need to approve first (yesButtonClicked), then send
	// the message if there's text/images. For other ask types (like followup or
	// command_output), fulfill the ask directly with messageResponse.
	const askResponse: ClineAskResponse =
		type === "tool" || type === "command" || type === "use_mcp_server" ? "yesButtonClicked" : "messageResponse"

	host.handleWebviewAskResponse(askResponse, message.text, message.images)
}
