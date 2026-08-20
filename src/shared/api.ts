import { type ModelInfo, type ProviderSettings, ANTHROPIC_DEFAULT_MAX_TOKENS } from "@openai-agent/types"

// ApiHandlerOptions
// 現状は ProviderSettings から apiProvider を除いたもの（handler 固有の追加項目は無し）。
export type ApiHandlerOptions = Omit<ProviderSettings, "apiProvider">

// Reasoning

export const shouldUseReasoningEffort = ({
	model,
	settings,
}: {
	model: ModelInfo
	settings?: ProviderSettings
}): boolean => {
	// Explicit off switch
	if (settings?.enableReasoningEffort === false) return false

	// Selected effort from settings or model default
	const selectedEffort = (settings?.reasoningEffort ?? (model as any).reasoningEffort) as
		| "disable"
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| undefined

	// "disable" explicitly omits reasoning
	if (selectedEffort === "disable") return false

	const cap = model.supportsReasoningEffort as unknown

	// Capability array: use only if selected is included (treat "none"/"minimal" as valid)
	if (Array.isArray(cap)) {
		return !!selectedEffort && (cap as ReadonlyArray<string>).includes(selectedEffort as string)
	}

	// Boolean capability: true → require a selected effort
	if (model.supportsReasoningEffort === true) {
		return !!selectedEffort
	}

	// Not explicitly supported: only allow when the model itself defines a default effort
	// Ignore settings-only selections when capability is absent/false
	const modelDefaultEffort = (model as any).reasoningEffort as
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| undefined
	return !!modelDefaultEffort
}

// Max Tokens

export const getModelMaxOutputTokens = ({
	modelId,
	model,
	format,
}: {
	modelId: string
	model: ModelInfo
	settings?: ProviderSettings
	format?: "openai"
}): number | undefined => {
	const isAnthropicContext = modelId.includes("claude")

	// For Anthropic contexts, always ensure a maxTokens value is set
	if (isAnthropicContext && (!model.maxTokens || model.maxTokens === 0)) {
		return ANTHROPIC_DEFAULT_MAX_TOKENS
	}

	// If model has explicit maxTokens, clamp it to 20% of the context window
	// Exception: GPT-5 models should use their exact configured max output tokens
	if (model.maxTokens) {
		// Check if this is a GPT-5 model (case-insensitive)
		const isGpt5Model = modelId.toLowerCase().includes("gpt-5")

		// GPT-5 models bypass the 20% cap and use their full configured max tokens
		if (isGpt5Model) {
			return model.maxTokens
		}

		// All other models are clamped to 20% of context window
		return Math.min(model.maxTokens, Math.ceil(model.contextWindow * 0.2))
	}

	// For non-Anthropic formats without explicit maxTokens, return undefined
	if (format) {
		return undefined
	}

	// Default fallback
	return ANTHROPIC_DEFAULT_MAX_TOKENS
}
