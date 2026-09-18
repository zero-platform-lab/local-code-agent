// エラーから HTTP ステータスを取り出す leaf。再試行の方針（apiRetryPolicy）と
// context-window 検出（context-error-handling）の両方から使い、抽出を 1 か所に集約する。

/**
 * エラーから HTTP ステータス番号を取り出す。プロバイダやプロキシによって
 * `status` / `response.status` / `statusCode` / `error.status` / `code` のどこに乗るかが
 * 違うため、取りうる場所を順に探す。100–599 に収まる数値だけを採るので、アプリ独自の
 * errno（小さな数値の `code` など）や種別名（`invalid_request_error` 等の文字列）を
 * 誤って HTTP ステータスとして拾わない。どこにも無ければ undefined。
 *
 * 曖昧になりやすい `code` は最後に見る（本来の status を隠さないため）。
 */
export function getHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined
	const e = error as {
		status?: unknown
		statusCode?: unknown
		code?: unknown
		response?: { status?: unknown }
		error?: { status?: unknown }
	}
	const candidates = [e.status, e.response?.status, e.statusCode, e.error?.status, e.code]
	for (const candidate of candidates) {
		let n: number | undefined
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			n = candidate
		} else if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) {
			n = Number(candidate.trim())
		}
		if (n !== undefined && n >= 100 && n <= 599) return n
	}
	return undefined
}
