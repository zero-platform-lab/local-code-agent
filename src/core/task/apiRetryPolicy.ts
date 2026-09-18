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
 * エラーから HTTP ステータスを頑丈に取り出す。プロバイダやプロキシによって
 * `status` / `response.status` / `statusCode` のどれに乗るかが違うため、順に探す。
 * 数値化できなければ undefined。
 */
export function getHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined
	const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
	const candidates = [e.status, e.response?.status, e.statusCode]
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate
		if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) return Number(candidate.trim())
	}
	return undefined
}

/**
 * 再試行しても直らない終端のクライアントエラー（HTTP 4xx）か。
 * 例外として、429（レート制限。時間で回復する）と context-window 超過
 * （専用の切り詰め処理に任せる）はここでは終端としない。
 */
export function isTerminalClientError(error: unknown, opts: { isContextWindowExceeded?: boolean } = {}): boolean {
	const isContextWindowExceeded = opts.isContextWindowExceeded ?? checkContextWindowExceededError(error)
	if (isContextWindowExceeded) return false
	const status = getHttpStatus(error)
	return typeof status === "number" && status >= 400 && status < 500 && status !== 429
}
