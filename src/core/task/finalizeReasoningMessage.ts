import type { ClineMessage } from "@openai-agent/types"

import { findLastIndex } from "../../shared/array"

/**
 * ストリーム完了時に「まだ partial 状態で残っている reasoning message」を確定する。
 *
 * `this.say("reasoning", ...)` は最後のメッセージが reasoning でない場合
 * （途中で text ブロックや tool_use が挿入された場合）に使えないので、
 * findLastIndex で走査して直接 `partial = false` にした上で永続化する。
 *
 * reasoningMessage が空文字なら何もしない。
 */
export interface FinalizeReasoningMessageStateHost {
	messageStore: { clineMessages: ClineMessage[] }
}

export interface FinalizeReasoningMessageDeps {
	host: FinalizeReasoningMessageStateHost
	updateClineMessage: (message: ClineMessage) => Promise<unknown>
}

export async function finalizeReasoningMessage(
	deps: FinalizeReasoningMessageDeps,
	reasoningMessage: string,
): Promise<void> {
	if (!reasoningMessage) {
		return
	}

	const { host } = deps
	const lastReasoningIndex = findLastIndex(
		host.messageStore.clineMessages,
		(m) => m.type === "say" && m.say === "reasoning",
	)

	if (lastReasoningIndex !== -1 && host.messageStore.clineMessages[lastReasoningIndex].partial) {
		host.messageStore.clineMessages[lastReasoningIndex].partial = false
		await deps.updateClineMessage(host.messageStore.clineMessages[lastReasoningIndex])
	}
}
