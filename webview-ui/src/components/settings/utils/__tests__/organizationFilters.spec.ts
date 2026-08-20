import { describe, it, expect } from "vitest"
import type { ModelInfo, OrganizationAllowList } from "@openai-agent/types"

import { filterProviders, filterModels } from "../organizationFilters"

const providers = [
	{ value: "openai", label: "OpenAI" },
	{ value: "anthropic", label: "Anthropic" },
	{ value: "gemini", label: "Gemini" },
]

const model = (): ModelInfo => ({ contextWindow: 1000, supportsPromptCache: false }) as unknown as ModelInfo

describe("filterProviders", () => {
	it("returns all providers when the allow list is undefined", () => {
		expect(filterProviders(providers, undefined)).toBe(providers)
	})

	it("returns all providers when allowAll is true", () => {
		const allow = { allowAll: true, providers: {} } as OrganizationAllowList
		expect(filterProviders(providers, allow)).toBe(providers)
	})

	it("drops providers absent from the allow list", () => {
		const allow = {
			allowAll: false,
			providers: { openai: { allowAll: true } },
		} as unknown as OrganizationAllowList
		expect(filterProviders(providers, allow)).toEqual([{ value: "openai", label: "OpenAI" }])
	})

	it("keeps a provider that lists specific models", () => {
		const allow = {
			allowAll: false,
			providers: {
				openai: { allowAll: false, models: ["gpt-4"] },
				anthropic: { allowAll: false, models: [] },
			},
		} as unknown as OrganizationAllowList
		expect(filterProviders(providers, allow)).toEqual([{ value: "openai", label: "OpenAI" }])
	})
})

describe("filterModels", () => {
	const models: Record<string, ModelInfo> = { "gpt-4": model(), "gpt-3": model() }

	it("returns models unchanged when models is null", () => {
		expect(filterModels(null, "openai" as any, undefined)).toBeNull()
	})

	it("returns models unchanged when the allow list is undefined", () => {
		expect(filterModels(models, "openai" as any, undefined)).toBe(models)
	})

	it("returns models unchanged when allowAll is true", () => {
		const allow = { allowAll: true, providers: {} } as OrganizationAllowList
		expect(filterModels(models, "openai" as any, allow)).toBe(models)
	})

	it("returns empty object when no providerId is given", () => {
		const allow = { allowAll: false, providers: {} } as unknown as OrganizationAllowList
		expect(filterModels(models, undefined, allow)).toEqual({})
	})

	it("returns empty object when the provider is not in the allow list", () => {
		const allow = { allowAll: false, providers: {} } as unknown as OrganizationAllowList
		expect(filterModels(models, "openai" as any, allow)).toEqual({})
	})

	it("returns all models when the provider allowAll is true", () => {
		const allow = {
			allowAll: false,
			providers: { openai: { allowAll: true } },
		} as unknown as OrganizationAllowList
		expect(filterModels(models, "openai" as any, allow)).toBe(models)
	})

	it("returns only the allowed models that exist (default [] when models missing)", () => {
		const allow = {
			allowAll: false,
			providers: { openai: { allowAll: false, models: ["gpt-4", "missing"] } },
		} as unknown as OrganizationAllowList
		expect(Object.keys(filterModels(models, "openai" as any, allow) ?? {})).toEqual(["gpt-4"])
	})

	it("uses empty allowed list when models field is absent", () => {
		const allow = {
			allowAll: false,
			providers: { openai: { allowAll: false } },
		} as unknown as OrganizationAllowList
		expect(filterModels(models, "openai" as any, allow)).toEqual({})
	})
})
