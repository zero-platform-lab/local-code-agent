import i18next from "i18next"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	type ProviderName,
	isProviderName,
} from "@openai-agent/types"

export function validateApiConfiguration(
	apiConfiguration: ProviderSettings,
	organizationAllowList?: OrganizationAllowList,
): string | undefined {
	const keysAndIdsPresentErrorMessage = validateModelsAndKeysProvided(apiConfiguration)

	if (keysAndIdsPresentErrorMessage) {
		return keysAndIdsPresentErrorMessage
	}

	const organizationAllowListError = validateProviderAgainstOrganizationSettings(
		apiConfiguration,
		organizationAllowList,
	)

	if (organizationAllowListError) {
		return organizationAllowListError.message
	}

	return undefined
}

function validateModelsAndKeysProvided(apiConfiguration: ProviderSettings): string | undefined {
	switch (apiConfiguration.apiProvider) {
		case "openai":
			// The API key is optional: self-hosted OpenAI-compatible endpoints (vLLM / Ollama / TGI)
			// commonly require no authentication. Only the base URL and model id are mandatory.
			if (!apiConfiguration.openAiBaseUrl || !apiConfiguration.openAiModelId) {
				return i18next.t("settings:validation.openAi")
			}
			break
	}

	return undefined
}

type ValidationError = {
	message: string
	code: "PROVIDER_NOT_ALLOWED" | "MODEL_NOT_ALLOWED"
}

function validateProviderAgainstOrganizationSettings(
	apiConfiguration: ProviderSettings,
	organizationAllowList?: OrganizationAllowList,
): ValidationError | undefined {
	if (organizationAllowList && !organizationAllowList.allowAll) {
		const provider = apiConfiguration.apiProvider

		if (!provider) {
			return undefined
		}

		const providerConfig = organizationAllowList.providers[provider]

		if (!providerConfig) {
			return {
				message: i18next.t("settings:validation.providerNotAllowed", { provider }),
				code: "PROVIDER_NOT_ALLOWED",
			}
		}

		if (!providerConfig.allowAll) {
			const modelId = getModelIdForProvider(apiConfiguration, provider)
			const allowedModels = providerConfig.models || []

			if (modelId && !allowedModels.includes(modelId)) {
				return {
					message: i18next.t("settings:validation.modelNotAllowed", {
						model: modelId,
						provider,
					}),
					code: "MODEL_NOT_ALLOWED",
				}
			}
		}
	}
}

function getModelIdForProvider(apiConfiguration: ProviderSettings, _provider: ProviderName): string | undefined {
	// [INTERNAL] Only the OpenAI Compatible provider is supported in this build.
	return apiConfiguration.openAiModelId ?? apiConfiguration.apiModelId
}

/**
 * Extracts model-specific validation errors from the API configuration.
 * This is used to show model errors specifically in the model selector components.
 */
export function getModelValidationError(
	apiConfiguration: ProviderSettings,
	organizationAllowList?: OrganizationAllowList,
): string | undefined {
	const modelId = isProviderName(apiConfiguration.apiProvider)
		? getModelIdForProvider(apiConfiguration, apiConfiguration.apiProvider)
		: apiConfiguration.apiModelId

	const configWithModelId = {
		...apiConfiguration,
		apiModelId: modelId || "",
	}

	const orgError = validateProviderAgainstOrganizationSettings(configWithModelId, organizationAllowList)

	if (orgError && orgError.code === "MODEL_NOT_ALLOWED") {
		return orgError.message
	}

	return undefined
}

/**
 * Validates API configuration but excludes model-specific errors.
 * This is used for the general API error display to prevent duplication
 * when model errors are shown in the model selector.
 */
export function validateApiConfigurationExcludingModelErrors(
	apiConfiguration: ProviderSettings,
	organizationAllowList?: OrganizationAllowList,
): string | undefined {
	const keysAndIdsPresentErrorMessage = validateModelsAndKeysProvided(apiConfiguration)

	if (keysAndIdsPresentErrorMessage) {
		return keysAndIdsPresentErrorMessage
	}

	const organizationAllowListError = validateProviderAgainstOrganizationSettings(
		apiConfiguration,
		organizationAllowList,
	)

	// Only return organization errors if they're not model-specific.
	if (organizationAllowListError && organizationAllowListError.code === "PROVIDER_NOT_ALLOWED") {
		return organizationAllowListError.message
	}

	// Skip model validation errors as they'll be shown in the model selector.
	return undefined
}
