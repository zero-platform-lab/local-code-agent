import type { ContentBlockParam } from "@openai-agent/types"
import { type ClineApiReqCancelReason } from "@openai-agent/types"
import { serializeError } from "serialize-error"

import { t } from "../../i18n"

/**
 * ストリーミング中断エラー（mid-stream failure / user cancel）のリカバリ処理。
 *
 * `recursivelyMakeClineRequests` の while ループの内側 try/catch から切り出したもの。
 * 呼び出し側の while ループ制御に触れないよう、戻り値 `MidStreamAction` で
 * "continue" / "break" と「stack に push すべき項目」を通知する。
 *
 * `abortStream` は Task 側のクロージャ（updateApiReqMsg / トークン変数への closure 依存）
 * なので、コールバック `abortStream` として deps で受ける形にした。
 */
export interface HandleMidStreamErrorStateHost {
	taskId: string
	instanceId: string | number
	abort: boolean
	abandoned: boolean
	abortReason?: ClineApiReqCancelReason
}

export interface HandleMidStreamErrorDeps {
	host: HandleMidStreamErrorStateHost
	abortStream: (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => Promise<void>
	abortTask: () => Promise<unknown>
	getProviderState: () => Promise<{ autoApprovalEnabled?: boolean } | undefined>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
}

export type MidStreamAction =
	| { action: "continue"; retryStackItem?: MidStreamRetryStackItem }
	| { action: "break" }
	| { action: "noop" } // abandoned — 何もせず finally へ

export interface MidStreamRetryStackItem {
	userContent: ContentBlockParam[]
	includeFileDetails: false
	retryAttempt: number
}

export async function handleMidStreamError(
	deps: HandleMidStreamErrorDeps,
	error: unknown,
	currentUserContent: ContentBlockParam[],
	previousRetryAttempt: number,
): Promise<MidStreamAction> {
	const { host } = deps

	// Abandoned happens when extension is no longer waiting for the
	// Cline instance to finish aborting (error is thrown here when
	// any function in the for loop throws due to this.abort).
	if (host.abandoned) {
		return { action: "noop" }
	}

	// Determine cancellation reason
	const isUserCancel = host.abort
	const cancelReason: ClineApiReqCancelReason = isUserCancel ? "user_cancelled" : "streaming_failed"

	const err = error as { message?: string }
	const rawErrorMessage = err.message ?? JSON.stringify(serializeError(err), null, 2)
	const streamingFailedMessage = isUserCancel
		? undefined
		: `${t("common:interruption.streamTerminatedByProvider")}: ${rawErrorMessage}`

	// Clean up partial state
	await deps.abortStream(cancelReason, streamingFailedMessage)

	if (isUserCancel) {
		// User cancelled - abort the entire task
		host.abortReason = cancelReason
		await deps.abortTask()
		return { action: "noop" }
	}

	// Stream failed - log the error and retry with the same content
	// The existing rate limiting will prevent rapid retries
	console.error(`[Task#${host.taskId}.${host.instanceId}] Stream failed, will retry: ${streamingFailedMessage}`)

	// Apply exponential backoff similar to first-chunk errors when auto-resubmit is enabled
	const stateForBackoff = await deps.getProviderState()
	if (stateForBackoff?.autoApprovalEnabled) {
		await deps.backoffAndAnnounce(previousRetryAttempt, error)

		// Check if task was aborted during the backoff
		if (host.abort) {
			console.log(`[Task#${host.taskId}.${host.instanceId}] Task aborted during mid-stream retry backoff`)
			// Abort the entire task
			host.abortReason = "user_cancelled"
			await deps.abortTask()
			return { action: "break" }
		}
	}

	// Push the same content back onto the stack to retry, incrementing the retry attempt counter
	return {
		action: "continue",
		retryStackItem: {
			userContent: currentUserContent,
			includeFileDetails: false,
			retryAttempt: previousRetryAttempt + 1,
		},
	}
}
