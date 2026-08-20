// npx vitest run shared/__tests__/ProfileValidator.spec.ts

import type { ProviderSettings, OrganizationAllowList } from "@openai-agent/types"

import { ProfileValidator } from "../ProfileValidator"

const profile = (partial: Partial<ProviderSettings> = {}): ProviderSettings => partial as ProviderSettings

describe("ProfileValidator.isProfileAllowed", () => {
	it("allowAll なら無条件で許可", () => {
		const allowList: OrganizationAllowList = { allowAll: true, providers: {} }
		expect(ProfileValidator.isProfileAllowed(profile({ apiProvider: "openai" }), allowList)).toBe(true)
	})

	it("apiProvider が無ければ拒否", () => {
		const allowList: OrganizationAllowList = { allowAll: false, providers: { openai: { allowAll: true } } }
		expect(ProfileValidator.isProfileAllowed(profile({}), allowList)).toBe(false)
	})

	it("プロバイダが許可リストに無ければ拒否", () => {
		const allowList: OrganizationAllowList = { allowAll: false, providers: {} }
		expect(ProfileValidator.isProfileAllowed(profile({ apiProvider: "openai" }), allowList)).toBe(false)
	})

	it("modelId 不明でもプロバイダが allowAll なら許可", () => {
		const allowList: OrganizationAllowList = { allowAll: false, providers: { openai: { allowAll: true } } }
		// openAiModelId 未設定 → modelId undefined
		expect(ProfileValidator.isProfileAllowed(profile({ apiProvider: "openai" }), allowList)).toBe(true)
	})

	it("modelId 不明でプロバイダが allowAll でなければ拒否", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: { openai: { allowAll: false, models: ["gpt-4"] } },
		}
		expect(ProfileValidator.isProfileAllowed(profile({ apiProvider: "openai" }), allowList)).toBe(false)
	})

	it("fake-ai プロバイダは modelId が常に undefined として扱われる", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: { "fake-ai": { allowAll: true } },
		}
		expect(ProfileValidator.isProfileAllowed(profile({ apiProvider: "fake-ai" }), allowList)).toBe(true)
	})

	it("モデルが許可リストに含まれれば許可", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: { openai: { allowAll: false, models: ["gpt-4o"] } },
		}
		expect(
			ProfileValidator.isProfileAllowed(profile({ apiProvider: "openai", openAiModelId: "gpt-4o" }), allowList),
		).toBe(true)
	})

	it("モデルが許可リストに含まれなければ拒否", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: { openai: { allowAll: false, models: ["gpt-4o"] } },
		}
		expect(
			ProfileValidator.isProfileAllowed(profile({ apiProvider: "openai", openAiModelId: "o1" }), allowList),
		).toBe(false)
	})

	it("プロバイダキーは存在するが値が undefined なら拒否（防御分岐）", () => {
		// "openai" in providers は真だが providers.openai は undefined → isModelAllowed の !providerAllowList を踏む
		const allowList = {
			allowAll: false,
			providers: { openai: undefined },
		} as unknown as OrganizationAllowList
		expect(
			ProfileValidator.isProfileAllowed(profile({ apiProvider: "openai", openAiModelId: "gpt-4o" }), allowList),
		).toBe(false)
	})

	it("models 未定義のプロバイダ許可リストでは拒否（?? false）", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: { openai: { allowAll: false } },
		}
		expect(
			ProfileValidator.isProfileAllowed(profile({ apiProvider: "openai", openAiModelId: "gpt-4o" }), allowList),
		).toBe(false)
	})
})

// private static メソッドの allowAll 短絡は公開 API 経由では到達しない（isProfileAllowed が先に返す）ため、
// メソッドを直接呼んで防御分岐そのものを実行し網羅する。
describe("ProfileValidator private allowAll guards", () => {
	it("isProviderAllowed は allowAll で true", () => {
		const impl = ProfileValidator as unknown as {
			isProviderAllowed(name: string, list: OrganizationAllowList): boolean
		}
		expect(impl.isProviderAllowed("openai", { allowAll: true, providers: {} })).toBe(true)
	})

	it("isProviderAllowed は providers に含まれれば true", () => {
		const impl = ProfileValidator as unknown as {
			isProviderAllowed(name: string, list: OrganizationAllowList): boolean
		}
		expect(impl.isProviderAllowed("openai", { allowAll: false, providers: { openai: { allowAll: true } } })).toBe(
			true,
		)
	})

	it("isProviderAllowed は providers に含まれなければ false", () => {
		// isProfileAllowed 経由では後段の modelId 判定に隠れて観測できないため直接固定する
		const impl = ProfileValidator as unknown as {
			isProviderAllowed(name: string, list: OrganizationAllowList): boolean
		}
		expect(impl.isProviderAllowed("openai", { allowAll: false, providers: {} })).toBe(false)
	})

	it("isModelAllowed は allowAll で true", () => {
		const impl = ProfileValidator as unknown as {
			isModelAllowed(name: string, modelId: string, list: OrganizationAllowList): boolean
		}
		expect(impl.isModelAllowed("openai", "gpt-4o", { allowAll: true, providers: {} })).toBe(true)
	})

	it("isModelAllowed はプロバイダ allowAll で true", () => {
		const impl = ProfileValidator as unknown as {
			isModelAllowed(name: string, modelId: string, list: OrganizationAllowList): boolean
		}
		expect(
			impl.isModelAllowed("openai", "gpt-4o", {
				allowAll: false,
				providers: { openai: { allowAll: true } },
			}),
		).toBe(true)
	})
})
