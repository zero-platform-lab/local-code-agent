import {
	type ModelInfo,
	type ProviderSettings,
	type VerbosityLevel,
	type ReasoningEffortExtended,
} from "@openai-agent/types"

import { shouldUseReasoningEffort, getModelMaxOutputTokens } from "../../shared/api"

import { type OpenAiReasoningParams, getOpenAiReasoning } from "./reasoning"

type GetModelParamsOptions = {
	modelId: string
	model: ModelInfo
	settings: ProviderSettings
	defaultTemperature: number
}

type BaseModelParams = {
	maxTokens: number | undefined
	temperature: number | undefined
	reasoningEffort: ReasoningEffortExtended | undefined
	verbosity: VerbosityLevel | undefined
	tools?: boolean
}

export type ModelParams = {
	format: "openai"
	reasoning: OpenAiReasoningParams | undefined
} & BaseModelParams

export function getModelParams({ modelId, model, settings, defaultTemperature }: GetModelParamsOptions): ModelParams {
	const {
		modelTemperature: customTemperature,
		reasoningEffort: customReasoningEffort,
		verbosity: customVerbosity,
	} = settings

	// Use the centralized logic for computing maxTokens
	const maxTokens = getModelMaxOutputTokens({
		modelId,
		model,
		settings,
		format: "openai",
	})

	let temperature: number | undefined = customTemperature ?? model.defaultTemperature ?? defaultTemperature
	let reasoningEffort: ModelParams["reasoningEffort"] = undefined
	const verbosity: VerbosityLevel | undefined = customVerbosity

	if (shouldUseReasoningEffort({ model, settings })) {
		// "Traditional" reasoning models use the `reasoningEffort` parameter.
		// Only fallback to model default if user hasn't explicitly set a value.
		// If customReasoningEffort is "disable", don't fallback to model default.
		const effort =
			customReasoningEffort !== undefined
				? customReasoningEffort
				: (model.reasoningEffort as ReasoningEffortExtended | "disable" | undefined)
		// Capability and settings checks are handled by shouldUseReasoningEffort.
		// Here we simply propagate the resolved effort into the params, while
		// still treating "disable" as an omission.
		if (effort && effort !== "disable") {
			reasoningEffort = effort as ReasoningEffortExtended
		}
	}

	// Special case for o1 and o3-mini, which don't support temperature.
	// TODO: Add a `supportsTemperature` field to the model info.
	if (modelId.startsWith("o1") || modelId.startsWith("o3-mini")) {
		temperature = undefined
	}

	return {
		format: "openai",
		maxTokens,
		temperature,
		reasoningEffort,
		verbosity,
		reasoning: getOpenAiReasoning({ model, reasoningEffort, settings }),
	}
}
