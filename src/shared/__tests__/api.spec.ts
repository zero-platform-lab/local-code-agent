// npx vitest run shared/__tests__/api.spec.ts

import type { ModelInfo, ProviderSettings } from "@openai-agent/types"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@openai-agent/types"

import { shouldUseReasoningEffort, getModelMaxOutputTokens } from "../api"

// ModelInfo は contextWindow と supportsPromptCache のみ必須。境界確認用の最小フィクスチャ。
const model = (partial: Partial<ModelInfo> = {}): ModelInfo =>
	({ contextWindow: 200_000, supportsPromptCache: false, ...partial }) as ModelInfo

describe("shouldUseReasoningEffort", () => {
	it("明示 off (enableReasoningEffort=false) なら常に false", () => {
		expect(
			shouldUseReasoningEffort({
				model: model({ supportsReasoningEffort: true }),
				settings: { enableReasoningEffort: false } as ProviderSettings,
			}),
		).toBe(false)
	})

	it("選択 effort が 'disable' なら false", () => {
		expect(
			shouldUseReasoningEffort({
				model: model({ supportsReasoningEffort: true }),
				settings: { reasoningEffort: "disable" } as unknown as ProviderSettings,
			}),
		).toBe(false)
	})

	it("能力が配列で選択 effort が含まれれば true", () => {
		expect(
			shouldUseReasoningEffort({
				model: model({ supportsReasoningEffort: ["high", "low"] }),
				settings: { reasoningEffort: "high" } as ProviderSettings,
			}),
		).toBe(true)
	})

	it("能力が配列で選択 effort が含まれなければ false", () => {
		expect(
			shouldUseReasoningEffort({
				model: model({ supportsReasoningEffort: ["high"] }),
				settings: { reasoningEffort: "low" } as ProviderSettings,
			}),
		).toBe(false)
	})

	it("能力が配列でも選択 effort が無ければ false（settings 未指定・モデル既定なし）", () => {
		expect(
			shouldUseReasoningEffort({
				model: model({ supportsReasoningEffort: ["high"] }),
			}),
		).toBe(false)
	})

	it("能力が boolean true で選択 effort があれば true", () => {
		expect(
			shouldUseReasoningEffort({
				model: model({ supportsReasoningEffort: true }),
				settings: { reasoningEffort: "medium" } as ProviderSettings,
			}),
		).toBe(true)
	})

	it("能力が boolean true でも選択 effort が無ければ false", () => {
		expect(
			shouldUseReasoningEffort({
				model: model({ supportsReasoningEffort: true }),
			}),
		).toBe(false)
	})

	it("能力が無くてもモデル既定 effort があれば true（settings 未指定→モデル値を採用）", () => {
		expect(
			shouldUseReasoningEffort({
				model: model({ reasoningEffort: "medium" }),
			}),
		).toBe(true)
	})

	it("能力が無くモデル既定 effort も無ければ false", () => {
		expect(
			shouldUseReasoningEffort({
				model: model({ supportsReasoningEffort: false }),
			}),
		).toBe(false)
	})
})

describe("getModelMaxOutputTokens", () => {
	it("claude 文脈で maxTokens 未設定なら Anthropic 既定値", () => {
		expect(getModelMaxOutputTokens({ modelId: "claude-3-5-sonnet", model: model() })).toBe(
			ANTHROPIC_DEFAULT_MAX_TOKENS,
		)
	})

	it("claude 文脈で maxTokens=0 なら Anthropic 既定値", () => {
		expect(getModelMaxOutputTokens({ modelId: "claude-x", model: model({ maxTokens: 0 }) })).toBe(
			ANTHROPIC_DEFAULT_MAX_TOKENS,
		)
	})

	it("GPT-5 は 20% 上限を無視して設定値そのまま", () => {
		expect(getModelMaxOutputTokens({ modelId: "gpt-5-mini", model: model({ maxTokens: 128_000 }) })).toBe(128_000)
	})

	it("その他モデルは context window の 20% にクランプ", () => {
		// maxTokens 100000 > ceil(200000*0.2)=40000 なので 40000 に丸め
		expect(getModelMaxOutputTokens({ modelId: "some-model", model: model({ maxTokens: 100_000 }) })).toBe(40_000)
	})

	it("maxTokens が context window 20% 未満ならそのまま返す", () => {
		expect(getModelMaxOutputTokens({ modelId: "some-model", model: model({ maxTokens: 1000 }) })).toBe(1000)
	})

	it("非 Anthropic・maxTokens 無し・format 指定なら undefined", () => {
		expect(getModelMaxOutputTokens({ modelId: "gpt-4", model: model(), format: "openai" })).toBeUndefined()
	})

	it("非 Anthropic・maxTokens 無し・format 無しなら Anthropic 既定値へフォールバック", () => {
		expect(getModelMaxOutputTokens({ modelId: "gpt-4", model: model() })).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
	})

	it("claude 文脈でも maxTokens 設定済みなら 20% クランプ側へ進む", () => {
		expect(getModelMaxOutputTokens({ modelId: "claude-x", model: model({ maxTokens: 1000 }) })).toBe(1000)
	})
})
