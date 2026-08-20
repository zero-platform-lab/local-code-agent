import type { ModelInfo } from "../model.js"

// Sane fallback model info used when the OpenAI Compatible endpoint does not
// advertise capabilities for the configured model.
export const openAiModelInfoSaneDefaults: ModelInfo = {
	maxTokens: -1,
	contextWindow: 128_000,
	supportsImages: true,
	supportsPromptCache: false,
	inputPrice: 0,
	outputPrice: 0,
}

// https://learn.microsoft.com/en-us/azure/ai-services/openai/api-version-deprecation
// https://learn.microsoft.com/en-us/azure/ai-services/openai/reference#api-specs
export const azureOpenAiDefaultApiVersion = "2024-08-01-preview"

export const OPENAI_AZURE_AI_INFERENCE_PATH = "/models/chat/completions"
