// npx vitest run src/shared/__tests__/checkExistApiConfig.spec.ts

import type { ProviderSettings } from "@openai-agent/types"

import { checkExistKey } from "../checkExistApiConfig"

describe("checkExistKey", () => {
	it("should return false for undefined config", () => {
		expect(checkExistKey(undefined)).toBe(false)
	})

	it("should return false for empty config", () => {
		const config: ProviderSettings = {}
		expect(checkExistKey(config)).toBe(false)
	})

	it("should return true when one key is defined", () => {
		const config: ProviderSettings = {
			openAiApiKey: "test-key",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return true when multiple keys are defined", () => {
		const config: ProviderSettings = {
			openAiApiKey: "test-key",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return true when only non-key fields are undefined", () => {
		const config: ProviderSettings = {
			openAiApiKey: "test-key",
			apiProvider: undefined,
			modelTemperature: undefined,
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return false when all key fields are undefined", () => {
		const config: ProviderSettings = {
			openAiApiKey: undefined,
		}
		expect(checkExistKey(config)).toBe(false)
	})

	it("should return true for fake-ai provider without API key", () => {
		const config: ProviderSettings = {
			apiProvider: "fake-ai",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return false for openai provider without base URL, model id, or API key", () => {
		const config: ProviderSettings = {
			apiProvider: "openai",
		}
		expect(checkExistKey(config)).toBe(false)
	})

	it("should return true for openai provider with a base URL configured", () => {
		const config: ProviderSettings = {
			apiProvider: "openai",
			openAiBaseUrl: "https://vllm.internal/v1",
		}
		expect(checkExistKey(config)).toBe(true)
	})
})
