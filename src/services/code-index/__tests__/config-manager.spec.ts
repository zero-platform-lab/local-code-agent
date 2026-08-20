import { describe, it, expect, vi } from "vitest"
import { CodeIndexConfigManager } from "../config-manager"
import type { ContextProxy } from "../../../core/config/ContextProxy"
import type { PreviousConfigSnapshot } from "../interfaces/config"

// embeddingModels / constants は純粋・決定的なので本物を使う（実際の次元/しきい値ロジックを検証）。
// 外部依存は ContextProxy のみ。ネットワークには一切出ない（getGlobalState/getSecret を差し替えるだけ）。

const OC = "openai-compatible" as const
const BASE_URL = "https://api.example.com/v1"

type GlobalState = Record<string, unknown> | undefined

function makeProxy(globalState: GlobalState, secrets: Record<string, string | undefined> = {}) {
	return {
		getGlobalState: vi.fn((key: string) => (key === "codebaseIndexConfig" ? globalState : undefined)),
		getSecret: vi.fn((key: string) => secrets[key]),
		refreshSecrets: vi.fn().mockResolvedValue(undefined),
	} as unknown as ContextProxy
}

/** 完全に設定済みの globalState を生成（上書き可） */
function fullGlobalState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		codebaseIndexEnabled: true,
		codebaseIndexQdrantUrl: "http://localhost:6333",
		codebaseIndexEmbedderProvider: OC,
		codebaseIndexOpenAiCompatibleBaseUrl: BASE_URL,
		codebaseIndexEmbedderModelId: "text-embedding-3-small",
		codebaseIndexEmbedderModelDimension: undefined,
		codebaseIndexSearchMinScore: undefined,
		codebaseIndexSearchMaxResults: undefined,
		...overrides,
	}
}

const FULL_SECRETS = {
	codeIndexQdrantApiKey: "qkey",
	codebaseIndexOpenAiCompatibleApiKey: "akey",
}

function makeManager(globalState: GlobalState, secrets = FULL_SECRETS): CodeIndexConfigManager {
	return new CodeIndexConfigManager(makeProxy(globalState, secrets))
}

describe("CodeIndexConfigManager", () => {
	describe("getContextProxy", () => {
		it("コンストラクタに渡した ContextProxy を返す", () => {
			const proxy = makeProxy(fullGlobalState(), FULL_SECRETS)
			const mgr = new CodeIndexConfigManager(proxy)
			expect(mgr.getContextProxy()).toBe(proxy)
		})
	})

	describe("isConfigured — 設定不備で外部接続に到達しない不変条件", () => {
		it("baseUrl・apiKey・qdrantUrl が揃って初めて configured", () => {
			const mgr = makeManager(fullGlobalState())
			expect(mgr.isConfigured()).toBe(true)
		})

		it("baseUrl 欠落なら未設定（openAiCompatibleOptions 未生成）", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexOpenAiCompatibleBaseUrl: "" }))
			expect(mgr.isConfigured()).toBe(false)
			expect(mgr.getConfig().openAiCompatibleOptions).toBeUndefined()
		})

		it("apiKey 欠落なら未設定", () => {
			const mgr = makeManager(fullGlobalState(), {
				codeIndexQdrantApiKey: "qkey",
				codebaseIndexOpenAiCompatibleApiKey: "",
			})
			expect(mgr.isConfigured()).toBe(false)
			expect(mgr.getConfig().openAiCompatibleOptions).toBeUndefined()
		})

		it("qdrantUrl 欠落なら（baseUrl/apiKey があっても）未設定", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexQdrantUrl: undefined }))
			expect(mgr.isConfigured()).toBe(false)
		})

		it("globalState 未取得（undefined）なら既定値で未設定・非有効", () => {
			// getGlobalState が undefined → ?? 既定オブジェクトが使われる
			const mgr = makeManager(undefined)
			expect(mgr.isConfigured()).toBe(false)
			expect(mgr.isFeatureEnabled).toBe(false)
			expect(mgr.getConfig().openAiCompatibleOptions).toBeUndefined()
		})

		it("codebaseIndexEnabled キー欠落なら false（?? false 分岐）", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexEnabled: undefined }))
			expect(mgr.isFeatureEnabled).toBe(false)
		})

		it("contextProxy が無くても（null 相当）既定で未設定に倒れ、外部接続情報を持たない", () => {
			// 防御的 optional chaining (?.）の null 経路。ネットワークには当然出ない。
			const mgr = new CodeIndexConfigManager(null as unknown as ContextProxy)
			expect(mgr.isConfigured()).toBe(false)
			expect(mgr.isFeatureEnabled).toBe(false)
			const cfg = mgr.getConfig()
			expect(cfg.openAiCompatibleOptions).toBeUndefined()
			expect(cfg.qdrantApiKey).toBe("")
		})
	})

	describe("modelDimension の検証", () => {
		it("正の数値ならそのまま採用", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelDimension: 1536 }))
			expect(mgr.getConfig().modelDimension).toBe(1536)
		})

		it("文字列の数値も Number 変換して採用", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelDimension: "2048" }))
			expect(mgr.getConfig().modelDimension).toBe(2048)
		})

		it("不正値（NaN）は警告して undefined", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelDimension: "not-a-number" }))
			expect(mgr.getConfig().modelDimension).toBeUndefined()
			expect(warn).toHaveBeenCalled()
			warn.mockRestore()
		})

		it("0 以下は不正値として undefined", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelDimension: 0 }))
			expect(mgr.getConfig().modelDimension).toBeUndefined()
			warn.mockRestore()
		})

		it("null は undefined 扱い（!== null 分岐）", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelDimension: null }))
			expect(mgr.getConfig().modelDimension).toBeUndefined()
		})

		it("未指定（undefined）は undefined", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelDimension: undefined }))
			expect(mgr.getConfig().modelDimension).toBeUndefined()
		})
	})

	describe("modelId", () => {
		it("空文字は undefined になり既定モデルにフォールバックする", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelId: "" }))
			expect(mgr.currentModelId).toBeUndefined()
			// currentModelDimension は既定モデル text-embedding-3-small (1536)
			expect(mgr.currentModelDimension).toBe(1536)
		})

		it("指定があればそれを返す", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelId: "text-embedding-3-large" }))
			expect(mgr.currentModelId).toBe("text-embedding-3-large")
		})
	})

	describe("getConfig / 各ゲッター", () => {
		it("設定済みの全項目を返す", () => {
			const mgr = makeManager(
				fullGlobalState({
					codebaseIndexEmbedderModelId: "text-embedding-3-large",
					codebaseIndexSearchMinScore: 0.7,
					codebaseIndexSearchMaxResults: 25,
				}),
			)
			const cfg = mgr.getConfig()
			expect(cfg).toEqual({
				isConfigured: true,
				embedderProvider: OC,
				modelId: "text-embedding-3-large",
				modelDimension: undefined,
				openAiCompatibleOptions: { baseUrl: BASE_URL, apiKey: "akey" },
				qdrantUrl: "http://localhost:6333",
				qdrantApiKey: "qkey",
				searchMinScore: 0.7,
				searchMaxResults: 25,
			})
			expect(mgr.isFeatureEnabled).toBe(true)
			expect(mgr.isFeatureConfigured).toBe(true)
			expect(mgr.currentEmbedderProvider).toBe(OC)
			expect(mgr.qdrantConfig).toEqual({ url: "http://localhost:6333", apiKey: "qkey" })
		})
	})

	describe("currentModelDimension", () => {
		it("既知モデルは組み込み次元を返す（カスタム次元より優先）", () => {
			const mgr = makeManager(
				fullGlobalState({
					codebaseIndexEmbedderModelId: "text-embedding-3-small",
					codebaseIndexEmbedderModelDimension: 9999, // 既知モデルなので無視される
				}),
			)
			expect(mgr.currentModelDimension).toBe(1536)
		})

		it("未知モデル＋カスタム次元>0 ならカスタム次元を返す", () => {
			const mgr = makeManager(
				fullGlobalState({
					codebaseIndexEmbedderModelId: "unknown-model",
					codebaseIndexEmbedderModelDimension: 777,
				}),
			)
			expect(mgr.currentModelDimension).toBe(777)
		})

		it("未知モデル＋カスタム次元なしなら undefined", () => {
			const mgr = makeManager(
				fullGlobalState({
					codebaseIndexEmbedderModelId: "unknown-model",
					codebaseIndexEmbedderModelDimension: undefined,
				}),
			)
			expect(mgr.currentModelDimension).toBeUndefined()
		})
	})

	describe("currentSearchMinScore / currentSearchMaxResults", () => {
		it("ユーザ設定があれば最優先", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexSearchMinScore: 0.9 }))
			expect(mgr.getConfig().searchMinScore).toBe(0.9)
		})

		it("ユーザ設定なし・既知モデルはモデル固有しきい値", () => {
			const mgr = makeManager(
				fullGlobalState({
					codebaseIndexSearchMinScore: undefined,
					codebaseIndexEmbedderModelId: "text-embedding-3-small",
				}),
			)
			// text-embedding-3-small の scoreThreshold は 0.4
			expect(mgr.getConfig().searchMinScore).toBe(0.4)
		})

		it("ユーザ設定なし・未知モデルは既定 0.4 にフォールバック", () => {
			const mgr = makeManager(
				fullGlobalState({
					codebaseIndexSearchMinScore: undefined,
					codebaseIndexEmbedderModelId: "unknown-model",
				}),
			)
			expect(mgr.getConfig().searchMinScore).toBe(0.4)
		})

		it("maxResults はユーザ設定を返す", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexSearchMaxResults: 12 }))
			expect(mgr.currentSearchMaxResults).toBe(12)
		})

		it("maxResults 未設定なら既定 50", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexSearchMaxResults: undefined }))
			expect(mgr.currentSearchMaxResults).toBe(50)
		})
	})

	describe("loadConfiguration", () => {
		it("secrets を再取得し、スナップショット・現行設定・requiresRestart を返す", async () => {
			const proxy = makeProxy(fullGlobalState(), FULL_SECRETS)
			const mgr = new CodeIndexConfigManager(proxy)
			const result = await mgr.loadConfiguration()

			expect(proxy.refreshSecrets).toHaveBeenCalledTimes(1)
			expect(result.currentConfig.isConfigured).toBe(true)
			expect(result.currentConfig.embedderProvider).toBe(OC)
			expect(result.configSnapshot).toBeDefined()
			expect(typeof result.requiresRestart).toBe("boolean")
		})

		it("未設定→有効かつ設定済みへの遷移で requiresRestart=true", async () => {
			// 初期状態: globalState 未取得（未設定・無効）
			const proxy = {
				getGlobalState: vi.fn(),
				getSecret: vi.fn(),
				refreshSecrets: vi.fn().mockResolvedValue(undefined),
			} as unknown as ContextProxy
			// コンストラクタ時点では未設定
			;(proxy.getGlobalState as any).mockReturnValue(undefined)
			;(proxy.getSecret as any).mockReturnValue("")
			const mgr = new CodeIndexConfigManager(proxy)
			expect(mgr.isConfigured()).toBe(false)

			// loadConfiguration 時点で完全設定に切り替える
			;(proxy.getGlobalState as any).mockReturnValue(fullGlobalState())
			;(proxy.getSecret as any).mockImplementation((k: string) => (FULL_SECRETS as Record<string, string>)[k])

			const result = await mgr.loadConfiguration()
			expect(result.currentConfig.isConfigured).toBe(true)
			expect(result.requiresRestart).toBe(true)
		})

		it("qdrantUrl 未設定のインスタンスからスナップショットを取ると空文字に倒れる", async () => {
			// 構築時点で qdrantUrl=undefined → スナップショット生成で this.qdrantUrl ?? "" の右辺を通る
			const proxy = makeProxy(fullGlobalState({ codebaseIndexQdrantUrl: undefined }), FULL_SECRETS)
			const mgr = new CodeIndexConfigManager(proxy)
			const result = await mgr.loadConfiguration()
			expect(result.configSnapshot.qdrantUrl).toBe("")
		})
	})

	describe("doesConfigChangeRequireRestart", () => {
		// 現行インスタンスは fullGlobalState（有効・設定済み）を基準にする
		const currentPrevSame: PreviousConfigSnapshot = {
			enabled: true,
			configured: true,
			embedderProvider: OC,
			modelId: "text-embedding-3-small",
			modelDimension: undefined,
			openAiCompatibleBaseUrl: BASE_URL,
			openAiCompatibleApiKey: "akey",
			qdrantUrl: "http://localhost:6333",
			qdrantApiKey: "qkey",
		}

		it("null 相当の prev でも安全に既定へ倒して判定（例外を投げない）", () => {
			const mgr = makeManager(fullGlobalState())
			// prev null → prev?.X ?? default 経路。now: 有効・設定済み。
			// prevEnabled=false, prevConfigured=false かつ now 有効・設定済み → true
			expect(mgr.doesConfigChangeRequireRestart(null as unknown as PreviousConfigSnapshot)).toBe(true)
		})

		it("変更なしなら restart 不要", () => {
			const mgr = makeManager(fullGlobalState())
			expect(mgr.doesConfigChangeRequireRestart({ ...currentPrevSame })).toBe(false)
		})

		it("有効→無効の遷移で restart 必要", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexEnabled: false }))
			// prevEnabled=true, now disabled → true
			expect(mgr.doesConfigChangeRequireRestart({ ...currentPrevSame, enabled: true })).toBe(true)
		})

		it("未設定のまま（enabled だが未設定）なら restart 不要", () => {
			// now: enabled だが baseUrl 欠落で未設定
			const mgr = makeManager(fullGlobalState({ codebaseIndexOpenAiCompatibleBaseUrl: "" }))
			// prev も未設定・無効 → (!prevEnabled||!prevConfigured) && (!enabled||!nowConfigured) → false
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					enabled: false,
					configured: false,
				}),
			).toBe(false)
		})

		it("無効時は critical チェックへ進まず restart 不要", () => {
			// now: 無効だが prev は有効・設定済み → line199 で true になってしまうため、
			// prev も無効にして line210 の「!enabled → false」を通す
			const mgr = makeManager(fullGlobalState({ codebaseIndexEnabled: false }))
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					enabled: false,
					configured: true,
				}),
			).toBe(false)
		})

		it("プロバイダ変更で restart 必要", () => {
			const mgr = makeManager(fullGlobalState())
			// 現行は openai-compatible 固定。prev を別プロバイダにする
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					embedderProvider: "ollama" as any,
				}),
			).toBe(true)
		})

		it("baseUrl 変更で restart 必要", () => {
			const mgr = makeManager(fullGlobalState())
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					openAiCompatibleBaseUrl: "https://old.example.com",
				}),
			).toBe(true)
		})

		it("apiKey 変更で restart 必要", () => {
			const mgr = makeManager(fullGlobalState())
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					openAiCompatibleApiKey: "old-key",
				}),
			).toBe(true)
		})

		it("modelDimension（生値）変更で restart 必要", () => {
			// 現行は modelDimension 1536（生値）を設定
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelDimension: 1536 }))
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					modelDimension: 3072,
				}),
			).toBe(true)
		})

		it("qdrantUrl 変更で restart 必要", () => {
			const mgr = makeManager(fullGlobalState())
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					qdrantUrl: "http://other:6333",
				}),
			).toBe(true)
		})

		it("qdrantApiKey 変更で restart 必要", () => {
			const mgr = makeManager(fullGlobalState())
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					qdrantApiKey: "old-qkey",
				}),
			).toBe(true)
		})

		it("ベクトル次元が変わるモデル変更で restart 必要（1536→3072）", () => {
			// 現行 large(3072)。prev small(1536)。他は同一。
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelId: "text-embedding-3-large" }))
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					modelId: "text-embedding-3-small",
				}),
			).toBe(true)
		})

		it("次元が同じモデル変更なら restart 不要（small↔ada 共に 1536）", () => {
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelId: "text-embedding-ada-002" }))
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					modelId: "text-embedding-3-small",
				}),
			).toBe(false)
		})

		it("次元不明なモデルへの変更は安全側で restart 必要", () => {
			// 現行 unknown-model → getModelDimension undefined → true
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelId: "unknown-model" }))
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					modelId: "text-embedding-3-small",
				}),
			).toBe(true)
		})

		it("有効だが現行が未設定に転落した場合、認証情報差分で restart 必要（current* が空文字化）", () => {
			// 現行: enabled=true だが baseUrl/apiKey/qdrantUrl すべて欠落 → 未設定。
			// prev は完全設定。step3 を通すため prev は enabled+configured のまま。
			const mgr = makeManager(
				fullGlobalState({
					codebaseIndexOpenAiCompatibleBaseUrl: "",
					codebaseIndexQdrantUrl: undefined,
				}),
				{ codeIndexQdrantApiKey: "", codebaseIndexOpenAiCompatibleApiKey: "" },
			)
			expect(mgr.isConfigured()).toBe(false)
			// current baseUrl="" vs prev BASE_URL → 差分で true
			expect(mgr.doesConfigChangeRequireRestart({ ...currentPrevSame })).toBe(true)
		})

		it("現行 modelId 未指定でも既定モデルへ解決して次元差分を判定（?? default 左経路の補完）", () => {
			// 現行 modelId="" → this.modelId undefined → 既定 small(1536)。prev large(3072) → true
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelId: "" }))
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					modelId: "text-embedding-3-large",
				}),
			).toBe(true)
		})

		it("prev.modelId 未指定でも既定モデルへ解決して次元差分を判定", () => {
			// prev.modelId undefined → 既定 small(1536)。現行 large(3072) → true
			const mgr = makeManager(fullGlobalState({ codebaseIndexEmbedderModelId: "text-embedding-3-large" }))
			expect(
				mgr.doesConfigChangeRequireRestart({
					...currentPrevSame,
					modelId: undefined,
				}),
			).toBe(true)
		})
	})
})
