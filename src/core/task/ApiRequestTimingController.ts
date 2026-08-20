import delay from "delay"

import { type ClineSay } from "@openai-agent/types"

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes

export interface ApiRequestTimingState {
	requestDelaySeconds?: number
	apiConfiguration?: { rateLimitSeconds?: number }
}

/**
 * ApiRequestTimingController の host。Task を直接渡す narrow 形式。
 * `providerRef.deref()?.getState()` を都度呼ぶ・field は Task の field を構造的に満たす。
 */
export interface ApiRequestTimingHost {
	taskId: string
	abort: boolean
	apiConfiguration: { rateLimitSeconds?: number }
	providerRef: WeakRef<{ getState(): Promise<ApiRequestTimingState | undefined> }>
	say(type: ClineSay, text?: string, images?: string[], partial?: boolean): Promise<void>
}

/**
 * API リクエストのタイミング制御（プロバイダのレート制限待ち・失敗時の指数バックオフ告知）を
 * Task から分離したもの。挙動は元の Task 実装を逐語で保持する。
 *
 * `lastGlobalApiRequestTime` は Task の static。Task から setter/getter を渡す代わりに
 * この module が Task class を import すると循環になるので、`lastGlobalApiRequestTimeRef`
 * ラッパーオブジェクト経由で参照する（値としては Task.lastGlobalApiRequestTime のスナップショット）。
 */
export interface ApiRequestTimingClosures {
	getLastGlobalApiRequestTime(): number | undefined
}

export class ApiRequestTimingController {
	constructor(
		private readonly host: ApiRequestTimingHost,
		private readonly closures: ApiRequestTimingClosures,
	) {}

	/**
	 * ユーザー設定のプロバイダレート制限を適用する。
	 * NOTE: これは想定内の挙動として `api_req_rate_limit_wait` say で表面化する（エラーではない）。
	 */
	async maybeWaitForRateLimit(retryAttempt: number): Promise<void> {
		const state = await this.host.providerRef.deref()?.getState()
		const rateLimitSeconds =
			state?.apiConfiguration?.rateLimitSeconds ?? this.host.apiConfiguration?.rateLimitSeconds ?? 0

		const lastRequestTime = this.closures.getLastGlobalApiRequestTime()
		if (rateLimitSeconds <= 0 || !lastRequestTime) {
			return
		}

		const now = performance.now()
		const timeSinceLastRequest = now - lastRequestTime
		const rateLimitDelay = Math.ceil(
			Math.min(rateLimitSeconds, Math.max(0, rateLimitSeconds * 1000 - timeSinceLastRequest) / 1000),
		)

		// Only show the countdown UX on the first attempt. Retry flows have their own delay messaging.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			for (let i = rateLimitDelay; i > 0; i--) {
				// Send structured JSON data for i18n-safe transport
				const delayMessage = JSON.stringify({ seconds: i })
				await this.host.say("api_req_rate_limit_wait", delayMessage, undefined, true)
				await delay(1000)
			}
			// Finalize the partial message so the UI doesn't keep rendering an in-progress spinner.
			await this.host.say("api_req_rate_limit_wait", undefined, undefined, false)
		}
	}

	/**
	 * API 失敗時の指数バックオフ（レート制限窓・429 RetryInfo も考慮）を計算し、
	 * カウントダウンを say で告知する。abort されたら早期終了する。
	 */
	async backoffAndAnnounce(retryAttempt: number, error: any): Promise<void> {
		try {
			const state = await this.host.providerRef.deref()?.getState()
			const baseDelay = state?.requestDelaySeconds || 5

			const exponentialDelay = Math.min(
				Math.ceil(baseDelay * Math.pow(2, retryAttempt)),
				MAX_EXPONENTIAL_BACKOFF_SECONDS,
			)

			// Respect provider rate limit window
			let rateLimitDelay = 0
			const rateLimit = (state?.apiConfiguration ?? this.host.apiConfiguration)?.rateLimitSeconds || 0
			const lastRequestTime = this.closures.getLastGlobalApiRequestTime()
			if (lastRequestTime && rateLimit > 0) {
				const elapsed = performance.now() - lastRequestTime
				rateLimitDelay = Math.ceil(Math.min(rateLimit, Math.max(0, rateLimit * 1000 - elapsed) / 1000))
			}

			const finalDelay = Math.max(exponentialDelay, rateLimitDelay)
			if (finalDelay <= 0) {
				return
			}

			// Build header text; fall back to error message if none provided
			let headerText
			if (error.status) {
				// Include both status code (for ChatRow parsing) and detailed message (for error details)
				// Format: "<status>\n<message>" allows ChatRow to extract status via parseInt(text.substring(0,3))
				// while preserving the full error message in errorDetails for debugging
				const errorMessage = error?.message || "Unknown error"
				headerText = `${error.status}\n${errorMessage}`
			} else if (error?.message) {
				headerText = error.message
			} else {
				headerText = "Unknown error"
			}

			/* v8 ignore next -- 到達不能: headerText は上の 105-115 でエラー由来の非空文字列が必ず入るため、三項の空文字既定側には到達しない（防御既定・安全のため残す） */
			headerText = headerText ? `${headerText}\n` : ""

			// Show countdown timer with exponential backoff
			for (let i = finalDelay; i > 0; i--) {
				// Check abort flag during countdown to allow early exit
				if (this.host.abort) {
					throw new Error(`[Task#${this.host.taskId}] Aborted during retry countdown`)
				}

				await this.host.say(
					"api_req_retry_delayed",
					`${headerText}<retry_timer>${i}</retry_timer>`,
					undefined,
					true,
				)
				await delay(1000)
			}

			await this.host.say("api_req_retry_delayed", headerText, undefined, false)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)

			if (this.host.abort && message.includes("Aborted during retry countdown")) {
				return
			}

			console.error("Exponential backoff failed:", err)
		}
	}
}
