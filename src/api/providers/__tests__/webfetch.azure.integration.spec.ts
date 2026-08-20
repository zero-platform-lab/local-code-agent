// web_fetch を tools に載せた実リクエストを、擬似 Azure サーバへ SDK 経路ごと流す。
// 目的: 0.8.1 が web_fetch でワイヤに何を送るか／web_fetch 込みで応答が通るか／
//       モデルが web_fetch を呼んだ応答を tool_call として拾えるか、を実挙動で確認する。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
}))

import { OpenAiHandler } from "../openai"
import { startFakeAzureServer } from "./fakeAzureServer"
import { allowNetConnect } from "../../../vitest.setup"
import { getNativeTools } from "../../../core/prompts/tools/native-tools"

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

const USER_MSG = [{ type: "message", role: "user", content: "hi" }] as never
const META = { taskId: "t1", tools: getNativeTools() } as never

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
	const out: any[] = []
	for await (const c of stream) out.push(c)
	return out
}

describe("web_fetch を載せた Azure リクエスト（擬似サーバ）", () => {
	beforeEach(() => allowNetConnect("127.0.0.1"))
	afterEach(() => vi.restoreAllMocks())

	it("web_fetch のワイヤ上スキーマを実物で確認し、200 が返る", async () => {
		const server = await startFakeAzureServer({ mode: "chat", content: "ok" })
		try {
			const handler = azureHandler(server.baseUrl)
			const chunks = await collect(handler.createMessage("sys", USER_MSG, META))
			const text = chunks
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
			expect(text).toBe("ok")

			const sentTools = server.requests[0].body.tools as any[]
			const wf = sentTools.find((t) => t?.function?.name === "web_fetch")
			// ワイヤ上の web_fetch を目視できるよう出力

			expect(wf).toBeTruthy()
			expect(wf.function.strict).toBeUndefined() // 非 strict（400 回避）
			expect(wf.function.parameters.required).toEqual(["url"])
			expect(wf.function.parameters.properties.url.type).toBe("string")
			expect(wf.function.parameters.additionalProperties).toBe(false)
			// 他 read ツールと構造が揃っているか（strict 無し・type は文字列/配列でない単一型）
			const anyStrict = sentTools.filter((t) => t.function?.strict !== undefined)
			expect(anyStrict.length).toBe(0)
		} finally {
			await server.close()
		}
	})

	it("モデルが web_fetch を呼んだ応答を tool_call として拾える", async () => {
		const server = await startFakeAzureServer({
			mode: "toolcall",
			toolName: "web_fetch",
			toolArgs: JSON.stringify({ url: "https://example.com" }),
			callId: "call_wf",
		})
		try {
			const handler = azureHandler(server.baseUrl)
			const chunks = await collect(handler.createMessage("sys", USER_MSG, META))
			const toolCall = chunks.find((c) => c.type === "tool_call")
			expect(toolCall?.name).toBe("web_fetch")
			expect(JSON.parse(toolCall.arguments).url).toBe("https://example.com")
		} finally {
			await server.close()
		}
	})
})
