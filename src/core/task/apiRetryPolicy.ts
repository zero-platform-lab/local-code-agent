// API リクエストの再試行方針。first-chunk（apiRequestOrchestrator）と
// mid-stream（handleMidStreamError）の両経路で共通に使う。非リトライの 4xx を
// 終端にし、再試行回数に上限を設けることで「400 が延々ループ」する事故を防ぐ。

import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import { getHttpStatus } from "./httpStatus"

/**
 * 再試行の上限。判定漏れがあっても無限ループにしないための backstop。
 * 429（レート制限）や一時的な 5xx でも十分な再試行を残せるよう、寛大な値にする。
 */
export const MAX_API_RETRY_ATTEMPTS = 10

/**
 * 時間や次回の送信で回復しうる一時的な 4xx。ここに挙げたものは終端にしない。
 * 408（Request Timeout）・425（Too Early。RFC 8470 で再送安全）・429（Too Many Requests）。
 * 409（Conflict）は同じ内容の再送で直らないことが多いので、終端（即時に表面化）にする。
 */
const RETRYABLE_4XX = new Set([408, 425, 429])

/**
 * 再試行しても直らない終端のクライアントエラー（HTTP 4xx）か。
 * 例外として、一時的な 4xx（`RETRYABLE_4XX`）と context-window 超過
 * （専用の切り詰め処理に任せる）はここでは終端としない。
 */
export function isTerminalClientError(error: unknown, opts: { isContextWindowExceeded?: boolean } = {}): boolean {
	const isContextWindowExceeded = opts.isContextWindowExceeded ?? checkContextWindowExceededError(error)
	if (isContextWindowExceeded) return false
	const status = getHttpStatus(error)
	return typeof status === "number" && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)
}
