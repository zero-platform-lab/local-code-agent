// npx vitest utils/__tests__/cost.spec.ts

import type { ModelInfo } from "@openai-agent/types"

import { calculateApiCostOpenAI } from "../../shared/cost"

describe("Cost Utility", () => {
	describe("calculateApiCostOpenAI", () => {
		const mockModelInfo: ModelInfo = {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsPromptCache: true,
			inputPrice: 3.0, // $3 per million tokens
			outputPrice: 15.0, // $15 per million tokens
			cacheReadsPrice: 0.3, // $0.30 per million tokens
		}

		it("should calculate basic input/output costs correctly", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 1000, 500)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			expect(result.totalCost).toBe(0.0105)
			expect(result.totalInputTokens).toBe(1000)
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle cache reads cost", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 4000, 500, 3000)

			// Input cost: (3.0 / 1_000_000) * (4000 - 3000) = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Cache reads: (0.3 / 1_000_000) * 3000 = 0.0009
			// Total: 0.003 + 0.0075 + 0.0009 = 0.0114
			expect(result.totalCost).toBe(0.0114)
			expect(result.totalInputTokens).toBe(4000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle all cost components together", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 4000, 500, 3000)

			// Input cost: (3.0 / 1_000_000) * (4000 - 3000) = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Cache reads: (0.3 / 1_000_000) * 3000 = 0.0009
			// Total: 0.003 + 0.0075 + 0.0009 = 0.0114
			expect(result.totalCost).toBe(0.0114)
			expect(result.totalInputTokens).toBe(4000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle missing prices gracefully", () => {
			const modelWithoutPrices: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
			}

			const result = calculateApiCostOpenAI(modelWithoutPrices, 1000, 500, 3000)
			expect(result.totalCost).toBe(0)
			expect(result.totalInputTokens).toBe(1000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle zero tokens", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 0, 0, 0)
			expect(result.totalCost).toBe(0)
			expect(result.totalInputTokens).toBe(0)
			expect(result.totalOutputTokens).toBe(0)
		})

		it("should handle undefined cache values", () => {
			const result = calculateApiCostOpenAI(mockModelInfo, 1000, 500)

			// Input cost: (3.0 / 1_000_000) * 1000 = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			expect(result.totalCost).toBe(0.0105)
			expect(result.totalInputTokens).toBe(1000)
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should handle missing cache prices", () => {
			const modelWithoutCachePrices: ModelInfo = {
				...mockModelInfo,
				cacheReadsPrice: undefined,
			}

			const result = calculateApiCostOpenAI(modelWithoutCachePrices, 4000, 500, 3000)

			// Should only include input and output costs
			// Input cost: (3.0 / 1_000_000) * (4000 - 3000) = 0.003
			// Output cost: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			expect(result.totalCost).toBe(0.0105)
			expect(result.totalInputTokens).toBe(4000) // Total already includes cache
			expect(result.totalOutputTokens).toBe(500)
		})

		it("should not apply long-context pricing at the threshold", () => {
			const modelWithLongContextPricing: ModelInfo = {
				...mockModelInfo,
				longContextPricing: {
					thresholdTokens: 272_000,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 1.5,
					cacheReadsPriceMultiplier: 2,
				},
			}

			const result = calculateApiCostOpenAI(modelWithLongContextPricing, 272_000, 1_000, 100_000)

			// Input cost: (3.0 / 1_000_000) * (272000 - 100000) = 0.516
			// Output cost: (15.0 / 1_000_000) * 1000 = 0.015
			// Cache reads: (0.3 / 1_000_000) * 100000 = 0.03
			// Total: 0.516 + 0.015 + 0.03 = 0.561
			expect(result.totalCost).toBeCloseTo(0.561, 6)
		})

		it("should apply long-context pricing above the threshold", () => {
			const modelWithLongContextPricing: ModelInfo = {
				maxTokens: 128_000,
				contextWindow: 1_050_000,
				supportsPromptCache: true,
				inputPrice: 2.5,
				outputPrice: 15.0,
				cacheReadsPrice: 0.25,
				longContextPricing: {
					thresholdTokens: 272_000,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 1.5,
					cacheReadsPriceMultiplier: 2,
				},
			}

			const result = calculateApiCostOpenAI(modelWithLongContextPricing, 300_000, 1_000, 100_000)

			// Input cost: (5.0 / 1_000_000) * (300000 - 100000) = 1.0
			// Output cost: (22.5 / 1_000_000) * 1000 = 0.0225
			// Cache reads: (0.5 / 1_000_000) * 100000 = 0.05
			// Total: 1.0 + 0.0225 + 0.05 = 1.0725
			expect(result.totalCost).toBeCloseTo(1.0725, 6)
		})

		it("should skip long-context pricing for service tiers outside the allowed list", () => {
			const modelWithLongContextPricing: ModelInfo = {
				maxTokens: 128_000,
				contextWindow: 1_050_000,
				supportsPromptCache: true,
				inputPrice: 5.0,
				outputPrice: 30.0,
				cacheReadsPrice: 0.5,
				longContextPricing: {
					thresholdTokens: 272_000,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 1.5,
					appliesToServiceTiers: ["default", "flex"],
				},
			}

			const result = calculateApiCostOpenAI(modelWithLongContextPricing, 300_000, 1_000, 100_000, "priority")

			// Input cost: (5.0 / 1_000_000) * (300000 - 100000) = 1.0
			// Output cost: (30.0 / 1_000_000) * 1000 = 0.03
			// Cache reads: (0.5 / 1_000_000) * 100000 = 0.05
			// Total: 1.0 + 0.03 + 0.05 = 1.08
			expect(result.totalCost).toBeCloseTo(1.08, 6)
		})
	})
})
