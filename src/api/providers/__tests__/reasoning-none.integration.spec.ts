// npx vitest run src/api/providers/__tests__/reasoning-none.integration.spec.ts
//
// **統合テスト**。「reasoning_effort=none が実 HTTP body に載っているか」を実測する。
//
// 動機:
//   前セッションでコードを目視して「OpenAI SDK 経由で正しく送出される」と
//   結論したが、それは実行時の HTTP body を一度も見ずに出した結論だった。
//   ここでは OpenAI SDK が最終的に組み立てるリクエストを localhost で受け止め、
//   body に何が入っているかを検証する。
//
// 仕組み:
//   1. ローカルの HTTP サーバに OpenAI 互換の /chat/completions を用意する
//      （SSE を最低限だけ返す）
//   2. OpenAiHandler をそのサーバに向ける
//   3. `openAiCustomModelInfo.reasoningEffort = "none"` として送信させる
//   4. サーバが受け取った body に `reasoning_effort: "none"` があることを確認する

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

async function startOpenAiCompatibleServer(): Promise<{
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

			// 最小の SSE。text delta を 1 つ返して DONE。
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			})
			res.write('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n')
			res.write(
				'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
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
	for await (const _ of stream) {
		void _
	}
}

describe("reasoning_effort=none reaches the wire", () => {
	beforeEach(() => {
		allowNetConnect("127.0.0.1")
	})
	afterEach(() => {
		nock.disableNetConnect()
	})

	it('sends `reasoning_effort: "none"` in the request body when the user selects None', async () => {
		const server = await startOpenAiCompatibleServer()
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "test-key",
				openAiModelId: "test-model",
				// UI が書き込むのはここ（openAiCustomModelInfo.reasoningEffort）
				openAiCustomModelInfo: {
					contextWindow: 8192,
					supportsPromptCache: false,
					reasoningEffort: "none",
					// getModelParams 側の shouldUseReasoningEffort を通すために
					// capability array にも "none" を含める（UI と同じ状態）。
					supportsReasoningEffort: ["none", "minimal", "low", "medium", "high"],
				} as unknown as never,
				enableReasoningEffort: true,
			})

			await drain(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }]))

			expect(server.requests).toHaveLength(1)
			const body = server.requests[0].body as { reasoning_effort?: unknown }
			expect(body.reasoning_effort).toBe("none")
		} finally {
			await server.close()
		}
	})

	it("does NOT send reasoning_effort when reasoning is disabled", async () => {
		const server = await startOpenAiCompatibleServer()
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "test-key",
				openAiModelId: "test-model",
				openAiCustomModelInfo: {
					contextWindow: 8192,
					supportsPromptCache: false,
					reasoningEffort: "none",
					supportsReasoningEffort: ["none", "minimal", "low", "medium", "high"],
				} as unknown as never,
				enableReasoningEffort: false,
			})

			await drain(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }]))

			expect(server.requests).toHaveLength(1)
			const body = server.requests[0].body as { reasoning_effort?: unknown }
			expect(body.reasoning_effort).toBeUndefined()
		} finally {
			await server.close()
		}
	})
})
