// npx vitest run shared/__tests__/embeddingModels.spec.ts

import {
	EMBEDDING_MODEL_PROFILES,
	getModelDimension,
	getModelScoreThreshold,
	getModelQueryPrefix,
	getDefaultModelId,
} from "../embeddingModels"

describe("embeddingModels", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("getModelDimension", () => {
		it("既知モデルの次元を返す", () => {
			expect(getModelDimension("openai-compatible", "text-embedding-3-small")).toBe(1536)
			expect(getModelDimension("openai-compatible", "text-embedding-3-large")).toBe(3072)
		})

		it("未知プロバイダは undefined を返し警告する", () => {
			expect(getModelDimension("bogus-provider" as never, "text-embedding-3-small")).toBeUndefined()
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Provider not found"))
		})

		it("既知プロバイダの未知モデルは undefined（警告なし）", () => {
			expect(getModelDimension("openai-compatible", "no-such-model")).toBeUndefined()
			expect(console.warn).not.toHaveBeenCalled()
		})
	})

	describe("getModelScoreThreshold", () => {
		it("既知モデルの閾値を返す", () => {
			expect(getModelScoreThreshold("openai-compatible", "text-embedding-3-small")).toBe(0.4)
			expect(getModelScoreThreshold("openai-compatible", "nomic-embed-code")).toBe(0.15)
		})

		it("未知プロバイダは undefined", () => {
			expect(getModelScoreThreshold("bogus-provider" as never, "x")).toBeUndefined()
		})

		it("既知プロバイダの未知モデルは undefined", () => {
			expect(getModelScoreThreshold("openai-compatible", "no-such-model")).toBeUndefined()
		})
	})

	describe("getModelQueryPrefix", () => {
		it("queryPrefix を持つモデルはその値を返す", () => {
			expect(getModelQueryPrefix("openai-compatible", "nomic-embed-code")).toBe(
				"Represent this query for searching relevant code: ",
			)
		})

		it("queryPrefix を持たないモデルは undefined", () => {
			expect(getModelQueryPrefix("openai-compatible", "text-embedding-3-small")).toBeUndefined()
		})

		it("未知プロバイダは undefined", () => {
			expect(getModelQueryPrefix("bogus-provider" as never, "x")).toBeUndefined()
		})
	})

	describe("getDefaultModelId", () => {
		it("常に text-embedding-3-small を返す", () => {
			expect(getDefaultModelId("openai-compatible")).toBe("text-embedding-3-small")
		})
	})

	it("プロファイル定数が公開されている", () => {
		expect(EMBEDDING_MODEL_PROFILES["openai-compatible"]).toBeDefined()
	})
})
