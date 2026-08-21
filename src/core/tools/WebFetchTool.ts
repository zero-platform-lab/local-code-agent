import { getProxyDispatcher, fetchThrough } from "../../utils/proxyDispatcher"
import { DEFAULT_HEADERS } from "../../api/providers/constants"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolTaskContext, ToolTaskSay } from "./toolHost"

interface WebFetchParams {
	url: string
	max_length?: number | null
}

/** Narrow structural view of `Task` required by {@link WebFetchTool}. */
interface WebFetchHost extends ToolTaskContext, ToolTaskSay {
	stream: {
		didToolFailInCurrentTurn: boolean
	}
}

const DEFAULT_MAX_LENGTH = 50_000
const FETCH_TIMEOUT_MS = 30_000

/**
 * HTML を最低限のプレーンテキストに変換する（外部ライブラリを増やさない簡易版）。
 * script/style/コメントを落とし、ブロック要素を改行にし、タグを除去、主要な実体参照を戻す。
 */
export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\/(p|div|br|li|tr|h[1-6]|section|article)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

/**
 * URL を取得してテキストとして返す。**企業 proxy を尊重**（getProxyDispatcher）。HTML は
 * テキスト化し、max_length で打ち切る。タイムアウトあり。
 */
export async function fetchUrlAsText(url: string, maxLength?: number | null): Promise<string> {
	const dispatcher = getProxyDispatcher()
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		const response = await fetchThrough(dispatcher, url, {
			method: "GET",
			redirect: "follow",
			signal: controller.signal,
			headers: { ...DEFAULT_HEADERS, accept: "text/html,application/xhtml+xml,text/plain,*/*" },
		})
		const contentType = response.headers.get("content-type") ?? ""
		const raw = await response.text()
		const text = /html/i.test(contentType) ? htmlToText(raw) : raw
		const limit = typeof maxLength === "number" && maxLength > 0 ? maxLength : DEFAULT_MAX_LENGTH
		const truncated = text.length > limit
		const body = truncated ? `${text.slice(0, limit)}\n\n…(truncated at ${limit} chars)` : text
		return `HTTP ${response.status} ${url}\n(content-type: ${contentType || "unknown"})\n\n${body}`
	} finally {
		clearTimeout(timer)
	}
}

/** `error.cause`（undici が真因を入れる場所）を可読な文字列にする。 */
function describeCause(cause: unknown): string | undefined {
	if (cause instanceof Error) {
		const code = (cause as { code?: string }).code
		return code ? `${code} (${cause.message})` : cause.message
	}
	return cause != null ? String(cause) : undefined
}

/**
 * fetch の失敗を、ユーザーに理由が伝わる Error にまとめ直す。
 *
 * undici の `fetch()` は接続失敗を一律 `TypeError: fetch failed` にし、真因（proxy 不通の
 * ECONNREFUSED、証明書エラー、名前解決失敗の ENOTFOUND 等）を `error.cause` に隠す。
 * handleError → `say("error")` は `error.message` しか出さないため、cause を message に
 * 畳み込んで表面化させる。タイムアウト（AbortController）は専用の文言にする。
 */
export function toFetchError(url: string, error: unknown): Error {
	if (error instanceof Error) {
		if (error.name === "AbortError" || error.name === "TimeoutError") {
			return new Error(`web_fetch timed out for ${url} after ${FETCH_TIMEOUT_MS / 1000}s`)
		}
		const causeText = describeCause((error as { cause?: unknown }).cause)
		const detail = causeText ? `${error.message}: ${causeText}` : error.message
		return new Error(`web_fetch failed for ${url}: ${detail}`)
	}
	return new Error(`web_fetch failed for ${url}: ${String(error)}`)
}

export class WebFetchTool extends BaseTool<"web_fetch", WebFetchHost> {
	readonly name = "web_fetch" as const

	async execute(params: WebFetchParams, task: WebFetchHost, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { url, max_length } = params

		if (!url) {
			task.mistakeTracker.count++
			task.stream.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("web_fetch", "url"))
			return
		}

		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			task.mistakeTracker.count++
			task.stream.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(`Invalid URL: ${url}`))
			return
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			task.mistakeTracker.count++
			task.stream.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(`web_fetch supports only http(s) URLs (got "${parsed.protocol}").`))
			return
		}

		const didApprove = await askApproval("tool", JSON.stringify({ tool: "webFetch", url }))
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		task.mistakeTracker.count = 0

		try {
			pushToolResult(await fetchUrlAsText(url, max_length))
		} catch (error) {
			task.stream.didToolFailInCurrentTurn = true
			await handleError("web_fetch", toFetchError(url, error))
		}
	}
}

export const webFetchTool = new WebFetchTool()
