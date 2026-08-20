import { type ProviderSettings, openAiModelInfoSaneDefaults } from "@openai-agent/types"

/**
 * Returns the currently selected model for the API configuration.
 *
 * [INTERNAL] Only the OpenAI Compatible provider is supported in this build; the
 * model id is entered manually rather than fetched from a provider model list,
 * so there is never a loading or error state.
 */
export const useSelectedModel = (apiConfiguration?: ProviderSettings) => {
	const provider = apiConfiguration?.apiProvider || "openai"
	const id = apiConfiguration?.openAiModelId ?? apiConfiguration?.apiModelId ?? ""
	const info = apiConfiguration?.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults

	return {
		provider,
		id,
		info,
		isLoading: false,
		isError: false,
	}
}
