// キャッシュ読み出しトークンの拾い上げ。
// OpenAI は prompt_tokens_details.cached_tokens (Chat Completions) /
// input_tokens_details.cached_tokens (Responses) で返す。以前は Anthropic の
// フィールド名を読んでいたため常に undefined で、キャッシュ会計が働いていなかった。

import { describe, it, expect, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: () => undefined }) },
}))

import { OpenAiHandler } from "../openai"

const handler = () =>
	new OpenAiHandler({
		openAiBaseUrl: "http://127.0.0.1:1/v1",
		openAiApiKey: "k",
		openAiModelId: "gpt-4o",
	}) as unknown as { processUsageMetrics: (u: unknown) => Record<string, unknown> }

describe("processUsageMetrics - cacheReadTokens", () => {
	it("Chat Completions の prompt_tokens_details.cached_tokens を拾う", () => {
		const out = handler().processUsageMetrics({
			prompt_tokens: 1000,
			completion_tokens: 50,
			prompt_tokens_details: { cached_tokens: 768 },
		})
		expect(out.inputTokens).toBe(1000)
		expect(out.outputTokens).toBe(50)
		expect(out.cacheReadTokens).toBe(768)
	})

	it("Responses の input_tokens_details.cached_tokens も拾う", () => {
		const out = handler().processUsageMetrics({
			prompt_tokens: 200,
			input_tokens_details: { cached_tokens: 128 },
		})
		expect(out.cacheReadTokens).toBe(128)
	})

	it("cached_tokens が 0 / 欠如なら undefined", () => {
		expect(
			handler().processUsageMetrics({ prompt_tokens_details: { cached_tokens: 0 } }).cacheReadTokens,
		).toBeUndefined()
		expect(handler().processUsageMetrics({ prompt_tokens: 5 }).cacheReadTokens).toBeUndefined()
	})

	it("Anthropic 互換の名前で返す互換サーバも拾う", () => {
		expect(handler().processUsageMetrics({ cache_read_input_tokens: 42 }).cacheReadTokens).toBe(42)
	})
})
