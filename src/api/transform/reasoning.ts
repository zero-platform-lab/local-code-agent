import OpenAI from "openai"

import type { ModelInfo, ProviderSettings, ReasoningEffortExtended } from "@openai-agent/types"

import { shouldUseReasoningEffort } from "../../shared/api"

export type OpenAiReasoningParams = { reasoning_effort: OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"] }

export type GetModelReasoningOptions = {
	model: ModelInfo
	reasoningEffort: ReasoningEffortExtended | "disable" | undefined
	settings: ProviderSettings
}

export const getOpenAiReasoning = ({
	model,
	reasoningEffort,
	settings,
}: GetModelReasoningOptions): OpenAiReasoningParams | undefined => {
	if (!shouldUseReasoningEffort({ model, settings })) return undefined
	if (reasoningEffort === "disable" || !reasoningEffort) return undefined

	// Include "none" | "minimal" | "low" | "medium" | "high" literally
	return {
		reasoning_effort: reasoningEffort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"],
	}
}
