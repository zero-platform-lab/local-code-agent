import type { ClineAsk, ClineMessage } from "@openai-agent/types"

/**
 * 「どのメッセージをチャットに出すか」の規則。
 *
 * 分割前は `ChatView` の 85 行の `useMemo` にあり、判定の中で LRU キャッシュ
 * (`everVisibleMessagesTsRef`) を読み書きしていたため、規則だけを確かめることが
 * できなかった。ここでは「一度出したことがあるか」を**述語として受け取る**形にして、
 * 記憶そのもの（LRU の寿命管理）は呼び出し側に残している。
 *
 * React にも DOM にも依存しない。
 */

/**
 * 「見たことがある」と記憶しておく直近メッセージ数。表示済み判定と、その後の
 * キャッシュ掃除の両方が同じ窓を使う必要がある。
 */
export const VIEWPORT_MEMORY_SIZE = 100

export interface MessageVisibilityContext {
	/** その ts のメッセージを既に一度表示したか。 */
	hasBeenSeen: (ts: number) => boolean
}

/** 一度処理された後は二度と出さない ask。ユーザーが応答済みなので残すと紛らわしい。 */
const ALWAYS_HIDDEN_ONCE_PROCESSED_ASK: ClineAsk[] = ["api_req_failed", "resume_task", "resume_completed_task"]

/** 同じく、一度処理された後は出さない say。 */
const ALWAYS_HIDDEN_ONCE_PROCESSED_SAY = [
	"api_req_finished",
	"api_req_retried",
	"api_req_deleted",
	"mcp_server_request_started",
]

/** 本文も画像も無い text メッセージは表示しても意味がない。 */
function isEmptyText(message: ClineMessage): boolean {
	return (message.text ?? "") === "" && (message.images?.length ?? 0) === 0
}

/**
 * `checkpoint_saved` を隠すべきか。
 *
 * 2 通りある: 明示的に `suppressMessage` が立っている場合と、ユーザー発言に紐づく
 * チェックポイント（同じ hash を持つ user_feedback がある）の場合。後者は旧実装からの
 * 互換動作で、ユーザー発言の直後に重複してチェックポイント行が出るのを防いでいる。
 */
function isSuppressedCheckpoint(message: ClineMessage, userMessageCheckpointHashes: Set<string>): boolean {
	if (message.say !== "checkpoint_saved") {
		return false
	}

	const checkpoint = message.checkpoint

	if (checkpoint && typeof checkpoint === "object" && "suppressMessage" in checkpoint && checkpoint.suppressMessage) {
		return true
	}

	return !!message.text && userMessageCheckpointHashes.has(message.text)
}

/** ユーザー発言に紐づくチェックポイントの hash を集める（O(1) 参照のため先に作る）。 */
function collectUserMessageCheckpointHashes(messages: ClineMessage[]): Set<string> {
	const hashes = new Set<string>()

	for (const message of messages) {
		if (
			message.say === "user_feedback" &&
			message.checkpoint &&
			message.checkpoint["type"] === "user_message" &&
			message.checkpoint["hash"]
		) {
			hashes.add(message.checkpoint["hash"] as string)
		}
	}

	return hashes
}

/**
 * 表示すべきメッセージだけを残す。
 *
 * 件数の上限は設けない。Virtuoso が仮想化するので長い履歴でも問題にならず、
 * 上限を設けると配列の添字がずれて別の不具合を生む。
 */
export function selectVisibleMessages(messages: ClineMessage[], ctx: MessageVisibilityContext): ClineMessage[] {
	const userMessageCheckpointHashes = collectUserMessageCheckpointHashes(messages)

	return messages.filter((message) => {
		if (isSuppressedCheckpoint(message, userMessageCheckpointHashes)) {
			return false
		}

		// 一度出したものは、以後は「消えないもの」だけを残す。ここを通ると
		// 下の初回判定（ストリーミング途中の空メッセージ等）には落ちない。
		if (ctx.hasBeenSeen(message.ts)) {
			if (message.ask && ALWAYS_HIDDEN_ONCE_PROCESSED_ASK.includes(message.ask)) {
				return false
			}

			if (message.say && ALWAYS_HIDDEN_ONCE_PROCESSED_SAY.includes(message.say)) {
				return false
			}

			return !(message.say === "text" && isEmptyText(message))
		}

		switch (message.ask) {
			case "completion_result":
				// 本文が来る前の器だけの completion は出さない。
				if (message.text === "") {
					return false
				}
				break
			case "api_req_failed":
			case "resume_task":
			case "resume_completed_task":
				// これらはボタンとして表示するので、行としては出さない。
				return false
		}

		switch (message.say) {
			case "api_req_finished":
			case "api_req_retried":
			case "api_req_deleted":
				return false
			case "api_req_retry_delayed":
			case "api_req_rate_limit_wait": {
				// 待機中の告知は「今まさに最後のメッセージ」のときだけ出す。
				// 例外として、履歴復帰の resume_task がその直後に積まれた場合は、
				// 待機理由が見えないと不親切なので残す。比較は参照同一性で行う。
				const last1 = messages.at(-1)
				const last2 = messages.at(-2)

				if (last1?.ask === "resume_task" && last2 === message) {
					return true
				}

				if (message !== last1) {
					return false
				}

				break
			}
			case "text":
				if (isEmptyText(message)) {
					return false
				}
				break
			case "mcp_server_request_started":
				return false
		}

		return true
	})
}

/** 表示済みとして覚えておくべきメッセージ（末尾 {@link VIEWPORT_MEMORY_SIZE} 件）。 */
export function messagesToRemember(visibleMessages: ClineMessage[]): ClineMessage[] {
	return visibleMessages.slice(Math.max(0, visibleMessages.length - VIEWPORT_MEMORY_SIZE))
}
