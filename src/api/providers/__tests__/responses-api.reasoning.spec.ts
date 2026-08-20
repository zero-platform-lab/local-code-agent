// npx vitest run src/api/providers/__tests__/responses-api.reasoning.spec.ts
//
// reasoning items (encrypted_content) の multi-turn 受け渡しを実 HTTP で検証する。
//
// 検証内容:
//   1. リクエスト body に include: ["reasoning.encrypted_content"] が入る
//   2. ストリーム応答で reasoning item を受け取ると getEncryptedContent() が返す
//   3. 直後に新しいリクエストを送るたびに、getEncryptedContent() は「その」レス
//      ポンスの結果だけを返す（前ターンの値が残らない）
//   4. 会話履歴に埋め込まれた reasoning block が次リクエストの input に復元される

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
import { buildCleanConversationHistory } from "../../../core/task/buildCleanConversationHistory"

interface CapturedRequest {
	body: Record<string, unknown>
}

async function startServer(sseChunks: string[]): Promise<{
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
			requests.push({ body })

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

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of stream) void _
}

describe("Responses API reasoning items", () => {
	beforeEach(() => {
		allowNetConnect("127.0.0.1")
	})
	afterEach(() => {
		nock.disableNetConnect()
	})

	it("sends include: [reasoning.encrypted_content] with every request", async () => {
		const server = await startServer([
			'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
		])
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
			})
			await drain(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }]))

			const body = server.requests[0].body as { include?: string[] }
			expect(body.include).toContain("reasoning.encrypted_content")
		} finally {
			await server.close()
		}
	})

	it("captures encrypted_content from response and exposes it via getEncryptedContent()", async () => {
		const server = await startServer([
			'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"r1","encrypted_content":"OPAQUE-BLOB-1"}}\n\n',
			'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
			'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
		])
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
			})
			await drain(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }]))

			const enc = (
				handler as unknown as {
					getEncryptedContent: () => { encrypted_content: string; id?: string } | undefined
				}
			).getEncryptedContent()
			expect(enc).toBeDefined()
			expect(enc?.encrypted_content).toBe("OPAQUE-BLOB-1")
			expect(enc?.id).toBe("r1")
		} finally {
			await server.close()
		}
	})

	it("clears prior reasoning at the start of each request", async () => {
		const server = await startServer([
			'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"r1","encrypted_content":"BLOB-1"}}\n\n',
			'data: {"type":"response.completed","response":{}}\n\n',
		])
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "gpt-5.6",
				openAiUseResponsesApi: true,
			})
			await drain(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }]))
			expect((handler as any).getEncryptedContent()?.encrypted_content).toBe("BLOB-1")

			// 2 回目は reasoning を含まないレスポンス。前ターンの BLOB-1 が残ってはならない。
			await server.close()
			const server2 = await startServer(['data: {"type":"response.completed","response":{}}\n\n'])
			try {
				const handler2 = new OpenAiHandler({
					openAiBaseUrl: `http://127.0.0.1:${server2.port}/v1`,
					openAiApiKey: "k",
					openAiModelId: "gpt-5.6",
					openAiUseResponsesApi: true,
				})
				// 同じインスタンスで確認するため、handler の internal state を掃除する意味で await
				await drain(handler2.createMessage("sys", [{ type: "message", role: "user", content: "hi" }]))
				expect((handler2 as any).getEncryptedContent()).toBeUndefined()
			} finally {
				await server2.close()
			}
		} finally {
			// 上で close 済み
		}
	})

	it("resubmits reasoning items from history via buildCleanConversationHistory", () => {
		// 履歴自体が item 列になったので、reasoning は本文より前の独立 item として保存される。
		const history = [
			{ type: "message" as const, role: "user" as const, content: "hi" },
			{ type: "reasoning" as const, encrypted_content: "BLOB-1", summary: [], id: "r1", ts: 1 },
			{ type: "message" as const, role: "assistant" as const, content: "answer", ts: 1 },
			{ type: "message" as const, role: "user" as const, content: "next" },
		]

		// preserveReasoning=true のときだけ reasoning item を送る
		const input = buildCleanConversationHistory(history, true)

		const reasoning = input.find((i) => i.type === "reasoning")
		expect(reasoning).toBeDefined()
		expect(reasoning).toEqual({ type: "reasoning", encrypted_content: "BLOB-1", summary: [], id: "r1" })

		// 順序: assistant 本文より前に reasoning が来る
		const reasoningIdx = input.findIndex((i) => i.type === "reasoning")
		const assistantMsgIdx = input.findIndex((i) => i.type === "message" && i.role === "assistant")
		expect(reasoningIdx).toBeLessThan(assistantMsgIdx)

		// preserveReasoning=false なら送らない
		expect(buildCleanConversationHistory(history, false).some((i) => i.type === "reasoning")).toBe(false)
	})
})

describe("multi-turn reasoning の取りこぼし防止", () => {
	it("暗号化 reasoning は modelInfo に関係なく次ターンへ戻す", () => {
		// 実機検証で見つかった回帰の再発防止。buildCleanConversationHistory の第 2 引数を
		// modelInfo.preserveReasoning で絞ると、その値を設定する UI が無いため
		// multi-turn reasoning が常に無効になっていた（#354 の途中で混入）。
		const history = [
			{ type: "message" as const, role: "user" as const, content: "hi" },
			{ type: "reasoning" as const, encrypted_content: "BLOB-1", id: "r1", ts: 1 },
			{ type: "message" as const, role: "assistant" as const, content: "answer", ts: 1 },
		]

		const sent = buildCleanConversationHistory(history, true)
		expect(sent.filter((i) => i.type === "reasoning")).toEqual([
			{ type: "reasoning", encrypted_content: "BLOB-1", id: "r1" },
		])
	})
})
