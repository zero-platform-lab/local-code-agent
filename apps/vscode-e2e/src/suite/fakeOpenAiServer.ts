import * as http from "http"
import type { AddressInfo } from "net"

/**
 * 実 API を使わずに 1 往復を決定論的に回すための、最小の OpenAI 互換サーバ。
 *
 * 目的は「モデルの賢さ」を再現することではなく、**拡張 → HTTP → ストリーム解釈 →
 * タスクループ → UI メッセージ** という経路が繋がっていることを固定すること。
 * 返す内容はテスト側が enqueue で決める。
 */

/** 1 リクエストに対して返す応答。 */
export type FakeCompletion =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; arguments: Record<string, unknown> }
	/** 正常系ではなくエラー応答を返す（失敗経路の検証用）。 */
	| { kind: "error"; status: number; message: string }

export interface RecordedRequest {
	model?: string
	systemPrompt?: string
	/** system を除いた messages。 */
	messages: Array<{ role: string; content: unknown }>
	/** 送られてきた tool の名前一覧。 */
	toolNames: string[]
}

export interface FakeOpenAiServer {
	/** 拡張に設定するベース URL（/v1 まで含む）。 */
	url: string
	/** 受け取ったリクエストの記録。届いた順。 */
	requests: RecordedRequest[]
	/** 次に返す応答を積む。1 リクエストにつき先頭から 1 つ消費する。 */
	enqueue: (...completions: FakeCompletion[]) => void
	/** 積み残しを捨てる。テストが途中でタスクを打ち切るときに使う。 */
	clearQueue: () => void
	close: () => Promise<void>
}

/** 応答が尽きたときの既定。無限ループを避けるため必ずタスクを終わらせる。 */
const DEFAULT_COMPLETION: FakeCompletion = {
	kind: "tool",
	name: "attempt_completion",
	arguments: { result: "done" },
}

const readBody = (request: http.IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		let body = ""
		request.on("data", (chunk) => (body += chunk))
		request.on("end", () => resolve(body))
		request.on("error", reject)
	})

const chunk = (payload: Record<string, unknown>) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-fake",
		object: "chat.completion.chunk",
		created: 0,
		model: "fake-model",
		...payload,
	})}\n\n`

const streamFor = (completion: Exclude<FakeCompletion, { kind: "error" }>, callIndex: number): string => {
	const opening = chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })

	const body =
		completion.kind === "text"
			? chunk({ choices: [{ index: 0, delta: { content: completion.text }, finish_reason: null }] }) +
				chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
			: // tool_calls は「名前だけの delta」→「引数だけの delta」に分けて送る。
				// 実際のプロバイダも分割して寄越すので、結合の経路ごと固定する。
				chunk({
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: `call_fake_${callIndex}`,
										type: "function",
										function: { name: completion.name, arguments: "" },
									},
								],
							},
							finish_reason: null,
						},
					],
				}) +
				chunk({
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										function: { arguments: JSON.stringify(completion.arguments) },
									},
								],
							},
							finish_reason: null,
						},
					],
				}) +
				chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })

	const usage = chunk({
		choices: [],
		usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
	})

	return opening + body + usage + "data: [DONE]\n\n"
}

export const startFakeOpenAiServer = async (): Promise<FakeOpenAiServer> => {
	const queue: FakeCompletion[] = []
	const requests: RecordedRequest[] = []

	const server = http.createServer(async (request, response) => {
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404, { "Content-Type": "application/json" })
			response.end(JSON.stringify({ error: { message: `unexpected request: ${request.method} ${request.url}` } }))
			return
		}

		const raw = await readBody(request)
		const parsed = JSON.parse(raw) as {
			model?: string
			messages?: Array<{ role: string; content: unknown }>
			tools?: Array<{ function?: { name?: string } }>
		}
		const messages = parsed.messages ?? []

		requests.push({
			model: parsed.model,
			systemPrompt: messages.find((message) => message.role === "system")?.content as string | undefined,
			messages: messages.filter((message) => message.role !== "system"),
			toolNames: (parsed.tools ?? []).map((tool) => tool.function?.name ?? "").filter(Boolean),
		})

		const completion = queue.shift() ?? DEFAULT_COMPLETION

		if (completion.kind === "error") {
			response.writeHead(completion.status, { "Content-Type": "application/json" })
			response.end(JSON.stringify({ error: { message: completion.message, type: "server_error", code: null } }))
			return
		}

		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		})
		response.end(streamFor(completion, requests.length))
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo

	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		enqueue: (...completions: FakeCompletion[]) => queue.push(...completions),
		clearQueue: () => queue.splice(0, queue.length),
		close: () =>
			new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	}
}
