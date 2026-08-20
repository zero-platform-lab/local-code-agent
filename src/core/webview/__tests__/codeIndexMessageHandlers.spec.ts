// npx vitest run src/core/webview/__tests__/codeIndexMessageHandlers.spec.ts
//
// codeIndexMessageHandlers は「コードインデックス設定の保存」と「インデックス操作」を
// webview から受ける表。外部サービス（埋め込み API / Qdrant）への接続と、
// 復元不能なインデックス削除の両方を握っているため、以下を不変条件として固定する。
//
//   1. 【設定が欠けている / 不正なら外部へ出ない】
//      ワークスペース未オープン、機能無効、未設定（isFeatureConfigured=false）、
//      あるいは埋め込みプロバイダ検証に失敗した場合、initialize() / startIndexing() は
//      一度も呼ばれない。＝Qdrant や埋め込みエンドポイントへ接続しにいかない。
//   2. 【クリアの対象は現在のワークスペースだけ】
//      clearIndexData は getCurrentWorkspaceCodeIndexManager() が返した 1 つにしか及ばない。
//      他ワークスペースの manager（getAllInstances に居る）には触れない。
//      ワークスペース未オープンなら「何も消さずに失敗を返す」。
//   3. 【未知のメッセージ種別は黙って無視】表に無い type は undefined が返るだけで throw しない。
//
// ネットワークは一切張らない：CodeIndexManager はモジュールごとモックし、
// manager はすべてフェイク（vi.fn）で差し替える。

import type { WebviewMessage } from "@openai-agent/types"

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

// 実 manager は Qdrant / 埋め込みクライアントを引き連れてくるためモジュールごと差し替える。
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getAllInstances: vi.fn(() => []) },
}))

import { CodeIndexManager } from "../../../services/code-index/manager"
import { codeIndexMessageHandlers } from "../codeIndexMessageHandlers"
import type { WebviewMessageHost } from "../webviewMessageHost"

// ---------------------------------------------------------------------------
// フェイク manager
// ---------------------------------------------------------------------------

interface FakeManagerOptions {
	isFeatureEnabled?: boolean
	isFeatureConfigured?: boolean
	isInitialized?: boolean
	isWorkspaceEnabled?: boolean
	state?: string
	status?: Record<string, unknown>
}

function makeManager(options: FakeManagerOptions = {}) {
	const manager = {
		isFeatureEnabled: options.isFeatureEnabled ?? true,
		isFeatureConfigured: options.isFeatureConfigured ?? true,
		isInitialized: options.isInitialized ?? true,
		isWorkspaceEnabled: options.isWorkspaceEnabled ?? true,
		state: options.state ?? "Standby",
		handleSettingsChange: vi.fn(async () => {}),
		initialize: vi.fn(async (_contextProxy: unknown) => ({ requiresRestart: false })),
		startIndexing: vi.fn(() => {}),
		stopIndexing: vi.fn(() => {}),
		setWorkspaceEnabled: vi.fn(async (_enabled: boolean) => {}),
		setAutoEnableDefault: vi.fn(async (_enabled: boolean) => {}),
		clearIndexData: vi.fn(async () => {}),
		getCurrentStatus: vi.fn(() => options.status ?? { systemStatus: "Standby", processedItems: 0, totalItems: 0 }),
	}
	return manager
}

type FakeManager = ReturnType<typeof makeManager>

/** 「外部サービスへ出ていない」ことの共通検査（不変条件 1）。 */
function expectNoExternalWork(...managers: FakeManager[]): void {
	for (const manager of managers) {
		expect(manager.initialize).not.toHaveBeenCalled()
		expect(manager.startIndexing).not.toHaveBeenCalled()
	}
}

// ---------------------------------------------------------------------------
// フェイク provider
// ---------------------------------------------------------------------------

interface SetupOptions {
	/** getCurrentWorkspaceCodeIndexManager() の戻り値。undefined ならワークスペース未オープン。 */
	manager?: FakeManager
	/** contextProxy.getValue("codebaseIndexConfig") の戻り値。 */
	globalConfig?: Record<string, unknown>
	/** contextProxy.setValue の実装（保存失敗の再現用）。 */
	setValue?: (key: string, value: unknown) => Promise<void>
	/** context.secrets.get の実装。 */
	secrets?: Record<string, string | undefined>
}

function setup(options: SetupOptions = {}) {
	const getValue = vi.fn((_key: string) => options.globalConfig)
	const setValue = vi.fn(options.setValue ?? (async (_key: string, _value: unknown) => {}))
	const storeSecret = vi.fn(async (_key: string, _value: string) => {})
	const secretsGet = vi.fn(async (key: string) => options.secrets?.[key])
	const postMessageToWebview = vi.fn(async (_message: unknown) => {})
	const postStateToWebview = vi.fn(async () => {})
	const log = vi.fn((_message: string) => {})
	const getCurrentWorkspaceCodeIndexManager = vi.fn(() => options.manager)

	// WebviewMessageHost は巨大なので必要なメンバだけ生やしてキャストする
	// （既存の webview 系 spec と同じ流儀）。
	const provider = {
		contextProxy: { getValue, setValue, storeSecret },
		context: { secrets: { get: secretsGet } },
		postMessageToWebview,
		postStateToWebview,
		log,
		getCurrentWorkspaceCodeIndexManager,
	} as unknown as WebviewMessageHost

	return {
		provider,
		getValue,
		setValue,
		storeSecret,
		secretsGet,
		postMessageToWebview,
		postStateToWebview,
		log,
		getCurrentWorkspaceCodeIndexManager,
		posted: () => postMessageToWebview.mock.calls.map((call) => call[0] as { type: string; [k: string]: unknown }),
		postedOfType: (type: string) =>
			postMessageToWebview.mock.calls
				.map((call) => call[0] as { type: string; [k: string]: unknown })
				.filter((message) => message.type === type),
	}
}

/** 表からハンドラを取り出して実行する（未登録なら false）。 */
const dispatch = async (provider: WebviewMessageHost, message: WebviewMessage): Promise<boolean> => {
	const handler = codeIndexMessageHandlers[message.type]
	if (!handler) {
		return false
	}
	await handler(provider, message)
	return true
}

const msg = (type: string, rest: Record<string, unknown> = {}): WebviewMessage =>
	({ type, ...rest }) as unknown as WebviewMessage

/** saveCodeIndexSettingsAtomic に渡す設定の雛形。 */
const settings = (overrides: Record<string, unknown> = {}) => ({
	codebaseIndexEnabled: true,
	codebaseIndexQdrantUrl: "http://localhost:6333",
	codebaseIndexEmbedderProvider: "openai-compatible" as const,
	codebaseIndexEmbedderModelId: "text-embedding-3-small",
	...overrides,
})

const saveMessage = (overrides: Record<string, unknown> = {}) =>
	msg("saveCodeIndexSettingsAtomic", { codeIndexSettings: settings(overrides) })

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([])
})

// ---------------------------------------------------------------------------

describe("codeIndexMessageHandlers", () => {
	describe("不変条件3: 未知のメッセージ種別は黙って無視される", () => {
		it.each(["totallyUnknownMessage", "", "StartIndexing", "clearindexdata", "webviewDidLaunch"])(
			"%s は表に登録されておらず provider に触らない",
			async (type) => {
				const manager = makeManager()
				const h = setup({ manager })

				await expect(dispatch(h.provider, msg(type))).resolves.toBe(false)

				expect(h.postMessageToWebview).not.toHaveBeenCalled()
				expect(h.getCurrentWorkspaceCodeIndexManager).not.toHaveBeenCalled()
				expectNoExternalWork(manager)
				expect(manager.clearIndexData).not.toHaveBeenCalled()
			},
		)
	})

	// -----------------------------------------------------------------------

	describe("saveCodeIndexSettingsAtomic", () => {
		it("設定を global state と secret に保存し、保存結果と状態を webview へ返す", async () => {
			const manager = makeManager({ isInitialized: true })
			const h = setup({ manager, globalConfig: { codebaseIndexEmbedderProvider: "openai-compatible" } })

			await dispatch(
				h.provider,
				saveMessage({
					codeIndexQdrantApiKey: "qdrant-key",
					codebaseIndexOpenAiCompatibleApiKey: "openai-key",
					codebaseIndexOpenAiCompatibleBaseUrl: "https://embed.example",
					codebaseIndexEmbedderModelDimension: 1536,
					codebaseIndexSearchMaxResults: 20,
					codebaseIndexSearchMinScore: 0.4,
				}),
			)

			expect(h.setValue).toHaveBeenCalledExactlyOnceWith(
				"codebaseIndexConfig",
				expect.objectContaining({
					codebaseIndexEnabled: true,
					codebaseIndexQdrantUrl: "http://localhost:6333",
					codebaseIndexEmbedderProvider: "openai-compatible",
					codebaseIndexEmbedderModelId: "text-embedding-3-small",
					codebaseIndexEmbedderModelDimension: 1536,
					codebaseIndexOpenAiCompatibleBaseUrl: "https://embed.example",
					codebaseIndexSearchMaxResults: 20,
					codebaseIndexSearchMinScore: 0.4,
				}),
			)
			expect(h.storeSecret.mock.calls).toEqual([
				["codeIndexQdrantApiKey", "qdrant-key"],
				["codebaseIndexOpenAiCompatibleApiKey", "openai-key"],
			])
			expect(h.postedOfType("codeIndexSettingsSaved")[0]).toMatchObject({ success: true })
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("codeIndexSettings が無いメッセージは何もせずに返る", async () => {
			const manager = makeManager()
			const h = setup({ manager })

			await expect(dispatch(h.provider, msg("saveCodeIndexSettingsAtomic"))).resolves.toBe(true)

			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
			expectNoExternalWork(manager)
		})

		it("API キーが未指定なら secret には書き込まない", async () => {
			const manager = makeManager({ isInitialized: true })
			const h = setup({ manager, globalConfig: { codebaseIndexEmbedderProvider: "openai-compatible" } })

			await dispatch(h.provider, saveMessage())

			expect(h.storeSecret).not.toHaveBeenCalled()
		})

		it("既存 config が未保存（undefined）でも空オブジェクトから組み立てる", async () => {
			const manager = makeManager({ isInitialized: true })
			const h = setup({ manager, globalConfig: undefined })

			await dispatch(h.provider, saveMessage())

			// 既存 provider が undefined → "openai-compatible" への変更とみなされ検証が走る。
			expect(manager.handleSettingsChange).toHaveBeenCalledOnce()
			expect(h.postedOfType("codeIndexSettingsSaved")[0]).toMatchObject({ success: true })
		})

		it("プロバイダが変わっていなければ検証は通常経路で行われる", async () => {
			const manager = makeManager({ isInitialized: true })
			const h = setup({ manager, globalConfig: { codebaseIndexEmbedderProvider: "openai-compatible" } })

			await dispatch(h.provider, saveMessage())

			expect(manager.handleSettingsChange).toHaveBeenCalledOnce()
			expectNoExternalWork(manager)
		})

		describe("不変条件1: 設定が不正／未設定なら外部へ出ない", () => {
			it("【不変条件】プロバイダ変更後の検証に失敗したら初期化もインデックス開始もしない", async () => {
				const manager = makeManager({ isInitialized: false })
				manager.handleSettingsChange.mockRejectedValue(new Error("invalid embedder credentials"))
				const h = setup({ manager, globalConfig: undefined })

				await expect(dispatch(h.provider, saveMessage())).resolves.toBe(true)

				// 検証に落ちた時点で早期 return。Qdrant への接続は試みない。
				expectNoExternalWork(manager)
				expect(h.log).toHaveBeenCalledWith(
					"Embedder validation failed after provider change: invalid embedder credentials",
				)
				expect(h.postedOfType("indexingStatusUpdate")).toHaveLength(1)
				// 設定自体は保存済み（成功応答は先に返る）。
				expect(h.postedOfType("codeIndexSettingsSaved")[0]).toMatchObject({ success: true })
			})

			it("プロバイダ変更が無い場合の検証エラーはログのみで続行する", async () => {
				const manager = makeManager({ isInitialized: true })
				manager.handleSettingsChange.mockRejectedValue(new Error("transient"))
				const h = setup({ manager, globalConfig: { codebaseIndexEmbedderProvider: "openai-compatible" } })

				await dispatch(h.provider, saveMessage())

				expect(h.log).toHaveBeenCalledWith("Settings change handling error: transient")
				// isInitialized=true なので初期化はしない。
				expectNoExternalWork(manager)
			})

			it.each([
				{ name: "機能が無効", enabled: false, configured: true },
				{ name: "設定が未完了", enabled: true, configured: false },
				{ name: "無効かつ未設定", enabled: false, configured: false },
			])("【不変条件】$name なら initialize を呼ばない", async ({ enabled, configured }) => {
				const manager = makeManager({
					isFeatureEnabled: enabled,
					isFeatureConfigured: configured,
					isInitialized: false,
				})
				const h = setup({ manager, globalConfig: { codebaseIndexEmbedderProvider: "openai-compatible" } })

				await dispatch(h.provider, saveMessage())

				expectNoExternalWork(manager)
			})

			it("【不変条件】ワークスペース未オープンなら manager 操作は一切行わずエラー状態を返す", async () => {
				const other = makeManager()
				vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([other as never])
				const h = setup({ manager: undefined, globalConfig: undefined })

				await dispatch(h.provider, saveMessage())

				expectNoExternalWork(other)
				expect(h.log).toHaveBeenCalledWith("Cannot save code index settings: No workspace folder open")
				expect(h.postedOfType("indexingStatusUpdate")[0]).toMatchObject({
					values: expect.objectContaining({
						systemStatus: "Error",
						message: "embeddings:orchestrator.indexingRequiresWorkspace",
					}),
				})
			})
		})

		it("有効かつ設定済みで未初期化なら初期化する", async () => {
			const manager = makeManager({ isInitialized: false })
			const h = setup({ manager, globalConfig: { codebaseIndexEmbedderProvider: "openai-compatible" } })

			await dispatch(h.provider, saveMessage())

			expect(manager.initialize).toHaveBeenCalledExactlyOnceWith(
				(h.provider as unknown as { contextProxy: unknown }).contextProxy,
			)
			expect(h.log).toHaveBeenCalledWith("Code index manager initialized after settings save")
		})

		it("初期化に失敗したらログと状態通知だけ行い throw しない", async () => {
			const manager = makeManager({ isInitialized: false })
			manager.initialize.mockRejectedValue(new Error("qdrant unreachable"))
			const h = setup({ manager, globalConfig: { codebaseIndexEmbedderProvider: "openai-compatible" } })

			await expect(dispatch(h.provider, saveMessage())).resolves.toBe(true)

			expect(h.log).toHaveBeenCalledWith("Code index initialization failed: qdrant unreachable")
			expect(h.postedOfType("indexingStatusUpdate")).toHaveLength(1)
		})

		it("Error でない値が投げられた初期化失敗も String 化してログに残す", async () => {
			const manager = makeManager({ isInitialized: false })
			manager.initialize.mockRejectedValue("plain-failure")
			const h = setup({ manager, globalConfig: { codebaseIndexEmbedderProvider: "openai-compatible" } })

			await dispatch(h.provider, saveMessage())

			expect(h.log).toHaveBeenCalledWith("Code index initialization failed: plain-failure")
		})

		it("保存自体が失敗したら success:false をエラーメッセージ付きで返す", async () => {
			const h = setup({
				setValue: async () => {
					throw new Error("state write failed")
				},
			})

			await expect(dispatch(h.provider, saveMessage())).resolves.toBe(true)

			expect(h.log).toHaveBeenCalledWith("Error saving code index settings: state write failed")
			expect(h.postedOfType("codeIndexSettingsSaved")[0]).toEqual({
				type: "codeIndexSettingsSaved",
				success: false,
				error: "state write failed",
			})
		})

		it("message プロパティを持たない値が投げられたら既定文言で success:false を返す", async () => {
			const h = setup({
				setValue: async () => {
					throw "plain-string-failure"
				},
			})

			await dispatch(h.provider, saveMessage())

			// ログ側は `message || error` なので投げられた値そのものが出る。
			expect(h.log).toHaveBeenCalledWith("Error saving code index settings: plain-string-failure")
			expect(h.postedOfType("codeIndexSettingsSaved")[0]).toEqual({
				type: "codeIndexSettingsSaved",
				success: false,
				error: "Failed to save settings",
			})
		})
	})

	// -----------------------------------------------------------------------

	describe("requestIndexingStatus", () => {
		it("manager があれば現在状態をそのまま返す", async () => {
			const manager = makeManager({ status: { systemStatus: "Indexing", processedItems: 3, totalItems: 10 } })
			const h = setup({ manager })

			await dispatch(h.provider, msg("requestIndexingStatus"))

			expect(h.posted()).toEqual([
				{
					type: "indexingStatusUpdate",
					values: { systemStatus: "Indexing", processedItems: 3, totalItems: 10 },
				},
			])
		})

		it("ワークスペース未オープンならエラー状態を返す（webview を待たせない）", async () => {
			const h = setup({ manager: undefined })

			await dispatch(h.provider, msg("requestIndexingStatus"))

			const values = h.posted()[0].values as Record<string, unknown>
			expect(values).toMatchObject({
				systemStatus: "Error",
				message: "embeddings:orchestrator.indexingRequiresWorkspace",
				processedItems: 0,
				totalItems: 0,
			})
			// 【要確認】キー名が workerspacePath と綴られており IndexingStatus.workspacePath に届かない。
			expect(Object.keys(values)).toContain("workerspacePath")
			expect(Object.keys(values)).not.toContain("workspacePath")
		})
	})

	describe("requestCodeIndexSecretStatus", () => {
		it.each([
			{
				name: "両方セット済み",
				secrets: { codeIndexQdrantApiKey: "a", codebaseIndexOpenAiCompatibleApiKey: "b" },
				expected: { hasQdrantApiKey: true, hasOpenAiCompatibleApiKey: true },
			},
			{
				name: "Qdrant のみ",
				secrets: { codeIndexQdrantApiKey: "a" },
				expected: { hasQdrantApiKey: true, hasOpenAiCompatibleApiKey: false },
			},
			{
				name: "埋め込みのみ",
				secrets: { codebaseIndexOpenAiCompatibleApiKey: "b" },
				expected: { hasQdrantApiKey: false, hasOpenAiCompatibleApiKey: true },
			},
			{
				name: "どちらも未設定",
				secrets: {},
				expected: { hasQdrantApiKey: false, hasOpenAiCompatibleApiKey: false },
			},
			{
				name: "空文字は未設定扱い",
				secrets: { codeIndexQdrantApiKey: "", codebaseIndexOpenAiCompatibleApiKey: "" },
				expected: { hasQdrantApiKey: false, hasOpenAiCompatibleApiKey: false },
			},
		])("$name", async ({ secrets, expected }) => {
			const h = setup({ secrets })

			await dispatch(h.provider, msg("requestCodeIndexSecretStatus"))

			expect(h.posted()).toEqual([{ type: "codeIndexSecretStatus", values: expected }])
			// 秘密の中身そのものは webview へ渡さない（有無だけ）。
			expect(JSON.stringify(h.posted())).not.toContain('"a"')
		})
	})

	// -----------------------------------------------------------------------

	describe("startIndexing", () => {
		it("ワークスペースを有効化してからインデックスを開始する", async () => {
			const manager = makeManager({ state: "Standby", isInitialized: true })
			const h = setup({ manager })

			await dispatch(h.provider, msg("startIndexing"))

			expect(manager.setWorkspaceEnabled).toHaveBeenCalledExactlyOnceWith(true)
			expect(manager.initialize).toHaveBeenCalledOnce()
			expect(manager.startIndexing).toHaveBeenCalledOnce()
		})

		it("state が Error でも開始する", async () => {
			const manager = makeManager({ state: "Error", isInitialized: true })
			const h = setup({ manager })

			await dispatch(h.provider, msg("startIndexing"))

			expect(manager.startIndexing).toHaveBeenCalledOnce()
		})

		it("既にインデックス中なら開始しない", async () => {
			const manager = makeManager({ state: "Indexing", isInitialized: true })
			const h = setup({ manager })

			await dispatch(h.provider, msg("startIndexing"))

			expect(manager.initialize).toHaveBeenCalledOnce()
			expect(manager.startIndexing).not.toHaveBeenCalled()
		})

		it("初期化が完了していなければ再初期化してから再度開始を試みる", async () => {
			const manager = makeManager({ state: "Standby", isInitialized: false })
			const h = setup({ manager })

			await dispatch(h.provider, msg("startIndexing"))

			expect(manager.initialize).toHaveBeenCalledTimes(2)
			expect(manager.startIndexing).toHaveBeenCalledTimes(2)
		})

		it("再初期化後に state が Standby/Error 以外になっていれば二度目は開始しない", async () => {
			const manager = makeManager({ state: "Standby", isInitialized: false })
			// 2 回目の initialize でインデックスが走り始めた状況を再現する。
			let initializeCalls = 0
			manager.initialize.mockImplementation(async () => {
				initializeCalls += 1
				if (initializeCalls === 2) {
					manager.state = "Indexing"
				}
				return { requiresRestart: false }
			})
			const h = setup({ manager })

			await dispatch(h.provider, msg("startIndexing"))

			expect(manager.initialize).toHaveBeenCalledTimes(2)
			expect(manager.startIndexing).toHaveBeenCalledOnce()
		})

		describe("不変条件1: 設定が不正／未設定なら外部へ出ない", () => {
			it("【不変条件】ワークスペース未オープンなら状態通知だけで何も開始しない", async () => {
				const other = makeManager()
				vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([other as never])
				const h = setup({ manager: undefined })

				await dispatch(h.provider, msg("startIndexing"))

				expectNoExternalWork(other)
				expect(h.log).toHaveBeenCalledWith("Cannot start indexing: No workspace folder open")
				expect(h.postedOfType("indexingStatusUpdate")[0]).toMatchObject({
					values: expect.objectContaining({ systemStatus: "Error" }),
				})
			})

			it.each([
				{ name: "機能が無効", enabled: false, configured: true },
				{ name: "設定が未完了", enabled: true, configured: false },
			])("【不変条件】$name なら initialize も startIndexing も呼ばない", async ({ enabled, configured }) => {
				const manager = makeManager({ isFeatureEnabled: enabled, isFeatureConfigured: configured })
				const h = setup({ manager })

				await dispatch(h.provider, msg("startIndexing"))

				// ワークスペースの有効化までは行うが、外部接続は起こさない。
				expect(manager.setWorkspaceEnabled).toHaveBeenCalledExactlyOnceWith(true)
				expectNoExternalWork(manager)
			})
		})

		it("例外はログだけ残して握り潰す", async () => {
			const manager = makeManager()
			manager.setWorkspaceEnabled.mockRejectedValue(new Error("enable failed"))
			const h = setup({ manager })

			await expect(dispatch(h.provider, msg("startIndexing"))).resolves.toBe(true)

			expect(h.log).toHaveBeenCalledWith("Error starting indexing: enable failed")
			expectNoExternalWork(manager)
		})
	})

	// -----------------------------------------------------------------------

	describe("stopIndexing", () => {
		it("停止して現在状態を返す", async () => {
			const manager = makeManager()
			const h = setup({ manager })

			await dispatch(h.provider, msg("stopIndexing"))

			expect(manager.stopIndexing).toHaveBeenCalledOnce()
			expect(h.postedOfType("indexingStatusUpdate")).toHaveLength(1)
		})

		it("ワークスペース未オープンならログだけ残して何もしない", async () => {
			const h = setup({ manager: undefined })

			await dispatch(h.provider, msg("stopIndexing"))

			expect(h.log).toHaveBeenCalledWith("Cannot stop indexing: No workspace folder open")
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("例外はログだけ残して握り潰す", async () => {
			const manager = makeManager()
			manager.stopIndexing.mockImplementation(() => {
				throw new Error("stop failed")
			})
			const h = setup({ manager })

			await expect(dispatch(h.provider, msg("stopIndexing"))).resolves.toBe(true)

			expect(h.log).toHaveBeenCalledWith("Error stopping indexing: stop failed")
		})
	})

	// -----------------------------------------------------------------------

	describe("toggleWorkspaceIndexing", () => {
		it("有効化すると初期化してインデックスを開始する", async () => {
			const manager = makeManager()
			const h = setup({ manager })

			await dispatch(h.provider, msg("toggleWorkspaceIndexing", { bool: true }))

			expect(manager.setWorkspaceEnabled).toHaveBeenCalledExactlyOnceWith(true)
			expect(manager.initialize).toHaveBeenCalledOnce()
			expect(manager.startIndexing).toHaveBeenCalledOnce()
			expect(manager.stopIndexing).not.toHaveBeenCalled()
			expect(h.postedOfType("indexingStatusUpdate")).toHaveLength(1)
		})

		it("無効化すると停止する", async () => {
			const manager = makeManager()
			const h = setup({ manager })

			await dispatch(h.provider, msg("toggleWorkspaceIndexing", { bool: false }))

			expect(manager.setWorkspaceEnabled).toHaveBeenCalledExactlyOnceWith(false)
			expect(manager.stopIndexing).toHaveBeenCalledOnce()
			expectNoExternalWork(manager)
		})

		it("bool 未指定は「無効化」として扱う（既定値 false）", async () => {
			const manager = makeManager()
			const h = setup({ manager })

			await dispatch(h.provider, msg("toggleWorkspaceIndexing"))

			expect(manager.setWorkspaceEnabled).toHaveBeenCalledExactlyOnceWith(false)
			expect(manager.stopIndexing).toHaveBeenCalledOnce()
		})

		it.each([
			{ name: "機能が無効", enabled: false, configured: true },
			{ name: "設定が未完了", enabled: true, configured: false },
		])("【不変条件】有効化しても $name なら外部へ出ず停止もしない", async ({ enabled, configured }) => {
			const manager = makeManager({ isFeatureEnabled: enabled, isFeatureConfigured: configured })
			const h = setup({ manager })

			await dispatch(h.provider, msg("toggleWorkspaceIndexing", { bool: true }))

			expectNoExternalWork(manager)
			expect(manager.stopIndexing).not.toHaveBeenCalled()
			expect(h.postedOfType("indexingStatusUpdate")).toHaveLength(1)
		})

		it("ワークスペース未オープンならログだけ残して何もしない", async () => {
			const h = setup({ manager: undefined })

			await dispatch(h.provider, msg("toggleWorkspaceIndexing", { bool: true }))

			expect(h.log).toHaveBeenCalledWith("Cannot toggle workspace indexing: No workspace folder open")
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("例外はログだけ残して握り潰す", async () => {
			const manager = makeManager()
			manager.setWorkspaceEnabled.mockRejectedValue("toggle-failure")
			const h = setup({ manager })

			await expect(dispatch(h.provider, msg("toggleWorkspaceIndexing", { bool: true }))).resolves.toBe(true)

			expect(h.log).toHaveBeenCalledWith("Error toggling workspace indexing: toggle-failure")
		})
	})

	// -----------------------------------------------------------------------

	describe("setAutoEnableDefault", () => {
		it("既定を保存し、有効化された manager だけを開始する", async () => {
			// current: 変化なし / turnedOn: 無効→有効 / turnedOff: 有効→無効 /
			// notConfigured: 無効→有効だが未設定。
			const current = makeManager({ isWorkspaceEnabled: true })
			const turnedOn = makeManager({ isWorkspaceEnabled: false })
			const turnedOff = makeManager({ isWorkspaceEnabled: true })
			const notConfigured = makeManager({ isWorkspaceEnabled: false, isFeatureConfigured: false })
			vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([
				current,
				turnedOn,
				turnedOff,
				notConfigured,
			] as never)

			const h = setup({ manager: current })
			// setAutoEnableDefault の副作用として各 manager の有効状態が切り替わる。
			current.setAutoEnableDefault.mockImplementation(async () => {
				turnedOn.isWorkspaceEnabled = true
				turnedOff.isWorkspaceEnabled = false
				notConfigured.isWorkspaceEnabled = true
			})

			await dispatch(h.provider, msg("setAutoEnableDefault", { bool: true }))

			expect(current.setAutoEnableDefault).toHaveBeenCalledExactlyOnceWith(true)
			expect(turnedOn.initialize).toHaveBeenCalledOnce()
			expect(turnedOn.startIndexing).toHaveBeenCalledOnce()
			expect(turnedOff.stopIndexing).toHaveBeenCalledOnce()
			// 【不変条件】未設定の manager は有効化されても外部へ出ない。
			expectNoExternalWork(notConfigured)
			expectNoExternalWork(current)
			expect(current.stopIndexing).not.toHaveBeenCalled()
			expect(h.postedOfType("indexingStatusUpdate")).toHaveLength(1)
		})

		it("有効化された manager が無効のままなら何もしない（機能無効）", async () => {
			const manager = makeManager({ isWorkspaceEnabled: false, isFeatureEnabled: false })
			vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([manager] as never)
			const h = setup({ manager })
			manager.setAutoEnableDefault.mockImplementation(async () => {
				manager.isWorkspaceEnabled = true
			})

			await dispatch(h.provider, msg("setAutoEnableDefault", { bool: true }))

			expectNoExternalWork(manager)
			expect(manager.stopIndexing).not.toHaveBeenCalled()
		})

		it("bool 未指定は true として扱う", async () => {
			const manager = makeManager()
			vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([manager] as never)
			const h = setup({ manager })

			await dispatch(h.provider, msg("setAutoEnableDefault"))

			expect(manager.setAutoEnableDefault).toHaveBeenCalledExactlyOnceWith(true)
		})

		it("false を渡すとそのまま伝える", async () => {
			const manager = makeManager()
			vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([manager] as never)
			const h = setup({ manager })

			await dispatch(h.provider, msg("setAutoEnableDefault", { bool: false }))

			expect(manager.setAutoEnableDefault).toHaveBeenCalledExactlyOnceWith(false)
		})

		it("ワークスペース未オープンなら全 manager に触れない", async () => {
			const other = makeManager()
			vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([other] as never)
			const h = setup({ manager: undefined })

			await dispatch(h.provider, msg("setAutoEnableDefault", { bool: true }))

			expect(other.setAutoEnableDefault).not.toHaveBeenCalled()
			expect(other.stopIndexing).not.toHaveBeenCalled()
			expectNoExternalWork(other)
			expect(h.log).toHaveBeenCalledWith("Cannot set auto-enable default: No workspace folder open")
		})

		it("例外はログだけ残して握り潰す", async () => {
			const manager = makeManager()
			vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([manager] as never)
			manager.setAutoEnableDefault.mockRejectedValue(new Error("persist failed"))
			const h = setup({ manager })

			await expect(dispatch(h.provider, msg("setAutoEnableDefault", { bool: true }))).resolves.toBe(true)

			expect(h.log).toHaveBeenCalledWith("Error setting auto-enable default: persist failed")
		})
	})

	// -----------------------------------------------------------------------

	describe("clearIndexData（不変条件2: 消える範囲）", () => {
		it("【不変条件】クリアは現在ワークスペースの manager 1 つにしか及ばない", async () => {
			const current = makeManager()
			const otherA = makeManager()
			const otherB = makeManager()
			// 他ワークスペースの manager も生存している状況。
			vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([current, otherA, otherB] as never)
			const h = setup({ manager: current })

			await dispatch(h.provider, msg("clearIndexData"))

			expect(current.clearIndexData).toHaveBeenCalledOnce()
			expect(otherA.clearIndexData).not.toHaveBeenCalled()
			expect(otherB.clearIndexData).not.toHaveBeenCalled()
			expect(h.posted()).toEqual([{ type: "indexCleared", values: { success: true } }])
		})

		it("【不変条件】ワークスペース未オープンなら 1 件も消さずに失敗を返す", async () => {
			const otherA = makeManager()
			const otherB = makeManager()
			vi.mocked(CodeIndexManager.getAllInstances).mockReturnValue([otherA, otherB] as never)
			const h = setup({ manager: undefined })

			await dispatch(h.provider, msg("clearIndexData"))

			expect(otherA.clearIndexData).not.toHaveBeenCalled()
			expect(otherB.clearIndexData).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledWith("Cannot clear index data: No workspace folder open")
			expect(h.posted()).toEqual([
				{
					type: "indexCleared",
					values: { success: false, error: "embeddings:orchestrator.indexingRequiresWorkspace" },
				},
			])
		})

		it("クリアに失敗したら理由付きで success:false を返す", async () => {
			const manager = makeManager()
			manager.clearIndexData.mockRejectedValue(new Error("collection locked"))
			const h = setup({ manager })

			await expect(dispatch(h.provider, msg("clearIndexData"))).resolves.toBe(true)

			expect(h.log).toHaveBeenCalledWith("Error clearing index data: collection locked")
			expect(h.posted()).toEqual([
				{ type: "indexCleared", values: { success: false, error: "collection locked" } },
			])
		})

		it("Error でない値が投げられても String 化して返す", async () => {
			const manager = makeManager()
			manager.clearIndexData.mockRejectedValue({ code: "EBUSY" })
			const h = setup({ manager })

			await dispatch(h.provider, msg("clearIndexData"))

			expect(h.posted()).toEqual([{ type: "indexCleared", values: { success: false, error: "[object Object]" } }])
		})
	})
})
