// npx vitest run src/api/providers/__tests__/openaiAzure.integration.spec.ts
//
// **統合テスト**: 擬似 Azure OpenAI サーバ（実 HTTP）に対し、本物の `OpenAiHandler` を
// AzureOpenAI SDK 経路で丸ごと通す。モック fetch では通らない「SDK の URL 形成 / api-key /
// api-version / ストリーミング / tool_calls / エラー / 無応答ハング」を実挙動で検証する。
//
// 注意: これは「あなたの本番 Azure が“実際に”なぜ詰まるか」を再現するものではない
// （真因は接続テストで判明する）。判明した挙動を fakeAzureServer に焼き込んで回帰テストに
// するための土台であり、Azure リクエスト構築の正しさをここで固める。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
	},
}))

import { OpenAiHandler } from "../openai"
import { startFakeAzureServer } from "./fakeAzureServer"
import { allowNetConnect } from "../../../vitest.setup"

const DEPLOYMENT = "gpt-5-test"
const API_VERSION = "2024-08-01-preview"

function azureHandler(baseUrl: string, extra: Record<string, unknown> = {}): OpenAiHandler {
	return new OpenAiHandler({
		openAiBaseUrl: baseUrl,
		openAiApiKey: "test-key",
		openAiModelId: DEPLOYMENT,
		openAiUseAzure: true,
		azureApiVersion: API_VERSION,
		openAiStreamingEnabled: false,
		...extra,
	} as never)
}

async function collect(
	stream: AsyncIterable<{ type: string; text?: string }>,
): Promise<{ type: string; text?: string }[]> {
	const out: { type: string; text?: string }[] = []
	for await (const c of stream) out.push(c)
	return out
}

const USER_MSG = [{ type: "message", role: "user", content: "hi" }] as never

describe("OpenAiHandler against a fake Azure OpenAI server", () => {
	beforeEach(() => {
		allowNetConnect("127.0.0.1")
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("Azure の URL 契約（/openai/deployments/{dep}/chat/completions + api-version + api-key）で送る", async () => {
		const server = await startFakeAzureServer({ mode: "chat", content: "azure ok" })
		try {
			const handler = azureHandler(server.baseUrl)
			const chunks = await collect(handler.createMessage("sys", USER_MSG))

			// 応答テキストが流れてくる
			const text = chunks
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
			expect(text).toBe("azure ok")

			// 送信先の URL / 認証 / api-version が Azure 契約どおり
			expect(server.requests).toHaveLength(1)
			const r = server.requests[0]
			expect(r.method).toBe("POST")
			expect(r.path).toBe(`/openai/deployments/${DEPLOYMENT}/chat/completions`)
			expect(r.apiVersion).toBe(API_VERSION)
			expect(r.apiKey).toBe("test-key")
			// Azure は api-key ヘッダ。Bearer は使わない。
			expect(r.authorization).toBeUndefined()
		} finally {
			await server.close()
		}
	})

	it("ストリーミング（SSE）応答を chunk として流す", async () => {
		const server = await startFakeAzureServer({ mode: "stream-text", chunks: ["Hel", "lo!"] })
		try {
			const handler = azureHandler(server.baseUrl, { openAiStreamingEnabled: true })
			const chunks = await collect(handler.createMessage("sys", USER_MSG))
			const text = chunks
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
			expect(text).toBe("Hello!")
		} finally {
			await server.close()
		}
	})

	it("tool_calls 応答を tool_call チャンクとして流す", async () => {
		const server = await startFakeAzureServer({
			mode: "toolcall",
			toolName: "read_file",
			toolArgs: '{"path":"a.ts"}',
			callId: "call_42",
		})
		try {
			const handler = azureHandler(server.baseUrl)
			const chunks = (await collect(handler.createMessage("sys", USER_MSG))) as Array<{
				type: string
				[k: string]: unknown
			}>
			// tool_call 系のチャンクが少なくとも 1 つ出る（名前/引数のどこかに反映）
			const serialized = JSON.stringify(chunks)
			expect(serialized).toContain("read_file")
			expect(serialized).toContain("call_42")
		} finally {
			await server.close()
		}
	})

	it("reasoning_effort + tools を 400 で弾くサーバでは [sent] 付きエラーになる", async () => {
		const server = await startFakeAzureServer({ mode: "reject-reasoning-with-tools" })
		try {
			const handler = azureHandler(server.baseUrl, {
				openAiCustomModelInfo: { supportsReasoningEffort: true, reasoningEffort: "medium" },
			})
			await expect(
				collect(
					handler.createMessage("sys", USER_MSG, {
						taskId: "t1",
						tools: [
							{
								type: "function",
								function: { name: "read_file", description: "d", parameters: { type: "object" } },
							},
						],
						tool_choice: "auto",
					} as never),
				),
			).rejects.toThrow(/\[sent\]/)
		} finally {
			await server.close()
		}
	})

	it("応答が返らない Azure は watchdog のタイムアウトで中断する（無限ハングしない）", async () => {
		const server = await startFakeAzureServer({ mode: "hang" })
		try {
			const handler = azureHandler(server.baseUrl)
			;(handler as unknown as { requestTimeoutMs?: number }).requestTimeoutMs = 1500
			const started = Date.now()
			await expect(collect(handler.createMessage("sys", USER_MSG))).rejects.toThrow(/timed out after 1500ms/)
			expect(Date.now() - started).toBeLessThan(10_000)
		} finally {
			await server.close()
		}
	}, 20_000)

	// GPT-5.x の chat/completions は reasoning_effort + function tools を併用できない
	// （公式: use /responses or set reasoning_effort to "none"）。tools があるターンは
	// reasoning を切って送ることを、実リクエストの中身で検証する。これが Azure 5.6 のツール時
	// 無音ハングの根治。
	const reasoningModelInfo = {
		contextWindow: 200000,
		maxTokens: 8192,
		supportsPromptCache: false,
		supportsReasoningEffort: true,
		reasoningEffort: "medium",
	}
	const oneTool = [
		{
			type: "function",
			function: {
				name: "read_file",
				description: "read",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		},
	]

	it("reasoning モデル + tools では reasoning_effort=none を送る（併用非対応の回避）", async () => {
		const server = await startFakeAzureServer({ mode: "chat", content: "ok" })
		try {
			const handler = azureHandler(server.baseUrl, { openAiCustomModelInfo: reasoningModelInfo })
			await collect(
				handler.createMessage("sys", USER_MSG, {
					taskId: "t",
					tools: oneTool,
					tool_choice: "auto",
					parallelToolCalls: true,
				} as never),
			)
			expect(server.requests[0].body.reasoning_effort).toBe("none")
			expect(server.requests[0].body.tools).toHaveLength(1)
		} finally {
			await server.close()
		}
	})

	it("reasoning モデルでも tools が無ければ設定どおりの reasoning_effort を送る", async () => {
		const server = await startFakeAzureServer({ mode: "chat", content: "ok" })
		try {
			const handler = azureHandler(server.baseUrl, { openAiCustomModelInfo: reasoningModelInfo })
			await collect(handler.createMessage("sys", USER_MSG))
			expect(server.requests[0].body.reasoning_effort).toBe("medium")
			expect(server.requests[0].body.tools).toBeUndefined()
		} finally {
			await server.close()
		}
	})
})
