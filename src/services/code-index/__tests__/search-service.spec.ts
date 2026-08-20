import * as path from "path"

import { CodeIndexSearchService } from "../search-service"
import type { IEmbedder } from "../interfaces/embedder"
import type { IVectorStore } from "../interfaces/vector-store"
import type { CodeIndexConfigManager } from "../config-manager"
import type { CodeIndexStateManager } from "../state-manager"

// 外部（埋め込み API / ベクタ DB）は必ずモックし、実接続が起きないことを不変条件として検証する。

type ConfigOverrides = Partial<{
	isFeatureEnabled: boolean
	isFeatureConfigured: boolean
	currentSearchMinScore: number
	currentSearchMaxResults: number
}>

function makeConfigManager(overrides: ConfigOverrides = {}): CodeIndexConfigManager {
	return {
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		currentSearchMinScore: 0.4,
		currentSearchMaxResults: 10,
		...overrides,
	} as unknown as CodeIndexConfigManager
}

function makeStateManager(systemStatus: string) {
	const setSystemState = vitest.fn()
	const stateManager = {
		getCurrentStatus: vitest.fn(() => ({ systemStatus, fileStatuses: {} })),
		setSystemState,
	} as unknown as CodeIndexStateManager
	return { stateManager, setSystemState }
}

function makeEmbedder(impl: IEmbedder["createEmbeddings"]) {
	const createEmbeddings = vitest.fn(impl)
	return { embedder: { createEmbeddings } as unknown as IEmbedder, createEmbeddings }
}

function makeVectorStore(impl?: IVectorStore["search"]) {
	const search = vitest.fn(impl ?? (async () => []))
	return { vectorStore: { search } as unknown as IVectorStore, search }
}

describe("CodeIndexSearchService", () => {
	let consoleErrorSpy: ReturnType<typeof vitest.spyOn>

	beforeEach(() => {
		// catch 節で console.error が呼ばれるためテスト出力を汚さないよう抑制する
		consoleErrorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		consoleErrorSpy.mockRestore()
		vitest.clearAllMocks()
	})

	describe("設定不備・準備不足では外部接続しない（不変条件）", () => {
		it("機能が無効なら例外を投げ、埋め込み/検索を呼ばない", async () => {
			const config = makeConfigManager({ isFeatureEnabled: false })
			const { stateManager } = makeStateManager("Indexed")
			const { embedder, createEmbeddings } = makeEmbedder(async () => ({ embeddings: [[1]] }))
			const { vectorStore, search } = makeVectorStore()
			const service = new CodeIndexSearchService(config, stateManager, embedder, vectorStore)

			await expect(service.searchIndex("q")).rejects.toThrow("Code index feature is disabled or not configured.")
			expect(createEmbeddings).not.toHaveBeenCalled()
			expect(search).not.toHaveBeenCalled()
		})

		it("機能が未設定なら例外を投げ、埋め込み/検索を呼ばない", async () => {
			const config = makeConfigManager({ isFeatureConfigured: false })
			const { stateManager } = makeStateManager("Indexed")
			const { embedder, createEmbeddings } = makeEmbedder(async () => ({ embeddings: [[1]] }))
			const { vectorStore, search } = makeVectorStore()
			const service = new CodeIndexSearchService(config, stateManager, embedder, vectorStore)

			await expect(service.searchIndex("q")).rejects.toThrow("Code index feature is disabled or not configured.")
			expect(createEmbeddings).not.toHaveBeenCalled()
			expect(search).not.toHaveBeenCalled()
		})

		it("状態が Indexed/Indexing 以外なら例外を投げ、埋め込み/検索を呼ばない", async () => {
			const config = makeConfigManager()
			const { stateManager } = makeStateManager("Standby")
			const { embedder, createEmbeddings } = makeEmbedder(async () => ({ embeddings: [[1]] }))
			const { vectorStore, search } = makeVectorStore()
			const service = new CodeIndexSearchService(config, stateManager, embedder, vectorStore)

			await expect(service.searchIndex("q")).rejects.toThrow(
				"Code index is not ready for search. Current state: Standby",
			)
			expect(createEmbeddings).not.toHaveBeenCalled()
			expect(search).not.toHaveBeenCalled()
		})
	})

	describe("正常系", () => {
		it("Indexed 状態・prefix 無しで検索し、search に undefined prefix を渡す", async () => {
			const config = makeConfigManager({ currentSearchMinScore: 0.5, currentSearchMaxResults: 7 })
			const { stateManager } = makeStateManager("Indexed")
			const { embedder, createEmbeddings } = makeEmbedder(async () => ({ embeddings: [[0.1, 0.2]] }))
			const expected = [{ id: "1", score: 0.9 }]
			const { vectorStore, search } = makeVectorStore(async () => expected as any)
			const service = new CodeIndexSearchService(config, stateManager, embedder, vectorStore)

			const results = await service.searchIndex("hello")

			expect(createEmbeddings).toHaveBeenCalledWith(["hello"])
			expect(search).toHaveBeenCalledWith([0.1, 0.2], undefined, 0.5, 7)
			expect(results).toBe(expected)
		})

		it("Indexing 状態でも検索でき、directoryPrefix を正規化して渡す", async () => {
			const config = makeConfigManager()
			const { stateManager } = makeStateManager("Indexing")
			const { embedder } = makeEmbedder(async () => ({ embeddings: [[1, 2, 3]] }))
			const { vectorStore, search } = makeVectorStore()
			const service = new CodeIndexSearchService(config, stateManager, embedder, vectorStore)

			await service.searchIndex("q", "foo/../bar/")

			expect(search).toHaveBeenCalledWith([1, 2, 3], path.normalize("foo/../bar/"), 0.4, 10)
		})
	})

	describe("埋め込み生成失敗", () => {
		it("embeddings が空なら例外を投げ、エラー状態を設定し search を呼ばない", async () => {
			const config = makeConfigManager()
			const { stateManager, setSystemState } = makeStateManager("Indexed")
			const { embedder } = makeEmbedder(async () => ({ embeddings: [] }))
			const { vectorStore, search } = makeVectorStore()
			const service = new CodeIndexSearchService(config, stateManager, embedder, vectorStore)

			await expect(service.searchIndex("q")).rejects.toThrow("Failed to generate embedding for query.")
			expect(search).not.toHaveBeenCalled()
			expect(setSystemState).toHaveBeenCalledWith("Error", expect.stringContaining("Search failed:"))
		})

		it("埋め込みレスポンスが undefined でも安全に例外へ倒れる（optional chaining）", async () => {
			const config = makeConfigManager()
			const { stateManager, setSystemState } = makeStateManager("Indexed")
			const { embedder } = makeEmbedder(async () => undefined as any)
			const { vectorStore, search } = makeVectorStore()
			const service = new CodeIndexSearchService(config, stateManager, embedder, vectorStore)

			await expect(service.searchIndex("q")).rejects.toThrow("Failed to generate embedding for query.")
			expect(search).not.toHaveBeenCalled()
			expect(setSystemState).toHaveBeenCalledWith("Error", expect.stringContaining("Search failed:"))
		})
	})

	describe("検索中の例外処理", () => {
		it("embedder が例外を投げたらエラー状態を設定して再スローする", async () => {
			const config = makeConfigManager()
			const { stateManager, setSystemState } = makeStateManager("Indexed")
			const boom = new Error("embed boom")
			const { embedder } = makeEmbedder(async () => {
				throw boom
			})
			const { vectorStore } = makeVectorStore()
			const service = new CodeIndexSearchService(config, stateManager, embedder, vectorStore)

			await expect(service.searchIndex("q")).rejects.toBe(boom)
			expect(setSystemState).toHaveBeenCalledWith("Error", "Search failed: embed boom")
		})

		it("vectorStore.search が例外を投げてもエラー状態を設定して再スローする", async () => {
			const config = makeConfigManager()
			const { stateManager, setSystemState } = makeStateManager("Indexed")
			const { embedder } = makeEmbedder(async () => ({ embeddings: [[1]] }))
			const boom = new Error("store boom")
			const { vectorStore } = makeVectorStore(async () => {
				throw boom
			})
			const service = new CodeIndexSearchService(config, stateManager, embedder, vectorStore)

			await expect(service.searchIndex("q")).rejects.toBe(boom)
			expect(setSystemState).toHaveBeenCalledWith("Error", "Search failed: store boom")
		})
	})
})
