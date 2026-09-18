// API リクエストの再試行方針。first-chunk（apiRequestOrchestrator）と
// mid-stream（handleMidStreamError）の両経路で共通に使う。非リトライの 4xx を
// 終端にし、再試行回数に上限を設けることで「400 が延々ループ」する事故を防ぐ。

import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"

/**
 * 再試行の上限。判定漏れがあっても無限ループにしないための backstop。
 * 429（レート制限）や一時的な 5xx でも十分な再試行を残せるよう、寛大な値にする。
 */
export const MAX_API_RETRY_ATTEMPTS = 10

/**
 * 一時的で、再試行に残す 4xx。429（レート制限）に加え、408（Request Timeout）・
 * 409（Conflict）・425（Too Early）は、時間や次回の送信で回復しうるので終端にしない。
 */
const RETRYABLE_4XX = new Set([408, 409, 425, 429])

/**
 * エラーから HTTP ステータスを頑丈に取り出す。プロバイダやプロキシによって
 * `status` / `code` / `error.status` / `response.status` / `statusCode` のどこに乗るかが
 * 違うため、取りうる場所を網羅して探す（`context-error-handling` と同じ集合をカバーする）。
 * どこにも無ければ、メッセージ中の明記（`HTTP 400` など）を保険で拾う。数値化できなければ undefined。
 */
export function getHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined
	const e = error as {
		status?: unknown
		code?: unknown
		statusCode?: unknown
		response?: { status?: unknown }
		error?: { status?: unknown }
		message?: unknown
	}
	const candidates = [e.status, e.code, e.error?.status, e.response?.status, e.statusCode]
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate
		// 文字列の code は種別名（"invalid_request_error" 等）のこともあるので、数値だけ拾う。
		if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) return Number(candidate.trim())
	}
	if (typeof e.message === "string") {
		const labelled =
			e.message.match(/\bHTTP\s+(\d{3})\b/i) ?? e.message.match(/\bstatus(?:\s*code)?[:\s]+(\d{3})\b/i)
		if (labelled) return Number(labelled[1])
	}
	return undefined
}

/**
 * 再試行しても直らない終端のクライアントエラー（HTTP 4xx）か。
 * 例外として、レート制限や一時的な状態（`RETRYABLE_4XX`）と context-window 超過
 * （専用の切り詰め処理に任せる）はここでは終端としない。
 */
export function isTerminalClientError(error: unknown, opts: { isContextWindowExceeded?: boolean } = {}): boolean {
	const isContextWindowExceeded = opts.isContextWindowExceeded ?? checkContextWindowExceededError(error)
	if (isContextWindowExceeded) return false
	const status = getHttpStatus(error)
	return typeof status === "number" && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)
}
