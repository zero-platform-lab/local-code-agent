// Azure OpenAI 互換の**擬似実サーバ**（テスト fixture）。
//
// 目的: 本物の企業 Azure エンドポイントに到達できない環境でも、`OpenAiHandler`（SDK 経路）を
// 丸ごと通して Azure 特有の挙動を**実 HTTP で再現・回帰テスト化**する。モック fetch では
// SDK / undici の実挙動（URL 形成・ストリーミング・タイムアウト）を通らないため。
//
// AzureOpenAI SDK は baseURL=`.../openai` に対し、chat.completions の POST で
// `/deployments/{model}/chat/completions?api-version=...` を組み、`api-key` ヘッダで送る。
// このサーバはその契約を受け、config に応じて 正常応答 / tool_calls / SSE / エラー /
// 無応答ハング / 「reasoning+tools を 400 で弾く」等を返す。

import http from "node:http"
import type { AddressInfo } from "node:net"
import type { Socket } from "node:net"

export interface RecordedRequest {
	method?: string
	/** 生の req.url（パス + クエリ）。 */
	url?: string
	/** パス部分のみ。 */
	path: string
	/** api-version クエリ。 */
	apiVersion?: string
	/** Azure は api-key ヘッダ。素の OpenAI は Authorization。 */
	apiKey?: string
	authorization?: string
	/** パース済みリクエストボディ（JSON）。 */
	body: Record<string, unknown>
}

export type FakeAzureConfig =
	/** 通常の chat 応答（assistant テキスト）。 */
	| { mode: "chat"; content?: string }
	/** tool_calls を含む応答。 */
	| { mode: "toolcall"; toolName: string; toolArgs?: string; callId?: string }
	/** chat completions の SSE ストリーミング（delta.content を順に流す）。 */
	| { mode: "stream-text"; chunks: string[] }
	/** 指定ステータス + ボディでエラーを返す。 */
	| { mode: "error"; status: number; body?: unknown }
	/** 接続は受けるが応答を一切返さない（無応答ハング）。 */
	| { mode: "hang" }
	/**
	 * ボディに reasoning_effort があり、かつ tools が載っていれば 400 を返す。
	 * （Azure GPT-5 系が chat.completions で reasoning + tools を弾く挙動の模倣。
	 * それ以外は通常 chat 応答。）
	 */
	| { mode: "reject-reasoning-with-tools"; content?: string }

interface FakeAzureServer {
	port: number
	/** openAiBaseUrl に渡す値（`/openai` を含む）。 */
	baseUrl: string
	requests: RecordedRequest[]
	close: () => Promise<void>
}

function chatCompletionBody(content: string): string {
	return JSON.stringify({
		id: "chatcmpl-fake",
		object: "chat.completion",
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	})
}

function toolCallBody(toolName: string, toolArgs: string, callId: string): string {
	return JSON.stringify({
		id: "chatcmpl-fake",
		object: "chat.completion",
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: null,
					tool_calls: [{ id: callId, type: "function", function: { name: toolName, arguments: toolArgs } }],
				},
				finish_reason: "tool_calls",
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	})
}

function sseChunk(delta: object, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
}

export async function startFakeAzureServer(config: FakeAzureConfig): Promise<FakeAzureServer> {
	const requests: RecordedRequest[] = []
	const sockets = new Set<Socket>()

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on("data", (c: Buffer) => chunks.push(c))
		req.on("end", () => {
			const rawBody = Buffer.concat(chunks).toString("utf8")
			let body: Record<string, unknown> = {}
			try {
				body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
			} catch {
				// 非 JSON はそのまま空オブジェクト。
			}
			const parsed = new URL(req.url ?? "/", "http://localhost")
			requests.push({
				method: req.method,
				url: req.url,
				path: parsed.pathname,
				apiVersion: parsed.searchParams.get("api-version") ?? undefined,
				apiKey: req.headers["api-key"] as string | undefined,
				authorization: req.headers["authorization"] as string | undefined,
				body,
			})

			if (config.mode === "hang") {
				// 何も返さない。res.end を呼ばない = クライアントは応答待ちのまま。
				return
			}

			if (config.mode === "error") {
				res.statusCode = config.status
				res.setHeader("content-type", "application/json")
				res.end(JSON.stringify(config.body ?? { error: { message: "fake error", code: config.status } }))
				return
			}

			if (config.mode === "reject-reasoning-with-tools") {
				const hasReasoning = body.reasoning_effort !== undefined && body.reasoning_effort !== null
				const hasTools = Array.isArray(body.tools) && (body.tools as unknown[]).length > 0
				if (hasReasoning && hasTools) {
					res.statusCode = 400
					res.setHeader("content-type", "application/json")
					res.end(
						JSON.stringify({
							error: {
								message: "reasoning_effort is not supported with tools on this model.",
								type: "invalid_request_error",
								code: "unsupported_parameter",
							},
						}),
					)
					return
				}
				res.statusCode = 200
				res.setHeader("content-type", "application/json")
				res.end(chatCompletionBody(config.content ?? "ok"))
				return
			}

			if (config.mode === "toolcall") {
				res.statusCode = 200
				res.setHeader("content-type", "application/json")
				res.end(toolCallBody(config.toolName, config.toolArgs ?? '{"ok":true}', config.callId ?? "call_1"))
				return
			}

			if (config.mode === "stream-text") {
				res.statusCode = 200
				res.setHeader("content-type", "text/event-stream")
				res.setHeader("cache-control", "no-cache")
				for (const c of config.chunks) res.write(sseChunk({ content: c }))
				res.write(sseChunk({}, "stop"))
				res.write("data: [DONE]\n\n")
				res.end()
				return
			}

			// mode === "chat"
			res.statusCode = 200
			res.setHeader("content-type", "application/json")
			res.end(chatCompletionBody(config.content ?? "hello from fake azure"))
		})
	})

	server.on("connection", (s) => {
		sockets.add(s)
		s.on("close", () => sockets.delete(s))
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const port = (server.address() as AddressInfo).port
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}/openai`,
		requests,
		close: () =>
			new Promise((resolve, reject) => {
				for (const s of sockets) s.destroy()
				server.close((e) => (e ? reject(e) : resolve()))
			}),
	}
}
