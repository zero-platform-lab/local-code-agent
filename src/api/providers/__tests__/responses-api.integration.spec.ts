// npx vitest run src/api/providers/__tests__/responses-api.integration.spec.ts
//
// **統合テスト**。openAiUseResponsesApi=true にしたときの本番リクエストが
// 実際に /v1/responses に飛び、body に reasoning + tool 定義が正しく載っているかを実測する。
//
// これで「GPT-5.6 が chat.completions で 400 になる → responses で通る」の
// 移行が本当にできているかが数値で見える。

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
	path: string
	body: Record<string, unknown>
}

async function startResponsesServer(): Promise<{
	port: number
	requests: CapturedRequest[]
	close: () => Promise<void>
}> {
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
			requests.push({ path: req.url ?? "", body })

			// Responses API の最小 SSE 応答。text delta → completed。
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			})
			res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
			res.write(
				'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
			)
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

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of stream) void _
}

describe("Responses API path", () => {
	beforeEach(() => {
		allowNetConnect("127.0.0.1")
	})
	afterEach(() => {
		nock.disableNetConnect()
	})

	it("targets /v1/responses (not /chat/completions) when openAiUseResponsesApi=true", async () => {
		const server = await startResponsesServer()
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "test-key",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
			})
			await drain(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }]))

			expect(server.requests).toHaveLength(1)
			expect(server.requests[0].path).toBe("/v1/responses")
		} finally {
			await server.close()
		}
	})

	it("sends reasoning.effort as an object (Responses API shape) instead of reasoning_effort", async () => {
		const server = await startResponsesServer()
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "test-key",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 8192,
					supportsPromptCache: false,
					reasoningEffort: "medium",
				} as unknown as never,
			})
			await drain(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }]))

			const body = server.requests[0].body as {
				reasoning?: { effort?: string }
				reasoning_effort?: unknown
			}
			expect(body.reasoning).toEqual({ effort: "medium" })
			// Responses API 側の shape は入れ子オブジェクト。トップの reasoning_effort は入らない。
			expect(body.reasoning_effort).toBeUndefined()
		} finally {
			await server.close()
		}
	})

	it("passes function tools with the Responses shape (name at the top level, no 'function' wrapper)", async () => {
		const server = await startResponsesServer()
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "test-key",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
			})
			await drain(
				handler.createMessage("sys", [{ type: "message", role: "user", content: "please read" }], {
					tools: [
						{
							type: "function" as const,
							function: {
								name: "read_file",
								description: "read a file",
								parameters: {
									type: "object",
									properties: { path: { type: "string" } },
									required: ["path"],
								},
							},
						},
					],
				} as never),
			)

			const body = server.requests[0].body as { tools?: Array<Record<string, unknown>> }
			expect(body.tools).toHaveLength(1)
			expect(body.tools?.[0]).toMatchObject({
				type: "function",
				name: "read_file",
			})
			// 誤って chat.completions 形式で送っていないこと
			expect(body.tools?.[0]).not.toHaveProperty("function")
		} finally {
			await server.close()
		}
	})

	it("sends `input` array (Responses API) instead of `messages` (Chat Completions)", async () => {
		const server = await startResponsesServer()
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "test-key",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
			})
			await drain(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }]))

			const body = server.requests[0].body as {
				input?: unknown
				messages?: unknown
				instructions?: unknown
			}
			expect(body.input).toBeDefined()
			expect(body.messages).toBeUndefined()
			// system prompt は instructions フィールドに載る
			expect(body.instructions).toBe("sys")
		} finally {
			await server.close()
		}
	})
})
