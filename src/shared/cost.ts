import type { ModelInfo } from "@openai-agent/types"
import type { ServiceTier } from "@openai-agent/types"

export interface ApiCostResult {
	totalInputTokens: number
	totalOutputTokens: number
	totalCost: number
}

function applyLongContextPricing(modelInfo: ModelInfo, totalInputTokens: number, serviceTier?: ServiceTier): ModelInfo {
	const pricing = modelInfo.longContextPricing
	if (!pricing || totalInputTokens <= pricing.thresholdTokens) {
		return modelInfo
	}

	const effectiveServiceTier = serviceTier ?? "default"
	if (pricing.appliesToServiceTiers && !pricing.appliesToServiceTiers.includes(effectiveServiceTier)) {
		return modelInfo
	}

	return {
		...modelInfo,
		inputPrice:
			modelInfo.inputPrice !== undefined && pricing.inputPriceMultiplier !== undefined
				? modelInfo.inputPrice * pricing.inputPriceMultiplier
				: modelInfo.inputPrice,
		outputPrice:
			modelInfo.outputPrice !== undefined && pricing.outputPriceMultiplier !== undefined
				? modelInfo.outputPrice * pricing.outputPriceMultiplier
				: modelInfo.outputPrice,
		cacheReadsPrice:
			modelInfo.cacheReadsPrice !== undefined && pricing.cacheReadsPriceMultiplier !== undefined
				? modelInfo.cacheReadsPrice * pricing.cacheReadsPriceMultiplier
				: modelInfo.cacheReadsPrice,
	}
}

function calculateApiCostInternal(
	modelInfo: ModelInfo,
	inputTokens: number,
	outputTokens: number,
	cacheReadInputTokens: number,
	totalInputTokens: number,
	totalOutputTokens: number,
): ApiCostResult {
	const cacheReadsCost = ((modelInfo.cacheReadsPrice || 0) / 1_000_000) * cacheReadInputTokens
	const baseInputCost = ((modelInfo.inputPrice || 0) / 1_000_000) * inputTokens
	const outputCost = ((modelInfo.outputPrice || 0) / 1_000_000) * outputTokens
	const totalCost = cacheReadsCost + baseInputCost + outputCost

	return {
		totalInputTokens,
		totalOutputTokens,
		totalCost,
	}
}

// OpenAI の usage では prompt_tokens がキャッシュ読み出し分を含むので、
// 素の入力トークンはキャッシュ分を引いて出す。
// OpenAI に「キャッシュ書き込み」の概念は無い（自動キャッシュ）ため、書き込み課金は扱わない。
export function calculateApiCostOpenAI(
	modelInfo: ModelInfo,
	inputTokens: number,
	outputTokens: number,
	cacheReadInputTokens?: number,
	serviceTier?: ServiceTier,
): ApiCostResult {
	const cacheReadInputTokensNum = cacheReadInputTokens || 0
	const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadInputTokensNum)
	const effectiveModelInfo = applyLongContextPricing(modelInfo, inputTokens, serviceTier)

	return calculateApiCostInternal(
		effectiveModelInfo,
		nonCachedInputTokens,
		outputTokens,
		cacheReadInputTokensNum,
		inputTokens,
		outputTokens,
	)
}

export const parseApiPrice = (price: any) => (price ? parseFloat(price) * 1_000_000 : undefined)
