// npx vitest run shared/__tests__/cost.spec.ts

import type { ModelInfo } from "@openai-agent/types"

import { calculateApiCostOpenAI, parseApiPrice } from "../cost"

const model = (partial: Partial<ModelInfo> = {}): ModelInfo =>
	({ contextWindow: 200_000, supportsPromptCache: true, ...partial }) as ModelInfo

describe("calculateApiCostOpenAI", () => {
	it("価格未設定なら totalCost は 0（|| 0 の左falsy側）", () => {
		const result = calculateApiCostOpenAI(model(), 1000, 500)
		expect(result).toEqual({ totalInputTokens: 1000, totalOutputTokens: 500, totalCost: 0 })
	})

	it("input/output/cacheReads 価格が全て効く（|| 0 の左truthy側）", () => {
		const info = model({ inputPrice: 3, outputPrice: 15, cacheReadsPrice: 0.3 })
		// cacheRead=200, nonCached input=800
		const result = calculateApiCostOpenAI(info, 1000, 500, 200)
		const expected = (0.3 / 1e6) * 200 + (3 / 1e6) * 800 + (15 / 1e6) * 500
		expect(result.totalCost).toBeCloseTo(expected, 12)
		expect(result.totalInputTokens).toBe(1000)
		expect(result.totalOutputTokens).toBe(500)
	})

	it("cacheReadInputTokens 省略時は 0 として扱う", () => {
		const info = model({ inputPrice: 3 })
		const result = calculateApiCostOpenAI(info, 1000, 0)
		expect(result.totalCost).toBeCloseTo((3 / 1e6) * 1000, 12)
	})

	it("キャッシュ読み出しが入力を上回っても nonCached は 0 でクランプ", () => {
		const info = model({ inputPrice: 3 })
		const result = calculateApiCostOpenAI(info, 100, 0, 500)
		// nonCached = max(0, 100-500) = 0 → base input cost 0
		expect(result.totalCost).toBe(0)
	})

	describe("longContextPricing", () => {
		it("longContextPricing が無ければ素通り（!pricing）", () => {
			const info = model({ inputPrice: 3 })
			const result = calculateApiCostOpenAI(info, 1000, 0)
			expect(result.totalCost).toBeCloseTo((3 / 1e6) * 1000, 12)
		})

		it("閾値以下なら乗数を適用しない", () => {
			const info = model({
				inputPrice: 3,
				longContextPricing: { thresholdTokens: 10_000, inputPriceMultiplier: 2 },
			})
			const result = calculateApiCostOpenAI(info, 1000, 0)
			expect(result.totalCost).toBeCloseTo((3 / 1e6) * 1000, 12)
		})

		it("閾値超過かつ乗数と価格が揃えば input/output/cacheReads 全てに乗数を適用", () => {
			const info = model({
				inputPrice: 3,
				outputPrice: 15,
				cacheReadsPrice: 0.3,
				longContextPricing: {
					thresholdTokens: 100,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 3,
					cacheReadsPriceMultiplier: 4,
				},
			})
			// totalInput=1000 > 100. cacheRead=100 → nonCached=900
			const result = calculateApiCostOpenAI(info, 1000, 500, 100)
			const expected = ((0.3 * 4) / 1e6) * 100 + ((3 * 2) / 1e6) * 900 + ((15 * 3) / 1e6) * 500
			expect(result.totalCost).toBeCloseTo(expected, 12)
		})

		it("閾値超過でも乗数/価格が欠ければ元価格を保持（各三項の false 側）", () => {
			// inputPrice はあるが inputPriceMultiplier 無し、output/cacheReads は価格自体が無い
			const info = model({
				inputPrice: 3,
				longContextPricing: { thresholdTokens: 100, outputPriceMultiplier: 3 },
			})
			const result = calculateApiCostOpenAI(info, 1000, 500, 0)
			// 乗数未適用の素の inputPrice のみ
			expect(result.totalCost).toBeCloseTo((3 / 1e6) * 1000, 12)
		})

		it("appliesToServiceTiers に該当しない tier では乗数を適用しない", () => {
			const info = model({
				inputPrice: 3,
				longContextPricing: {
					thresholdTokens: 100,
					inputPriceMultiplier: 10,
					appliesToServiceTiers: ["flex"],
				},
			})
			// serviceTier 未指定 → "default" は ["flex"] に含まれない → 素通り
			const result = calculateApiCostOpenAI(info, 1000, 0)
			expect(result.totalCost).toBeCloseTo((3 / 1e6) * 1000, 12)
		})

		it("appliesToServiceTiers に該当する tier では乗数を適用（serviceTier 明示）", () => {
			const info = model({
				inputPrice: 3,
				longContextPricing: {
					thresholdTokens: 100,
					inputPriceMultiplier: 10,
					appliesToServiceTiers: ["flex"],
				},
			})
			const result = calculateApiCostOpenAI(info, 1000, 0, 0, "flex")
			expect(result.totalCost).toBeCloseTo((30 / 1e6) * 1000, 12)
		})
	})
})

describe("parseApiPrice", () => {
	it("truthy な価格文字列を 100 万倍にする", () => {
		expect(parseApiPrice("3")).toBe(3_000_000)
		expect(parseApiPrice(0.000003)).toBeCloseTo(3, 9)
	})

	it("falsy（0/undefined）なら undefined", () => {
		expect(parseApiPrice(0)).toBeUndefined()
		expect(parseApiPrice(undefined)).toBeUndefined()
	})
})
