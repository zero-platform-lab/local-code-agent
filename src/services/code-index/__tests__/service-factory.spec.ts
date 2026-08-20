// npx vitest run src/services/code-index/__tests__/service-factory.spec.ts
//
// CodeIndexServiceFactory は「設定 → 外部サービスのクライアント」を組み立てる唯一の場所。
// ここが緩いと、設定が欠けたまま埋め込み API や Qdrant のクライアントが作られ、
// ユーザーに何も確認しないままインデックス処理が外部へ出ていく。
// そのため以下を不変条件として固定する。
//
//   1. 【設定が欠けている / 不正なら作らない】
//      - baseUrl / apiKey が欠けていれば埋め込みクライアントを **一度も生成しない**。
//      - ベクトル次元が決められない、または qdrantUrl が無ければ Qdrant クライアントを生成しない。
//      - isFeatureConfigured が false なら createServices は何も生成せずに throw する。
//   2. 【設定はそのまま渡す】生成に至った場合、URL / API キー / 次元は設定の値がそのまま渡る
//      （既定値にすり替わって別のエンドポイントを叩かない）。
//
// 外部クライアント（OpenAICompatibleEmbedder / QdrantVectorStore）と重い processors は
// モジュールごとモックする。ネットワークは一切張らない。

import type * as vscode from "vscode"
import type { Ignore } from "ignore"

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: number) => defaultValue),
		})),
	},
}))

vi.mock("../embedders/openai-compatible", () => ({
	OpenAICompatibleEmbedder: vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
		this.kind = "embedder"
		this.args = args
	}),
}))

vi.mock("../vector-store/qdrant-client", () => ({
	QdrantVectorStore: vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
		this.kind = "vectorStore"
		this.args = args
	}),
}))

vi.mock("../processors", () => ({
	codeParser: { kind: "parser" },
	DirectoryScanner: vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
		this.kind = "scanner"
		this.args = args
	}),
	FileWatcher: vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
		this.kind = "fileWatcher"
		this.args = args
	}),
}))

// getModelDimension は「プロフィールに 0 が登録されている」異常系を作るためだけに
// 差し替え可能にする。既定では本物を使う。
vi.mock("../../../shared/embeddingModels", async () => {
	const actual = await vi.importActual<typeof import("../../../shared/embeddingModels")>(
		"../../../shared/embeddingModels",
	)
	return { ...actual, getModelDimension: vi.fn(actual.getModelDimension) }
})

import * as vscodeMock from "vscode"

import { getModelDimension } from "../../../shared/embeddingModels"
import { OpenAICompatibleEmbedder } from "../embedders/openai-compatible"
import { QdrantVectorStore } from "../vector-store/qdrant-client"
import { codeParser, DirectoryScanner, FileWatcher } from "../processors"
import { BATCH_SEGMENT_THRESHOLD } from "../constants"
import type { CodeIndexConfig } from "../interfaces/config"
import type { IEmbedder } from "../interfaces"
import type { CacheManager } from "../cache-manager"
import type { CodeIndexConfigManager } from "../config-manager"
import { CodeIndexServiceFactory } from "../service-factory"

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

const WORKSPACE = "/workspace/project"

const baseConfig = (overrides: Partial<CodeIndexConfig> = {}): CodeIndexConfig => ({
	isConfigured: true,
	embedderProvider: "openai-compatible",
	modelId: "text-embedding-3-small",
	openAiCompatibleOptions: { baseUrl: "https://embed.example/v1", apiKey: "secret-key" },
	qdrantUrl: "http://localhost:6333",
	qdrantApiKey: "qdrant-key",
	...overrides,
})

interface SetupOptions {
	config?: Partial<CodeIndexConfig>
	isFeatureConfigured?: boolean
}

function setup(options: SetupOptions = {}) {
	const config = baseConfig(options.config)
	const getConfig = vi.fn(() => config)
	const configManager = {
		getConfig,
		isFeatureConfigured: options.isFeatureConfigured ?? true,
	} as unknown as CodeIndexConfigManager

	const cacheManager = { kind: "cacheManager" } as unknown as CacheManager

	return {
		factory: new CodeIndexServiceFactory(configManager, WORKSPACE, cacheManager),
		config,
		getConfig,
		cacheManager,
	}
}

const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext
const fakeIgnore = { ignores: () => false } as unknown as Ignore

/** 「外部クライアントを 1 つも作っていない」ことの共通検査（不変条件 1）。 */
function expectNoClientsCreated(): void {
	expect(OpenAICompatibleEmbedder).not.toHaveBeenCalled()
	expect(QdrantVectorStore).not.toHaveBeenCalled()
}

let consoleWarnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.clearAllMocks()
	// getModelDimension は一部のテストで戻り値を差し替えるので毎回本物へ戻す。
	vi.mocked(getModelDimension).mockReset()
	vi.mocked(vscodeMock.workspace.getConfiguration).mockReturnValue({
		get: vi.fn((_key: string, defaultValue: number) => defaultValue),
	} as never)
	consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
	consoleWarnSpy.mockRestore()
})

// ---------------------------------------------------------------------------

describe("CodeIndexServiceFactory", () => {
	describe("createEmbedder（不変条件1: 認証情報が欠けたら作らない）", () => {
		it.each([
			{ name: "openAiCompatibleOptions ごと欠落", options: undefined },
			{ name: "baseUrl が空文字", options: { baseUrl: "", apiKey: "k" } },
			{ name: "apiKey が空文字", options: { baseUrl: "https://embed.example", apiKey: "" } },
		])("【不変条件】$name なら埋め込みクライアントを生成せず throw する", async ({ options }) => {
			const h = setup({ config: { openAiCompatibleOptions: options as never } })

			expect(() => h.factory.createEmbedder()).toThrow("embeddings:serviceFactory.openAiCompatibleConfigMissing")
			expectNoClientsCreated()
		})

		it("baseUrl / apiKey / modelId をそのまま渡して生成する", async () => {
			const h = setup()

			const embedder = h.factory.createEmbedder()

			expect(OpenAICompatibleEmbedder).toHaveBeenCalledExactlyOnceWith(
				"https://embed.example/v1",
				"secret-key",
				"text-embedding-3-small",
			)
			expect(embedder).toBeInstanceOf(OpenAICompatibleEmbedder)
		})

		it("modelId が未設定でも生成できる（既定モデルは埋め込み側の責務）", async () => {
			const h = setup({ config: { modelId: undefined } })

			h.factory.createEmbedder()

			expect(OpenAICompatibleEmbedder).toHaveBeenCalledExactlyOnceWith(
				"https://embed.example/v1",
				"secret-key",
				undefined,
			)
		})
	})

	describe("validateEmbedder", () => {
		it("埋め込み側の検証結果をそのまま返す", async () => {
			const h = setup()
			const embedder = { validateConfiguration: vi.fn(async () => ({ valid: true })) } as unknown as IEmbedder

			await expect(h.factory.validateEmbedder(embedder)).resolves.toEqual({ valid: true })
		})

		it("valid:false もそのまま返す", async () => {
			const h = setup()
			const embedder = {
				validateConfiguration: vi.fn(async () => ({ valid: false, error: "unauthorized" })),
			} as unknown as IEmbedder

			await expect(h.factory.validateEmbedder(embedder)).resolves.toEqual({ valid: false, error: "unauthorized" })
		})

		it("検証が Error を投げたら元のメッセージを保って valid:false にする", async () => {
			const h = setup()
			const embedder = {
				validateConfiguration: vi.fn(async () => {
					throw new Error("ECONNREFUSED")
				}),
			} as unknown as IEmbedder

			await expect(h.factory.validateEmbedder(embedder)).resolves.toEqual({
				valid: false,
				error: "ECONNREFUSED",
			})
		})

		it("Error 以外が投げられたら既定のエラーキーにフォールバックする", async () => {
			const h = setup()
			const embedder = {
				validateConfiguration: vi.fn(async () => {
					throw "not-an-error"
				}),
			} as unknown as IEmbedder

			await expect(h.factory.validateEmbedder(embedder)).resolves.toEqual({
				valid: false,
				error: "embeddings:validation.configurationError",
			})
		})
	})

	describe("createVectorStore（不変条件1: 次元／URL が決まらなければ作らない）", () => {
		it("既知モデルのプロフィール次元を使って生成する", async () => {
			const h = setup()

			const store = h.factory.createVectorStore()

			expect(QdrantVectorStore).toHaveBeenCalledExactlyOnceWith(
				WORKSPACE,
				"http://localhost:6333",
				1536,
				"qdrant-key",
			)
			expect(store).toBeInstanceOf(QdrantVectorStore)
		})

		it("modelId 未設定なら既定モデル（text-embedding-3-small）の次元になる", async () => {
			const h = setup({ config: { modelId: undefined } })

			h.factory.createVectorStore()

			expect(QdrantVectorStore).toHaveBeenCalledExactlyOnceWith(
				WORKSPACE,
				"http://localhost:6333",
				1536,
				"qdrant-key",
			)
		})

		it("プロフィールに無いモデルでは手動指定の次元を使う", async () => {
			const h = setup({ config: { modelId: "my-custom-model", modelDimension: 768 } })

			h.factory.createVectorStore()

			expect(QdrantVectorStore).toHaveBeenCalledExactlyOnceWith(
				WORKSPACE,
				"http://localhost:6333",
				768,
				"qdrant-key",
			)
		})

		it("プロフィールに次元があるモデルでは手動指定より優先される", async () => {
			const h = setup({ config: { modelId: "text-embedding-3-large", modelDimension: 99 } })

			h.factory.createVectorStore()

			expect(QdrantVectorStore).toHaveBeenCalledExactlyOnceWith(
				WORKSPACE,
				"http://localhost:6333",
				3072,
				"qdrant-key",
			)
		})

		it.each([
			{ name: "手動次元も未設定", modelDimension: undefined },
			{ name: "手動次元が 0", modelDimension: 0 },
			{ name: "手動次元が負値", modelDimension: -1 },
		])("【不変条件】未知モデルで $name なら Qdrant クライアントを作らず throw する", async ({ modelDimension }) => {
			const h = setup({ config: { modelId: "my-custom-model", modelDimension } })

			expect(() => h.factory.createVectorStore()).toThrow(
				"embeddings:serviceFactory.vectorDimensionNotDeterminedOpenAiCompatible",
			)
			expect(QdrantVectorStore).not.toHaveBeenCalled()
		})

		it("【不変条件】プロフィールの次元が 0 でも throw する（0 を次元として採用しない）", async () => {
			// 実運用のプロフィールには 0 は無いが、壊れたプロフィールでも
			// 次元 0 のコレクションを作りにいかないことを固定する。
			vi.mocked(getModelDimension).mockReturnValueOnce(0)
			const h = setup({ config: { modelId: "broken-model" } })

			expect(() => h.factory.createVectorStore()).toThrow(
				"embeddings:serviceFactory.vectorDimensionNotDeterminedOpenAiCompatible",
			)
			expect(QdrantVectorStore).not.toHaveBeenCalled()
		})

		it("openai-compatible 以外のプロバイダでは汎用のエラーメッセージになる", async () => {
			const h = setup({
				config: { embedderProvider: "some-other-provider" as never, modelId: "x", modelDimension: undefined },
			})

			expect(() => h.factory.createVectorStore()).toThrow(
				"embeddings:serviceFactory.vectorDimensionNotDetermined",
			)
			expect(QdrantVectorStore).not.toHaveBeenCalled()
			expect(consoleWarnSpy).toHaveBeenCalledWith("Provider not found in profiles: some-other-provider")
		})

		it.each([
			{ name: "qdrantUrl が undefined", qdrantUrl: undefined },
			{ name: "qdrantUrl が空文字", qdrantUrl: "" },
		])("【不変条件】$name なら Qdrant クライアントを作らず throw する", async ({ qdrantUrl }) => {
			const h = setup({ config: { qdrantUrl } })

			expect(() => h.factory.createVectorStore()).toThrow("embeddings:serviceFactory.qdrantUrlMissing")
			expect(QdrantVectorStore).not.toHaveBeenCalled()
		})

		it("qdrantApiKey が無くても URL があれば生成する（認証なし Qdrant 構成）", async () => {
			const h = setup({ config: { qdrantApiKey: undefined } })

			h.factory.createVectorStore()

			expect(QdrantVectorStore).toHaveBeenCalledExactlyOnceWith(
				WORKSPACE,
				"http://localhost:6333",
				1536,
				undefined,
			)
		})
	})

	describe("createDirectoryScanner", () => {
		it("VS Code 設定のバッチサイズを使って組み立てる", async () => {
			const h = setup()
			const get = vi.fn((_key: string, _defaultValue: number) => 7)
			vi.mocked(vscodeMock.workspace.getConfiguration).mockReturnValue({ get } as never)
			const embedder = {} as IEmbedder
			const vectorStore = {} as never

			const scanner = h.factory.createDirectoryScanner(embedder, vectorStore, codeParser, fakeIgnore)

			expect(get).toHaveBeenCalledWith("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
			expect(DirectoryScanner).toHaveBeenCalledExactlyOnceWith(
				embedder,
				vectorStore,
				codeParser,
				h.cacheManager,
				fakeIgnore,
				7,
			)
			expect(scanner).toBeInstanceOf(DirectoryScanner)
		})

		it("VS Code 設定が読めない環境では既定バッチサイズにフォールバックする", async () => {
			const h = setup()
			vi.mocked(vscodeMock.workspace.getConfiguration).mockImplementation(() => {
				throw new Error("no workspace")
			})

			h.factory.createDirectoryScanner({} as IEmbedder, {} as never, codeParser, fakeIgnore)

			expect(vi.mocked(DirectoryScanner).mock.calls[0][5]).toBe(BATCH_SEGMENT_THRESHOLD)
		})
	})

	describe("createFileWatcher", () => {
		it("依存とバッチサイズを順序どおりに渡して組み立てる", async () => {
			const h = setup()
			const get = vi.fn((_key: string, _defaultValue: number) => 11)
			vi.mocked(vscodeMock.workspace.getConfiguration).mockReturnValue({ get } as never)
			const embedder = {} as IEmbedder
			const vectorStore = {} as never
			const ignoreController = { kind: "agentIgnore" } as never

			const watcher = h.factory.createFileWatcher(
				fakeContext,
				embedder,
				vectorStore,
				h.cacheManager,
				fakeIgnore,
				ignoreController,
			)

			expect(FileWatcher).toHaveBeenCalledExactlyOnceWith(
				WORKSPACE,
				fakeContext,
				h.cacheManager,
				embedder,
				vectorStore,
				fakeIgnore,
				ignoreController,
				11,
			)
			expect(watcher).toBeInstanceOf(FileWatcher)
		})

		it("AgentIgnoreController 省略時は undefined が渡る", async () => {
			const h = setup()

			h.factory.createFileWatcher(fakeContext, {} as IEmbedder, {} as never, h.cacheManager, fakeIgnore)

			expect(vi.mocked(FileWatcher).mock.calls[0][6]).toBeUndefined()
		})

		it("VS Code 設定が読めない環境では既定バッチサイズにフォールバックする", async () => {
			const h = setup()
			vi.mocked(vscodeMock.workspace.getConfiguration).mockImplementation(() => {
				throw new Error("no workspace")
			})

			h.factory.createFileWatcher(fakeContext, {} as IEmbedder, {} as never, h.cacheManager, fakeIgnore)

			expect(vi.mocked(FileWatcher).mock.calls[0][7]).toBe(BATCH_SEGMENT_THRESHOLD)
		})
	})

	describe("createServices（不変条件1: 未設定なら何も作らない）", () => {
		it("【不変条件】isFeatureConfigured が false なら外部クライアントを 1 つも作らずに throw する", async () => {
			const h = setup({ isFeatureConfigured: false })

			expect(() => h.factory.createServices(fakeContext, h.cacheManager, fakeIgnore)).toThrow(
				"embeddings:serviceFactory.codeIndexingNotConfigured",
			)
			expectNoClientsCreated()
			expect(DirectoryScanner).not.toHaveBeenCalled()
			expect(FileWatcher).not.toHaveBeenCalled()
			// 設定の読み出しすら行わない。
			expect(h.getConfig).not.toHaveBeenCalled()
		})

		it("【不変条件】qdrantUrl が欠けていればスキャナ／ウォッチャまで到達しない", async () => {
			const h = setup({ config: { qdrantUrl: undefined } })

			expect(() => h.factory.createServices(fakeContext, h.cacheManager, fakeIgnore)).toThrow(
				"embeddings:serviceFactory.qdrantUrlMissing",
			)
			expect(QdrantVectorStore).not.toHaveBeenCalled()
			expect(DirectoryScanner).not.toHaveBeenCalled()
			expect(FileWatcher).not.toHaveBeenCalled()
		})

		it("設定が揃っていれば 5 つの依存を組み立てて返す", async () => {
			const h = setup()
			const ignoreController = { kind: "agentIgnore" } as never

			const services = h.factory.createServices(fakeContext, h.cacheManager, fakeIgnore, ignoreController)

			expect(services.embedder).toBeInstanceOf(OpenAICompatibleEmbedder)
			expect(services.vectorStore).toBeInstanceOf(QdrantVectorStore)
			expect(services.parser).toBe(codeParser)
			expect(services.scanner).toBeInstanceOf(DirectoryScanner)
			expect(services.fileWatcher).toBeInstanceOf(FileWatcher)

			// スキャナ／ウォッチャには同じ埋め込み・ベクトルストアのインスタンスが渡る
			// （別インスタンスを作って別エンドポイントを叩かない）。
			expect(vi.mocked(DirectoryScanner).mock.calls[0][0]).toBe(services.embedder)
			expect(vi.mocked(DirectoryScanner).mock.calls[0][1]).toBe(services.vectorStore)
			expect(vi.mocked(FileWatcher).mock.calls[0][3]).toBe(services.embedder)
			expect(vi.mocked(FileWatcher).mock.calls[0][4]).toBe(services.vectorStore)
			expect(vi.mocked(FileWatcher).mock.calls[0][6]).toBe(ignoreController)
		})

		it("AgentIgnoreController 省略時も組み立てられる", async () => {
			const h = setup()

			const services = h.factory.createServices(fakeContext, h.cacheManager, fakeIgnore)

			expect(services.fileWatcher).toBeInstanceOf(FileWatcher)
			expect(vi.mocked(FileWatcher).mock.calls[0][6]).toBeUndefined()
		})
	})
})
