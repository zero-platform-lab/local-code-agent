import { describe, it, expect, vi } from "vitest"

import type { OrganizationAllowList, ProviderSettings } from "@openai-agent/types"

// i18next is not initialized in unit tests; return the key so error messages are non-empty.
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }))

import {
	validateApiConfiguration,
	validateApiConfigurationExcludingModelErrors,
	getModelValidationError,
} from "../validate"

describe("validateApiConfiguration — OpenAI Compatible provider", () => {
	const base = { apiProvider: "openai" as const }

	it("is valid with base URL and model but NO API key (local vLLM / Ollama / TGI need no auth)", () => {
		const config: ProviderSettings = {
			...base,
			openAiBaseUrl: "http://localhost:8000/v1",
			openAiModelId: "my-model",
		}
		expect(validateApiConfiguration(config)).toBeUndefined()
	})

	it("stays valid when an API key is also provided", () => {
		const config: ProviderSettings = {
			...base,
			openAiBaseUrl: "http://localhost:8000/v1",
			openAiModelId: "my-model",
			openAiApiKey: "sk-something",
		}
		expect(validateApiConfiguration(config)).toBeUndefined()
	})

	it("errors when the base URL is missing", () => {
		expect(validateApiConfiguration({ ...base, openAiModelId: "my-model" })).toBeTruthy()
	})

	it("errors when the model id is missing", () => {
		expect(validateApiConfiguration({ ...base, openAiBaseUrl: "http://localhost:8000/v1" })).toBeTruthy()
	})
})

describe("validate — organization allow list", () => {
	const base: ProviderSettings = {
		apiProvider: "openai",
		openAiBaseUrl: "http://localhost:8000/v1",
		openAiModelId: "my-model",
	}

	const allowList = (providers: OrganizationAllowList["providers"]): OrganizationAllowList => ({
		allowAll: false,
		providers,
	})

	it("accepts everything when the org allows all", () => {
		expect(validateApiConfiguration(base, { allowAll: true, providers: {} })).toBeUndefined()
	})

	it("accepts everything when no allow list is supplied at all", () => {
		expect(validateApiConfiguration(base)).toBeUndefined()
	})

	it("rejects a provider that is absent from the allow list", () => {
		const error = validateApiConfiguration(base, allowList({}))
		expect(error).toBe("settings:validation.providerNotAllowed")
	})

	it("accepts any model when the provider entry allows all models", () => {
		expect(validateApiConfiguration(base, allowList({ openai: { allowAll: true } }))).toBeUndefined()
	})

	it("rejects a model that is not in the provider's allowed models", () => {
		const error = validateApiConfiguration(base, allowList({ openai: { allowAll: false, models: ["other"] } }))
		expect(error).toBe("settings:validation.modelNotAllowed")
	})

	it("accepts a model that is in the provider's allowed models", () => {
		const list = allowList({ openai: { allowAll: false, models: ["my-model"] } })
		expect(validateApiConfiguration(base, list)).toBeUndefined()
	})

	it("treats a provider entry with no models list as allowing no model", () => {
		// `models` is optional; a restricted provider without it must not fall through to "allowed".
		const error = validateApiConfiguration(base, allowList({ openai: { allowAll: false } }))
		expect(error).toBe("settings:validation.modelNotAllowed")
	})

	it("skips the allow list entirely when the configuration has no provider", () => {
		// No provider means nothing to look up; the earlier key/model validation already ran.
		const config = { openAiBaseUrl: "http://x/v1", openAiModelId: "my-model" } as ProviderSettings
		expect(validateApiConfiguration(config, allowList({}))).toBeUndefined()
	})

	it("reports missing keys before consulting the allow list", () => {
		// A config that is both incomplete and disallowed must surface the local error first.
		const error = validateApiConfiguration({ apiProvider: "openai" }, allowList({}))
		expect(error).toBe("settings:validation.openAi")
	})
})

describe("validate — splitting model errors from provider errors", () => {
	const base: ProviderSettings = {
		apiProvider: "openai",
		openAiBaseUrl: "http://localhost:8000/v1",
		openAiModelId: "my-model",
	}

	const restricted: OrganizationAllowList = {
		allowAll: false,
		providers: { openai: { allowAll: false, models: ["allowed-model"] } },
	}

	const providerBlocked: OrganizationAllowList = { allowAll: false, providers: {} }

	it("getModelValidationError surfaces model errors only", () => {
		expect(getModelValidationError(base, restricted)).toBe("settings:validation.modelNotAllowed")
		expect(getModelValidationError(base, providerBlocked)).toBeUndefined()
	})

	it("validateApiConfigurationExcludingModelErrors surfaces provider errors only", () => {
		expect(validateApiConfigurationExcludingModelErrors(base, providerBlocked)).toBe(
			"settings:validation.providerNotAllowed",
		)
		expect(validateApiConfigurationExcludingModelErrors(base, restricted)).toBeUndefined()
	})

	it("the two views never report the same error twice", () => {
		// The settings UI renders both; a message must belong to exactly one of them.
		for (const list of [restricted, providerBlocked]) {
			const general = validateApiConfigurationExcludingModelErrors(base, list)
			const model = getModelValidationError(base, list)
			expect([general, model].filter(Boolean)).toHaveLength(1)
		}
	})

	it("validateApiConfigurationExcludingModelErrors still reports missing keys", () => {
		expect(validateApiConfigurationExcludingModelErrors({ apiProvider: "openai" })).toBe(
			"settings:validation.openAi",
		)
	})

	it("getModelValidationError falls back to apiModelId when the provider name is unknown", () => {
		const config = { apiProvider: "not-a-provider", apiModelId: "my-model" } as unknown as ProviderSettings
		const list: OrganizationAllowList = {
			allowAll: false,
			providers: { "not-a-provider": { allowAll: false, models: ["allowed-model"] } },
		}
		expect(getModelValidationError(config, list)).toBe("settings:validation.modelNotAllowed")
	})

	it("getModelValidationError uses apiModelId when the OpenAI model id is unset", () => {
		const config: ProviderSettings = { apiProvider: "openai", apiModelId: "legacy-model" }
		expect(getModelValidationError(config, restricted)).toBe("settings:validation.modelNotAllowed")
	})

	it("reports no model error when the configuration carries no model id at all", () => {
		const config = { apiProvider: "openai" } as ProviderSettings
		expect(getModelValidationError(config, restricted)).toBeUndefined()
	})
})
