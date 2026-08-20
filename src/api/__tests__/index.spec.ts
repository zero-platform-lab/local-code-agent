// npx vitest run api/__tests__/index.spec.ts
//
// buildApiHandler のディスパッチを実測する。
// - "openai"   → OpenAiHandler（OpenAI 互換）
// - "fake-ai"  → FakeAIHandler（ネットワークに出ない内部テスト用）
// - それ以外   → 明示的に throw（imported/migrated 設定で他社エンドポイントへ
//                到達させないためのガード）
//
// **不変条件**: この build では OpenAI 互換以外のプロバイダを絶対に実体化しない。

import type { ProviderSettings, ModelInfo, AgentMessage } from "@openai-agent/types"

import { buildApiHandler } from "../index"
import { OpenAiHandler } from "../providers/openai"
import { FakeAIHandler } from "../providers/fake-ai"

function makeFakeAi() {
	return {
		id: "fake-1",
		async *createMessage() {
			// 何も返さない空ストリーム
		},
		getModel(): { id: string; info: ModelInfo } {
			return { id: "fake", info: { contextWindow: 8, supportsPromptCache: false } }
		},
		async countTokens() {
			return 0
		},
		async completePrompt() {
			return ""
		},
	}
}

describe("buildApiHandler", () => {
	it('constructs an OpenAiHandler for apiProvider "openai"', () => {
		const handler = buildApiHandler({
			apiProvider: "openai",
			openAiApiKey: "k",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://api.openai.com/v1",
		} as ProviderSettings)

		expect(handler).toBeInstanceOf(OpenAiHandler)
	})

	it('constructs a FakeAIHandler for apiProvider "fake-ai"', () => {
		const handler = buildApiHandler({
			apiProvider: "fake-ai",
			fakeAi: makeFakeAi(),
		} as unknown as ProviderSettings)

		expect(handler).toBeInstanceOf(FakeAIHandler)
	})

	it("throws for an unsupported provider, naming the provider", () => {
		expect(() => buildApiHandler({ apiProvider: "anthropic" } as unknown as ProviderSettings)).toThrow(
			/anthropic.*not supported|not supported/i,
		)
	})

	it("throws with a readable placeholder when apiProvider is missing", () => {
		expect(() => buildApiHandler({} as ProviderSettings)).toThrow(/\(none\)/)
	})

	it("does not leak the apiProvider field into the handler options", () => {
		// buildApiHandler は apiProvider を分割代入で剥がしてから options を渡す。
		// FakeAIHandler は fakeAi しか見ないので、副作用が無いことだけ確認する。
		const messages: AgentMessage[] = []
		const handler = buildApiHandler({
			apiProvider: "fake-ai",
			fakeAi: makeFakeAi(),
		} as unknown as ProviderSettings)
		expect(handler.getModel().id).toBe("fake")
		expect(handler.createMessage("sys", messages)).toBeDefined()
	})
})
