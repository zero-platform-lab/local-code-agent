// npx vitest run api/transform/__tests__/reasoning.spec.ts
//
// getOpenAiReasoning は Chat Completions 用の reasoning_effort を組み立てる純粋関数。
// shouldUseReasoningEffort の可否 → "disable"/未指定の握り潰し → 実値の透過、の
// 3 分岐を実測する（line 21 の `|| !reasoningEffort` を含む）。

import type { ModelInfo, ProviderSettings } from "@openai-agent/types"

import { getOpenAiReasoning } from "../reasoning"

// supportsReasoningEffort=true にすると、選択済み effort があるとき
// shouldUseReasoningEffort が true を返す（shared/api.ts の実装に準拠）。
const enabledModel: ModelInfo = {
	contextWindow: 128_000,
	supportsPromptCache: false,
	supportsReasoningEffort: true,
}

// settings.reasoningEffort を "high" に固定して shouldUseReasoningEffort を通す。
// 検証したいのは第 2 引数 reasoningEffort（getModelParams が算出して渡す値）の扱い。
const enabledSettings: ProviderSettings = {
	enableReasoningEffort: true,
	reasoningEffort: "high",
} as unknown as ProviderSettings

describe("getOpenAiReasoning", () => {
	it("returns undefined when the model does not support reasoning effort", () => {
		const model: ModelInfo = { contextWindow: 1, supportsPromptCache: false }
		const result = getOpenAiReasoning({
			model,
			reasoningEffort: "high",
			settings: {} as ProviderSettings,
		})
		expect(result).toBeUndefined()
	})

	it('returns undefined when the effort is "disable" even though the model supports it', () => {
		const result = getOpenAiReasoning({
			model: enabledModel,
			reasoningEffort: "disable",
			settings: enabledSettings,
		})
		expect(result).toBeUndefined()
	})

	it("returns undefined when the effort is missing (falsy) — the `!reasoningEffort` branch", () => {
		const result = getOpenAiReasoning({
			model: enabledModel,
			reasoningEffort: undefined,
			settings: enabledSettings,
		})
		expect(result).toBeUndefined()
	})

	it("passes the literal effort through when supported and set", () => {
		const result = getOpenAiReasoning({
			model: enabledModel,
			reasoningEffort: "medium",
			settings: enabledSettings,
		})
		expect(result).toEqual({ reasoning_effort: "medium" })
	})

	it('supports the "none" literal', () => {
		const result = getOpenAiReasoning({
			model: enabledModel,
			reasoningEffort: "none",
			settings: enabledSettings,
		})
		expect(result).toEqual({ reasoning_effort: "none" })
	})
})
