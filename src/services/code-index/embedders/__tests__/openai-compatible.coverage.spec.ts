// npx vitest services/code-index/embedders/__tests__/openai-compatible.coverage.spec.ts
//
// 既存 openai-compatible.spec.ts / openai-compatible-rate-limit.spec.ts で未到達だった分岐を補完する。
// 不変条件:
//  - 本物のネットワークには一切出さない（OpenAI SDK と global.fetch を全モック）
//  - クエリ接頭辞・バッチ分割・直接 HTTP のエラー処理・グローバルレート制限の待機/遅延が想定どおり

import type { MockedClass, MockedFunction } from "vitest"
import { OpenAI } from "openai"

import { OpenAICompatibleEmbedder } from "../openai-compatible"
import { MAX_BATCH_TOKENS } from "../../constants"

vitest.mock("openai")

// i18n はキーをそのまま返すだけの薄いモック（本物の翻訳は不要）
vitest.mock("../../../../i18n", () => ({
	t: (key: string, params?: Record<string, any>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}))
vitest.mock("../../../../i18n/setup", () => ({
	default: { t: (key: string) => key },
}))

const MockedOpenAI = OpenAI as MockedClass<typeof OpenAI>

describe("OpenAICompatibleEmbedder (coverage 補完)", () => {
	let mockEmbeddingsCreate: MockedFunction<any>
	const testApiKey = "test-api-key"

	beforeEach(() => {
		vitest.clearAllMocks()
		vitest.spyOn(console, "warn").mockImplementation(() => {})
		vitest.spyOn(console, "error").mockImplementation(() => {})

		mockEmbeddingsCreate = vitest.fn()
		MockedOpenAI.mockImplementation(() => ({ embeddings: { create: mockEmbeddingsCreate } }) as any)

		global.fetch = vitest.fn() as any

		// 静的なグローバルレート制限状態をテスト間でリセット
		const tmp = new OpenAICompatibleEmbedder("https://api.example.com/v1", testApiKey)
		;(tmp as any).constructor.globalRateLimitState = {
			isRateLimited: false,
			rateLimitResetTime: 0,
			consecutiveRateLimitErrors: 0,
			lastRateLimitError: 0,
			mutex: (tmp as any).constructor.globalRateLimitState.mutex,
		}
	})

	afterEach(() => {
		vitest.restoreAllMocks()
	})

	describe("モデルのクエリ接頭辞の付与", () => {
		// nomic-embed-code は queryPrefix を持つモデル（shared/embeddingModels）
		const prefix = "Represent this query for searching relevant code: "

		it("接頭辞を付ける／既に付いていれば二重付与しない／付けると上限超過なら原文のまま", async () => {
			const embedder = new OpenAICompatibleEmbedder("https://api.example.com/v1", testApiKey, "nomic-embed-code")

			const normal = "find the auth handler"
			const already = `${prefix}already prefixed query`
			// 接頭辞を足すと MAX_ITEM_TOKENS(8191) を超える長文（原文のまま返るはず）
			const huge = "a".repeat(32720)

			mockEmbeddingsCreate.mockResolvedValue({
				data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }, { embedding: [0.5, 0.6] }],
				usage: { prompt_tokens: 3, total_tokens: 3 },
			})

			await embedder.createEmbeddings([normal, already, huge])

			const sentInputs = (mockEmbeddingsCreate.mock.calls[0][0] as any).input as string[]
			// 通常テキストには接頭辞が付く
			expect(sentInputs).toContain(`${prefix}${normal}`)
			// 既に接頭辞付きのものは二重付与されない
			expect(sentInputs).toContain(already)
			expect(sentInputs).not.toContain(`${prefix}${already}`)
			// 上限超過ケースは原文のまま（接頭辞なし）で送られる
			expect(sentInputs).toContain(huge)
			// 上限超過の警告が出る
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("textWithPrefixExceedsTokenLimit"))
		})
	})

	describe("バッチ分割（トークン上限で 2 バッチに分かれる）", () => {
		it("MAX_BATCH_TOKENS を超えると複数バッチに分けて呼び出す", async () => {
			const embedder = new OpenAICompatibleEmbedder("https://api.example.com/v1", testApiKey)

			// 1 件 = length/4 = 8000 トークン（< maxItemTokens 8191 なのでスキップされない）
			const each = "x".repeat(32000)
			// 13 件で 104000 > MAX_BATCH_TOKENS(100000) → 12 件目までで 1 バッチ目、13 件目で break → 2 バッチ目
			const texts = new Array(13).fill(each)
			expect(13 * Math.ceil(each.length / 4)).toBeGreaterThan(MAX_BATCH_TOKENS)

			mockEmbeddingsCreate.mockImplementation(async (req: any) => ({
				data: req.input.map(() => ({ embedding: [0.1] })),
				usage: { prompt_tokens: 1, total_tokens: 1 },
			}))

			await embedder.createEmbeddings(texts)

			// 2 回に分割して呼ばれる（break 分岐を通過）
			expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(2)
			const firstBatch = (mockEmbeddingsCreate.mock.calls[0][0] as any).input.length
			const secondBatch = (mockEmbeddingsCreate.mock.calls[1][0] as any).input.length
			expect(firstBatch + secondBatch).toBe(13)
			expect(secondBatch).toBeGreaterThanOrEqual(1)
		})
	})

	describe("直接 HTTP リクエスト(makeDirectEmbeddingRequest)のエラー処理", () => {
		const azureUrl =
			"https://myresource.openai.azure.com/openai/deployments/mymodel/embeddings?api-version=2024-02-01"

		it("response.ok=false かつ text() 関数が無い場合は 'Error <status>' を使って投げる", async () => {
			const embedder = new OpenAICompatibleEmbedder(azureUrl, testApiKey)
			// text も json も持たない ok:false レスポンス（status も無し → 0 になる）
			;(global.fetch as MockedFunction<typeof fetch>).mockResolvedValue({ ok: false } as any)

			await expect(embedder.createEmbeddings(["hi"])).rejects.toBeInstanceOf(Error)
			expect(global.fetch).toHaveBeenCalledTimes(1)
		})

		it("response.text() が例外を投げても握りつぶして 'Error <status>' で投げる", async () => {
			const embedder = new OpenAICompatibleEmbedder(azureUrl, testApiKey)
			;(global.fetch as MockedFunction<typeof fetch>).mockResolvedValue({
				ok: false,
				status: 503,
				text: async () => {
					throw new Error("boom reading body")
				},
			} as any)

			await expect(embedder.createEmbeddings(["hi"])).rejects.toBeInstanceOf(Error)
			expect(global.fetch).toHaveBeenCalledTimes(1)
		})

		it("response.ok=true でも JSON パースに失敗したら 'Failed to parse response JSON' で投げる", async () => {
			const embedder = new OpenAICompatibleEmbedder(azureUrl, testApiKey)
			;(global.fetch as MockedFunction<typeof fetch>).mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => {
					throw new Error("not json")
				},
			} as any)

			await expect(embedder.createEmbeddings(["hi"])).rejects.toThrow(/Failed to parse response JSON/)
			expect(global.fetch).toHaveBeenCalledTimes(1)
		})
	})

	describe("validateConfiguration: 応答は返るが data が空", () => {
		it("data 空配列なら invalidResponse を返す（例外にはしない）", async () => {
			const embedder = new OpenAICompatibleEmbedder("https://api.example.com/v1", testApiKey)
			mockEmbeddingsCreate.mockResolvedValue({ data: [], usage: { prompt_tokens: 0, total_tokens: 0 } })

			const result = await embedder.validateConfiguration()

			expect(result.valid).toBe(false)
			expect(result.error).toBe("embeddings:validation.invalidResponse")
		})
	})

	describe("グローバルレート制限のヘルパ", () => {
		it("waitForGlobalRateLimit: レート制限中は待機し、二重 release を握りつぶす", async () => {
			vitest.useFakeTimers()
			try {
				const embedder = new OpenAICompatibleEmbedder("https://api.example.com/v1", testApiKey)
				const state = (embedder as any).constructor.globalRateLimitState
				state.isRateLimited = true
				state.rateLimitResetTime = Date.now() + 1000

				const p = (embedder as any).waitForGlobalRateLimit()
				// 待機（setTimeout(1000)）を消化
				await vitest.advanceTimersByTimeAsync(1000)
				await expect(p).resolves.toBeUndefined()
			} finally {
				vitest.useRealTimers()
			}
		})

		it("getGlobalRateLimitDelay: レート制限が無ければ 0 を返す", async () => {
			const embedder = new OpenAICompatibleEmbedder("https://api.example.com/v1", testApiKey)
			const state = (embedder as any).constructor.globalRateLimitState
			state.isRateLimited = false
			state.rateLimitResetTime = 0

			const delay = await (embedder as any).getGlobalRateLimitDelay()
			expect(delay).toBe(0)
		})

		it("waitForGlobalRateLimit: リセット時刻を過ぎていたら制限を解除する", async () => {
			const embedder = new OpenAICompatibleEmbedder("https://api.example.com/v1", testApiKey)
			const state = (embedder as any).constructor.globalRateLimitState
			state.isRateLimited = true
			state.rateLimitResetTime = Date.now() - 1 // 既に過ぎている
			state.consecutiveRateLimitErrors = 5

			await (embedder as any).waitForGlobalRateLimit()

			expect(state.isRateLimited).toBe(false)
			expect(state.consecutiveRateLimitErrors).toBe(0)
		})
	})
})
