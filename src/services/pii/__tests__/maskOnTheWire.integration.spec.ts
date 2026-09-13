// npx vitest run services/pii/__tests__/maskOnTheWire.integration.spec.ts
//
// **統合テスト**。伏せた結果が実際の HTTP の本文に載っているかを実測する。
//
// 動機:
//   ここまでの試験は、伏せる関数の戻り値と、呼び出し箇所の数を確かめてきた。どちらも
//   「実際に送られるバイト列」は一度も見ていない。送る手前で組み立て直す処理が 1 つでも
//   挟まれば、伏せたはずの値がそのまま出ていく。
//
// 仕組み:
//   1. OpenAI 互換の `/chat/completions` をローカルに立て、受け取った本文を控える
//   2. 本物の `OpenAiHandler` をそのサーバへ向ける
//   3. `TaskPiiMasker` で伏せてから送る
//   4. 控えた本文に生の値が 1 つも無く、伏せ字が載っていることを確かめる
//
// **伏せない場合も確かめる。** 生の値が載ることを見ておかないと、この試験が本当に
// 何かを見張っているのか分からない。

import http from "node:http"
import type { AddressInfo } from "node:net"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({ get: () => undefined }),
	},
}))

vi.mock("../../agent-config", () => ({ getGlobalAgentDirectory: () => "/w/存在しない" }))

import type { AgentMessage } from "@openai-agent/types"

import { OpenAiHandler } from "../../../api/providers/openai"
import { allowNetConnect } from "../../../vitest.setup"

import { TaskPiiMasker } from "../TaskPiiMasker"

/** 送られてきた本文を控えるだけのサーバ。応答は最低限の SSE。 */
async function startServer(): Promise<{ port: number; bodies: string[]; close: () => Promise<void> }> {
	const bodies: string[] = []
	const server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (chunk) => (raw += chunk.toString("utf8")))
		req.on("end", () => {
			bodies.push(raw)
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
			res.write('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n')
			res.write('data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n')
			res.write("data: [DONE]\n\n")
			res.end()
		})
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as AddressInfo).port,
		bodies,
		close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	}
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of stream) {
		void _
	}
}

/** 伏せたい値。どれも作り物である。 */
const SECRETS = {
	email: "taro@corp.example",
	address: "東京都渋谷区神南1-2-3",
	org: "株式会社アクメ",
	card: "4111 1111 1111 1111",
}

const history: AgentMessage[] = [
	{ type: "message", role: "user", content: `${SECRETS.org} の ${SECRETS.email} へ送って` },
	{
		type: "function_call_output",
		call_id: "1",
		output: `所在地: ${SECRETS.address}\n番号: ${SECRETS.card}`,
	},
] as AgentMessage[]

const systemPrompt = `作業場所は ${SECRETS.address}`

async function send(masker: TaskPiiMasker | undefined, port: number): Promise<void> {
	const handler = new OpenAiHandler({
		openAiBaseUrl: `http://127.0.0.1:${port}/v1`,
		openAiApiKey: "test-key",
		openAiModelId: "test-model",
		openAiStreamingEnabled: true,
	})

	const masked = await masker?.maskForRequest(systemPrompt, history)
	await drain(
		handler.createMessage(masked?.systemPrompt ?? systemPrompt, masked?.messages ?? history, {
			taskId: "t1",
		}),
	)
}

beforeEach(() => allowNetConnect("127.0.0.1"))

describe("伏せた結果が実際の HTTP の本文に載る（FR-PII-01）", () => {
	it("伏せると、生の値は 1 つも載らない", async () => {
		const server = await startServer()
		try {
			const masker = new TaskPiiMasker({
				enabled: true,
				terms: [{ value: SECRETS.org, kind: "org" }],
			})

			await send(masker, server.port)

			const sent = server.bodies.join("")
			expect(sent).not.toBe("")
			for (const [name, value] of Object.entries(SECRETS)) {
				// 送る手前で組み立て直す処理が 1 つでも挟まれば、ここで落ちる。
				expect(sent, `${name} が載っている`).not.toContain(value)
			}
			expect(sent).toContain("{{email-001}}")
			expect(sent).toContain("{{org-001}}")
			expect(sent).toContain("{{address-001}}")
			expect(sent).toContain("{{card-001}}")
		} finally {
			await server.close()
		}
	})

	it("伏せなければ、生の値が載る", async () => {
		const server = await startServer()
		try {
			// これが載らないなら、上の試験は何も見張っていない。
			await send(undefined, server.port)

			const sent = server.bodies.join("")
			expect(sent).toContain(SECRETS.email)
			expect(sent).toContain(SECRETS.address)
		} finally {
			await server.close()
		}
	})

	it("シークレットモードが切なら、生の値が載る（FR-PII-01a）", async () => {
		const server = await startServer()
		try {
			await send(new TaskPiiMasker({}), server.port)

			expect(server.bodies.join("")).toContain(SECRETS.email)
		} finally {
			await server.close()
		}
	})
})
