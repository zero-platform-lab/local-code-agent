// npx vitest run api/providers/__tests__/responses-api.coverage.spec.ts
//
// **統合テスト**。Responses API 経路のうち、既存 spec が触れていない枝を実 HTTP で埋める:
//   - 非ストリーミング応答（output の message/function_call/reasoning、usage 有無）
//   - ストリーミングの function_call イベント列（added / arguments.delta / done）
//   - reasoning done（id 無し）と usage 0 の握り
//   - responses.create のエラー（非 2xx）
//   - 非 function tool の passthrough（responsesTools の map）
//
// 実ネットワークには出ない（allowNetConnect は 127.0.0.1 のみ）。

import http from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import nock from "nock"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({ get: () => undefined }),
	},
}))

import { OpenAiHandler } from "../openai"
import { allowNetConnect } from "../../../vitest.setup"

interface CapturedRequest {
	body: Record<string, unknown>
}

async function startSseServer(
	sseChunks: string[],
	status = 200,
): Promise<{ port: number; requests: CapturedRequest[]; close: () => Promise<void> }> {
	const requests: CapturedRequest[] = []
	const server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (chunk) => (raw += chunk.toString("utf8")))
		req.on("end", () => {
			let body: Record<string, unknown> = {}
			try {
				body = raw ? JSON.parse(raw) : {}
			} catch {
				body = { _rawParseError: true }
			}
			requests.push({ body })

			if (status !== 200) {
				res.writeHead(status, { "content-type": "application/json" })
				res.end(JSON.stringify({ error: { message: "server boom" } }))
				return
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			})
			for (const chunk of sseChunks) res.write(chunk)
			res.write("data: [DONE]\n\n")
			res.end()
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as AddressInfo).port,
		requests,
		close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
	}
}

async function startJsonServer(
	jsonBody: unknown,
): Promise<{ port: number; requests: CapturedRequest[]; close: () => Promise<void> }> {
	const requests: CapturedRequest[] = []
	const server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (chunk) => (raw += chunk.toString("utf8")))
		req.on("end", () => {
			try {
				requests.push({ body: raw ? JSON.parse(raw) : {} })
			} catch {
				requests.push({ body: {} })
			}
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(jsonBody))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as AddressInfo).port,
		requests,
		close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
	}
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
	const out: any[] = []
	for await (const c of stream) out.push(c)
	return out
}

const userTurn = [{ type: "message" as const, role: "user" as const, content: "hi" }]

describe("Responses API coverage", () => {
	beforeEach(() => {
		allowNetConnect("127.0.0.1")
	})
	afterEach(() => {
		nock.disableNetConnect()
	})

	it("non-streaming: emits text/tool_call, captures reasoning, and reports usage", async () => {
		const server = await startJsonServer({
			output: [
				{
					type: "message",
					content: [
						{ type: "output_text", text: "hello" },
						{ type: "output_text", text: "" }, // text key あり・空 → `&& part.text` false
						{ type: "refusal" }, // text key 無し → `"text" in part` false
					],
				},
				{ type: "message", content: null }, // content ?? []
				{ type: "function_call", call_id: "call_1", name: "do_it", arguments: '{"a":1}' },
				{ type: "reasoning", id: "rid", encrypted_content: "ENC" },
				{ type: "reasoning" }, // encrypted_content 無し → 保持しない
				{ type: "web_search_call" }, // 無関係 item は無視
			],
			usage: { input_tokens: 2, output_tokens: 3 },
		})
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
				openAiStreamingEnabled: false,
			})
			const chunks = await collect(handler.createMessage("sys", userTurn))

			expect(chunks.filter((c) => c.type === "text").map((c) => c.text)).toEqual(["hello"])
			expect(chunks.find((c) => c.type === "tool_call")).toMatchObject({
				id: "call_1",
				name: "do_it",
				arguments: '{"a":1}',
			})
			expect(chunks.find((c) => c.type === "usage")).toMatchObject({ inputTokens: 2, outputTokens: 3 })
			expect((handler as any).getEncryptedContent()).toEqual({ encrypted_content: "ENC", id: "rid" })
		} finally {
			await server.close()
		}
	})

	it("non-streaming: captures reasoning that has encrypted_content but no id", async () => {
		const server = await startJsonServer({
			output: [{ type: "reasoning", encrypted_content: "ENC-NOID" }],
			usage: {}, // usage あるが token フィールド欠落 → `|| 0`
		})
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
				openAiStreamingEnabled: false,
			})
			const chunks = await collect(handler.createMessage("sys", userTurn))
			const enc = (handler as any).getEncryptedContent()
			expect(enc.encrypted_content).toBe("ENC-NOID")
			expect(enc.id).toBeUndefined()
			expect(chunks.find((c) => c.type === "usage")).toMatchObject({ inputTokens: 0, outputTokens: 0 })
		} finally {
			await server.close()
		}
	})

	it("non-streaming: tolerates a response with neither output nor usage", async () => {
		const server = await startJsonServer({})
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
				openAiStreamingEnabled: false,
			})
			const chunks = await collect(handler.createMessage("sys", userTurn))
			expect(chunks).toHaveLength(0)
		} finally {
			await server.close()
		}
	})

	it("streaming: yields tool_call events, ignores stray/unregistered deltas, and clamps zero usage", async () => {
		const server = await startSseServer([
			'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
			'data: {"type":"response.output_text.delta"}\n\n', // delta 無し → skip
			'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc1","call_id":"call_1","name":"do_it"}}\n\n',
			'data: {"type":"response.function_call_arguments.delta","item_id":"fc1","delta":"{\\"a\\":1}"}\n\n',
			'data: {"type":"response.function_call_arguments.delta","item_id":"fc1"}\n\n', // delta 無し → arguments は `?? ""`
			'data: {"type":"response.function_call_arguments.delta","item_id":"unknown"}\n\n', // 未登録 item → 名前無しで skip
			'data: {"type":"response.output_item.added","item":{"type":"message"}}\n\n', // function_call 以外 → 登録しない
			'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc1","call_id":"call_1","name":"do_it","arguments":"{\\"a\\":1}"}}\n\n',
			'data: {"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"ENC2"}}\n\n', // id 無し
			'data: {"type":"response.completed","response":{"usage":{}}}\n\n', // usage あるが token 欠落 → || 0
		])
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
			})
			const chunks = await collect(handler.createMessage("sys", userTurn))

			expect(chunks.find((c) => c.type === "text")?.text).toBe("answer")
			const partials = chunks.filter((c) => c.type === "tool_call_partial")
			// 登録済み fc1 への delta が 2 件（引数あり + 引数無し）。未登録 item は名前が引けず skip。
			expect(partials).toHaveLength(2)
			expect(partials[0]).toMatchObject({ index: 0, id: "call_1", name: "do_it", arguments: '{"a":1}' })
			expect(partials[1]).toMatchObject({ index: 0, id: "call_1", name: "do_it", arguments: "" })
			expect(chunks.find((c) => c.type === "tool_call")).toMatchObject({ id: "call_1", name: "do_it" })
			expect(chunks.find((c) => c.type === "usage")).toMatchObject({ inputTokens: 0, outputTokens: 0 })

			const enc = (handler as any).getEncryptedContent()
			expect(enc.encrypted_content).toBe("ENC2")
			expect(enc.id).toBeUndefined()
		} finally {
			await server.close()
		}
	})

	it("passes a non-function tool through the Responses tool mapping unchanged", async () => {
		const server = await startSseServer([
			'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
		])
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
			})
			await collect(
				handler.createMessage("sys", userTurn, {
					tools: [
						{
							type: "function",
							function: {
								name: "fn",
								description: "d",
								parameters: { type: "object", properties: {} },
							},
						},
						// function 以外の tool は base-provider でも responses map でも素通し。
						{ type: "custom_tool", data: "x" },
					],
				} as never),
			)

			const body = server.requests[0].body as { tools?: Array<Record<string, unknown>> }
			expect(body.tools).toHaveLength(2)
			expect(body.tools?.find((t) => t.type === "custom_tool")).toEqual({ type: "custom_tool", data: "x" })
		} finally {
			await server.close()
		}
	})

	it("wraps errors when the Responses endpoint returns a non-2xx status", async () => {
		const server = await startSseServer([], 500)
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
			})
			await expect(collect(handler.createMessage("sys", userTurn))).rejects.toThrow(/OpenAI/)
		} finally {
			await server.close()
		}
	})
})
