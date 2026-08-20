// npx vitest run core/webview/__tests__/apiConfigMessageHandlers.spec.ts
//
// apiConfigMessageHandlers は webview からの操作で API 設定プロファイル
// （API キーを含む）を作成・改名・削除し、workspaceState / globalState を書き換える。
// 消えたプロファイルは元に戻せないので、行数ではなく次を不変条件として固定する。
//
//   1. 書き込みが意図したキーにだけ起きること
//      （workspaceState / contextProxy に想定外のキーが増えない）
//   2. 保存に失敗したときに既存の設定（listApiConfigMeta / ピン留め）が壊れないこと
//   4. プロファイル切り替え（rename / load / delete）で既存プロファイルが黙って消えないこと
//
// ProviderSettingsManager は本物の CRUD 意味論（saveConfig は同名を上書き、
// deleteConfig は存在しなければ throw）を写したフェイクを使う。
// スパイだけだと「消えた／上書きされた」が観測できないため。

import type { ProviderSettings, ProviderSettingsEntry, WebviewMessage } from "@openai-agent/types"

import { describe, it, expect, vi, beforeEach } from "vitest"

import { apiConfigMessageHandlers } from "../apiConfigMessageHandlers"
import type { WebviewMessageHost } from "../webviewMessageHost"

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

const { showErrorMessageMock, showInformationMessageMock, testOpenAiConnectionMock } = vi.hoisted(() => ({
	showErrorMessageMock: vi.fn(),
	showInformationMessageMock: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
	testOpenAiConnectionMock: vi.fn(async (..._args: unknown[]) => ({ success: true, message: "ok" }) as unknown),
}))

vi.mock("vscode", () => ({
	window: { showErrorMessage: showErrorMessageMock, showInformationMessage: showInformationMessageMock },
}))

// t はキーをそのまま返す。文言ではなく「どのキーが使われたか」を見たいため。
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

vi.mock("../../../api/providers/openai", () => ({ testOpenAiConnection: testOpenAiConnectionMock }))

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

const YES = "common:answers.yes"

const config = (id: string): ProviderSettings => ({ apiProvider: "openai", id }) as unknown as ProviderSettings

/**
 * JSON 化できない値（自己参照）。
 * String() したときだけ中身が分かるようにして、どちらの経路を通ったか判別できるようにする。
 */
const circularFailure = (): Record<string, unknown> => {
	const error: Record<string, unknown> = { toString: () => "circular-failure" }
	error.self = error
	return error
}

/**
 * catch へ流れてくる値のバリエーション。throw されるのは Error とは限らない。
 * `expected` は provider.log に残るべき手がかり。
 */
const throwableCases: Array<{ label: string; thrown: unknown; expected: string }> = [
	{ label: "null", thrown: null, expected: "null" },
	{ label: "undefined", thrown: undefined, expected: "undefined" },
	{ label: "文字列", thrown: "string-failure", expected: "string-failure" },
	{ label: "Error", thrown: new Error("delete exploded"), expected: "delete exploded" },
	{ label: "循環参照オブジェクト", thrown: circularFailure(), expected: "circular-failure" },
]

interface SetupOptions {
	/** 初期プロファイル（名前 → 設定）。 */
	profiles?: Record<string, ProviderSettings>
	/** contextProxy.getValue の戻り値。 */
	storedValues?: Record<string, unknown>
}

/**
 * ProviderSettingsManager のフェイク。
 * 本物と同じく「同名 saveConfig は上書き」「存在しない deleteConfig は throw」を再現する。
 */
function makeProfileStore(initial: Record<string, ProviderSettings>) {
	const profiles = new Map<string, ProviderSettings>(Object.entries(initial))

	const listConfig = vi.fn(
		async (): Promise<ProviderSettingsEntry[]> =>
			[...profiles.entries()].map(([name, cfg]) => ({
				name,
				id: (cfg as { id?: string }).id ?? "",
			})) as ProviderSettingsEntry[],
	)

	const saveConfig = vi.fn(async (name: string, cfg: ProviderSettings): Promise<string> => {
		profiles.set(name, cfg)
		return (cfg as { id?: string }).id ?? "generated-id"
	})

	const getProfile = vi.fn(async (params: { name: string } | { id: string }) => {
		if ("name" in params) {
			const found = profiles.get(params.name)
			if (!found) {
				throw new Error(`Config with name '${params.name}' not found`)
			}
			return { ...found, name: params.name }
		}

		const entry = [...profiles.entries()].find(([, cfg]) => (cfg as { id?: string }).id === params.id)
		if (!entry) {
			throw new Error(`Config with ID '${params.id}' not found`)
		}
		return { ...entry[1], name: entry[0] }
	})

	const deleteConfig = vi.fn(async (name: string) => {
		if (!profiles.has(name)) {
			throw new Error(`Config '${name}' not found`)
		}
		profiles.delete(name)
	})

	return { profiles, listConfig, saveConfig, getProfile, deleteConfig }
}

function setup(options: SetupOptions = {}) {
	const store = makeProfileStore(options.profiles ?? {})

	// stateCache への代入を模した Map。`__proto__` を素の object に代入すると
	// テスト側のフェイクが自分で汚染されるため、あえて Map で受ける。
	const globalWrites = new Map<string, unknown>()
	const workspaceWrites = new Map<string, unknown>()

	const setValue = vi.fn(async (key: string, value: unknown) => {
		globalWrites.set(key, value)
	})
	const getValue = vi.fn((key: string): unknown => options.storedValues?.[key])
	const workspaceStateUpdate = vi.fn(async (key: string, value: unknown) => {
		workspaceWrites.set(key, value)
	})
	const postStateToWebview = vi.fn(async () => {})
	const postMessageToWebview = vi.fn(async () => undefined)
	const log = vi.fn()
	const activateProviderProfile = vi.fn(async (_args: { name: string } | { id: string }) => undefined)
	const upsertProviderProfile = vi.fn(async (_name: string, _settings: ProviderSettings) => undefined)

	const provider = {
		context: { workspaceState: { update: workspaceStateUpdate } },
		contextProxy: { getValue, setValue },
		providerSettingsManager: store,
		postStateToWebview,
		postMessageToWebview,
		log,
		activateProviderProfile,
		upsertProviderProfile,
	} as unknown as WebviewMessageHost

	return {
		provider,
		store,
		setValue,
		getValue,
		workspaceStateUpdate,
		postStateToWebview,
		postMessageToWebview,
		log,
		activateProviderProfile,
		upsertProviderProfile,
		globalWrites,
		workspaceWrites,
		/** globalState へ書かれたキーを呼ばれた順に全件。 */
		globalKeys: () => setValue.mock.calls.map((c) => c[0] as string),
		/** workspaceState へ書かれたキーを呼ばれた順に全件。 */
		workspaceKeys: () => workspaceStateUpdate.mock.calls.map((c) => c[0] as string),
		/** 現在残っているプロファイル名（順不同比較用にソート）。 */
		profileNames: () => [...store.profiles.keys()].sort(),
	}
}

const call = (type: WebviewMessage["type"], provider: WebviewMessageHost, message: Partial<WebviewMessage> = {}) =>
	apiConfigMessageHandlers[type]!(provider, { type, ...message } as WebviewMessage)

beforeEach(() => {
	vi.clearAllMocks()
	showInformationMessageMock.mockImplementation(async () => undefined)
	testOpenAiConnectionMock.mockImplementation(async () => ({ success: true, message: "ok" }))
})

// ---------------------------------------------------------------------------

describe("apiConfigMessageHandlers", () => {
	describe("testApiConnection", () => {
		it("values をそのまま接続テストへ渡し、結果を webview へ返す", async () => {
			const h = setup()
			testOpenAiConnectionMock.mockResolvedValue({ success: true, message: "接続成功" })

			await call("testApiConnection", h.provider, {
				values: {
					baseUrl: "https://example.test/v1",
					apiKey: "sk-test",
					openAiHeaders: { "X-A": "1" },
					modelId: "gpt-4o-mini",
					useAzure: true,
					azureApiVersion: "2024-08-01-preview",
					openAiProxyMode: "custom",
					openAiProxyUrl: "socks5://127.0.0.1:1080",
				},
			})

			expect(testOpenAiConnectionMock).toHaveBeenCalledExactlyOnceWith(
				"https://example.test/v1",
				"sk-test",
				{ "X-A": "1" },
				"gpt-4o-mini",
				true,
				"2024-08-01-preview",
				// 接続テストは本番と同じ経路で叩かないと相性確認にならないので proxy 指定も渡す。
				{ mode: "custom", url: "socks5://127.0.0.1:1080" },
			)
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "apiConnectionTest",
				success: true,
				text: "接続成功",
				values: undefined,
			})
			expect(h.log).not.toHaveBeenCalled()
			// 接続テストは設定を一切書き換えない。
			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.workspaceStateUpdate).not.toHaveBeenCalled()
		})

		it("diagnostics があれば Output Channel にも記録し webview へも渡す", async () => {
			const h = setup()
			const diagnostics = { humanReadable: "診断ブロック", steps: [] }
			testOpenAiConnectionMock.mockResolvedValue({ success: false, message: "失敗", diagnostics })

			await call("testApiConnection", h.provider, { values: { baseUrl: "https://example.test/v1" } })

			expect(h.log).toHaveBeenCalledExactlyOnceWith("診断ブロック")
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "apiConnectionTest",
				success: false,
				text: "失敗",
				values: { diagnostics },
			})
		})

		it("values が無くても undefined で呼ぶ（proxy 指定は空のまま）", async () => {
			const h = setup()

			await call("testApiConnection", h.provider, {})

			expect(testOpenAiConnectionMock).toHaveBeenCalledExactlyOnceWith(
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				// 未指定は継承扱い。解決側で inherit と同じ経路に落ちる。
				{ mode: undefined, url: undefined },
			)
		})

		it("message 自体が無くても落ちない（オプショナルチェーン経路）", async () => {
			const h = setup()

			await apiConfigMessageHandlers.testApiConnection!(h.provider, undefined as unknown as WebviewMessage)

			expect(testOpenAiConnectionMock).toHaveBeenCalledExactlyOnceWith(
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ mode: undefined, url: undefined },
			)
		})
	})

	describe("lockApiConfigAcrossModes（不変条件 1）", () => {
		it.each([
			{ label: "true", bool: true, expected: true },
			{ label: "false", bool: false, expected: false },
			{ label: "未指定", bool: undefined, expected: false },
		])("bool=$label のとき workspaceState の 1 キーだけを更新する", async ({ bool, expected }) => {
			const h = setup()

			await call("lockApiConfigAcrossModes", h.provider, { bool })

			expect(h.workspaceStateUpdate.mock.calls).toEqual([["lockApiConfigAcrossModes", expected]])
			// globalState 側やプロファイルには波及しない。
			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.store.saveConfig).not.toHaveBeenCalled()
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("workspaceState への書き込みが失敗したら state 送信まで進まない", async () => {
			const h = setup()
			h.workspaceStateUpdate.mockRejectedValue(new Error("workspaceState write failed"))

			await expect(call("lockApiConfigAcrossModes", h.provider, { bool: true })).rejects.toThrow(
				"workspaceState write failed",
			)

			expect(h.postStateToWebview).not.toHaveBeenCalled()
		})
	})

	describe("toggleApiConfigPin（不変条件 1 / 2）", () => {
		it("text が無ければ何も書かない", async () => {
			const h = setup({ storedValues: { pinnedApiConfigs: { a: true } } })

			await call("toggleApiConfigPin", h.provider, {})

			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postStateToWebview).not.toHaveBeenCalled()
		})

		it("未ピンなら追加し、既存のピンは残す", async () => {
			const h = setup({ storedValues: { pinnedApiConfigs: { keep: true } } })

			await call("toggleApiConfigPin", h.provider, { text: "added" })

			expect(h.globalKeys()).toEqual(["pinnedApiConfigs"])
			expect(h.globalWrites.get("pinnedApiConfigs")).toEqual({ keep: true, added: true })
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("ピン済みなら外し、他のピンは残す", async () => {
			const h = setup({ storedValues: { pinnedApiConfigs: { keep: true, target: true } } })

			await call("toggleApiConfigPin", h.provider, { text: "target" })

			expect(h.globalWrites.get("pinnedApiConfigs")).toEqual({ keep: true })
		})

		it("ピン留めが未保存でも空オブジェクトから開始する", async () => {
			const h = setup()

			await call("toggleApiConfigPin", h.provider, { text: "first" })

			expect(h.globalWrites.get("pinnedApiConfigs")).toEqual({ first: true })
		})

		it("元のオブジェクトを破壊せずコピーへ書く", async () => {
			const pinned = { keep: true }
			const h = setup({ storedValues: { pinnedApiConfigs: pinned } })

			await call("toggleApiConfigPin", h.provider, { text: "added" })

			expect(pinned).toEqual({ keep: true })
			expect(h.globalWrites.get("pinnedApiConfigs")).not.toBe(pinned)
		})

		// 【バグ】apiConfigMessageHandlers.ts:64 は素のプロパティアクセスで判定するため、
		// Object.prototype のメンバと同名のプロファイルは常に「ピン済み」と判定され、
		// 追加側の分岐へ入れない＝永久にピン留めできない（外す方の分岐で no-op になる）。
		it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
			"Object.prototype 由来の名前 %s はピン留めできない（現状の振る舞いの固定）",
			async (name) => {
				const h = setup({ storedValues: { pinnedApiConfigs: { keep: true } } })

				await call("toggleApiConfigPin", h.provider, { text: name })

				const written = h.globalWrites.get("pinnedApiConfigs") as Record<string, unknown>
				// 既存のピンは保たれるが、対象は増えていない。
				expect(written).toEqual({ keep: true })
				expect(Object.prototype.hasOwnProperty.call(written, name)).toBe(false)
				// プロトタイプ汚染も起きていない。
				expect(Object.getPrototypeOf(written)).toBe(Object.prototype)
				expect(({} as Record<string, unknown>).keep).toBeUndefined()
			},
		)

		it("保存済みの __proto__ ピンは（JSON 由来の own property なら）外せる", async () => {
			// globalState は JSON 復元されるため own property として現れうる。
			const pinned = JSON.parse('{"__proto__":true,"keep":true}')
			const h = setup({ storedValues: { pinnedApiConfigs: pinned } })

			await call("toggleApiConfigPin", h.provider, { text: "__proto__" })

			const written = h.globalWrites.get("pinnedApiConfigs") as Record<string, unknown>
			expect(Object.keys(written)).toEqual(["keep"])
			expect(Object.getPrototypeOf(written)).toBe(Object.prototype)
		})

		it("保存が失敗したら state 送信まで進まない", async () => {
			const h = setup({ storedValues: { pinnedApiConfigs: { keep: true } } })
			h.setValue.mockRejectedValue(new Error("globalState write failed"))

			await expect(call("toggleApiConfigPin", h.provider, { text: "added" })).rejects.toThrow(
				"globalState write failed",
			)

			expect(h.postStateToWebview).not.toHaveBeenCalled()
		})
	})

	describe("enhancementApiConfigId（不変条件 1）", () => {
		it.each([
			{ label: "ID 指定", text: "config-1" },
			{ label: "未指定（クリア）", text: undefined },
		])("$label のとき enhancementApiConfigId だけを書く", async ({ text }) => {
			const h = setup()

			await call("enhancementApiConfigId", h.provider, { text })

			expect(h.setValue.mock.calls).toEqual([["enhancementApiConfigId", text]])
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})
	})

	describe("saveApiConfiguration（不変条件 2）", () => {
		it.each([
			["text が無い", { apiConfiguration: config("id-1") }],
			["apiConfiguration が無い", { text: "profile" }],
			["両方無い", {}],
			["text が空文字", { text: "", apiConfiguration: config("id-1") }],
		])("%s なら保存しない", async (_label, message) => {
			const h = setup({ profiles: { existing: config("id-existing") } })

			await call("saveApiConfiguration", h.provider, message as Partial<WebviewMessage>)

			expect(h.store.saveConfig).not.toHaveBeenCalled()
			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["existing"])
		})

		it("保存すると一覧メタデータだけを更新する", async () => {
			const h = setup({ profiles: { existing: config("id-existing") } })

			await call("saveApiConfiguration", h.provider, { text: "added", apiConfiguration: config("id-added") })

			expect(h.store.saveConfig).toHaveBeenCalledExactlyOnceWith("added", config("id-added"))
			expect(h.profileNames()).toEqual(["added", "existing"])
			expect(h.globalKeys()).toEqual(["listApiConfigMeta"])
			expect(h.globalWrites.get("listApiConfigMeta")).toEqual([
				{ name: "existing", id: "id-existing" },
				{ name: "added", id: "id-added" },
			])
		})

		// 【不変条件 2】保存に失敗したら listApiConfigMeta は書き換えない。
		// ここで古いメタデータを潰すと、実体は残っているのに一覧から消えたプロファイルが出る。
		it("saveConfig が失敗したら listApiConfigMeta を書き換えずエラー表示する", async () => {
			const h = setup({ profiles: { existing: config("id-existing") } })
			h.store.saveConfig.mockRejectedValue(new Error("disk full"))

			await call("saveApiConfiguration", h.provider, { text: "added", apiConfiguration: config("id-added") })

			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["existing"])
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.save_api_config")
			expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("disk full"))
		})

		it("listConfig が失敗した場合も listApiConfigMeta は書き換えない", async () => {
			const h = setup({ profiles: { existing: config("id-existing") } })
			h.store.listConfig.mockRejectedValue(new Error("list failed"))

			await call("saveApiConfiguration", h.provider, { text: "added", apiConfiguration: config("id-added") })

			expect(h.setValue).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.save_api_config")
		})
	})

	describe("upsertApiConfiguration", () => {
		it("text と apiConfiguration が揃っていれば委譲する", async () => {
			const h = setup()

			await call("upsertApiConfiguration", h.provider, { text: "profile", apiConfiguration: config("id-1") })

			expect(h.upsertProviderProfile).toHaveBeenCalledExactlyOnceWith("profile", config("id-1"))
		})

		it.each([
			["text が無い", { apiConfiguration: config("id-1") }],
			["apiConfiguration が無い", { text: "profile" }],
			["両方無い", {}],
		])("%s なら委譲しない", async (_label, message) => {
			const h = setup()

			await call("upsertApiConfiguration", h.provider, message as Partial<WebviewMessage>)

			expect(h.upsertProviderProfile).not.toHaveBeenCalled()
		})
	})

	describe("renameApiConfiguration（不変条件 4）", () => {
		it.each([
			["values が無い", { apiConfiguration: config("id-1") }],
			["apiConfiguration が無い", { values: { oldName: "a", newName: "b" } }],
			["両方無い", {}],
		])("%s なら何も消さない", async (_label, message) => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })

			await call("renameApiConfiguration", h.provider, message as Partial<WebviewMessage>)

			expect(h.store.deleteConfig).not.toHaveBeenCalled()
			expect(h.store.saveConfig).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["a", "b"])
		})

		it("同名への改名は何もしない（自分自身を消さない）", async () => {
			const h = setup({ profiles: { a: config("id-a") } })

			await call("renameApiConfiguration", h.provider, {
				values: { oldName: "a", newName: "a" },
				apiConfiguration: config("id-a"),
			})

			expect(h.store.getProfile).not.toHaveBeenCalled()
			expect(h.store.deleteConfig).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["a"])
		})

		it("ID を引き継いで新名で保存し、旧名を消してから再アクティブ化する", async () => {
			const h = setup({ profiles: { old: config("id-old"), other: config("id-other") } })

			await call("renameApiConfiguration", h.provider, {
				values: { oldName: "old", newName: "new" },
				apiConfiguration: config("id-ignored"),
			})

			// 【不変条件】保存が先、削除が後。順序が逆だと途中失敗でプロファイルが消える。
			expect(h.store.saveConfig.mock.invocationCallOrder[0]).toBeLessThan(
				h.store.deleteConfig.mock.invocationCallOrder[0],
			)
			expect(h.store.saveConfig).toHaveBeenCalledExactlyOnceWith("new", { ...config("id-ignored"), id: "id-old" })
			expect(h.store.deleteConfig).toHaveBeenCalledExactlyOnceWith("old")
			expect(h.activateProviderProfile).toHaveBeenCalledExactlyOnceWith({ name: "new" })
			// 無関係な other は残り、件数も変わらない。
			expect(h.profileNames()).toEqual(["new", "other"])
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		// 【不変条件 4】改名先が既存なら何もしない。
		//
		// saveConfig は同名を無条件で上書きするので、newName の存在確認を省くと
		// 相手プロファイルの中身（API キーを含む）が黙って置き換わり、
		// 直後の deleteConfig(oldName) と合わせてプロファイルが 1 件失われる。
		// 確認ダイアログも取り消しも無い操作なので、名前が衝突した時点で止める。
		it("【不変条件】既存プロファイル名への改名は拒否し、相手も自分も無傷で残す", async () => {
			const h = setup({ profiles: { old: config("id-old"), victim: config("id-victim") } })

			await call("renameApiConfiguration", h.provider, {
				values: { oldName: "old", newName: "victim" },
				apiConfiguration: config("id-ignored"),
			})

			// 破壊的な操作は 1 つも走らない。
			expect(h.store.saveConfig).not.toHaveBeenCalled()
			expect(h.store.deleteConfig).not.toHaveBeenCalled()
			expect(h.activateProviderProfile).not.toHaveBeenCalled()
			// 2 件とも残り、中身も元のまま。
			expect(h.profileNames()).toEqual(["old", "victim"])
			expect(h.store.profiles.get("victim")).toEqual(config("id-victim"))
			expect(h.store.profiles.get("old")).toEqual(config("id-old"))
			// 黙って諦めず、ユーザーにもログにも理由を残す。
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.rename_api_config")
			expect(h.log).toHaveBeenCalledExactlyOnceWith(
				'Refusing to rename api configuration: "victim" already exists',
			)
		})

		it("旧プロファイルが見つからなければ何も消さずエラー表示する", async () => {
			const h = setup({ profiles: { a: config("id-a") } })

			await call("renameApiConfiguration", h.provider, {
				values: { oldName: "missing", newName: "new" },
				apiConfiguration: config("id-1"),
			})

			expect(h.store.saveConfig).not.toHaveBeenCalled()
			expect(h.store.deleteConfig).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["a"])
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.rename_api_config")
		})

		// 【不変条件 4】保存に失敗した時点で止まり、旧プロファイルは残る。
		it("新名の保存が失敗しても旧プロファイルは消えない", async () => {
			const h = setup({ profiles: { old: config("id-old") } })
			h.store.saveConfig.mockRejectedValue(new Error("save failed"))

			await call("renameApiConfiguration", h.provider, {
				values: { oldName: "old", newName: "new" },
				apiConfiguration: config("id-1"),
			})

			expect(h.store.deleteConfig).not.toHaveBeenCalled()
			expect(h.activateProviderProfile).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["old"])
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.rename_api_config")
		})

		// 【バグ】削除だけ失敗すると旧名・新名の両方が残り、以後 2 件に見える（自動修復は無い）。
		it("旧名の削除に失敗すると新旧どちらも残り、アクティブ化もされない", async () => {
			const h = setup({ profiles: { old: config("id-old") } })
			h.store.deleteConfig.mockRejectedValue(new Error("delete failed"))

			await call("renameApiConfiguration", h.provider, {
				values: { oldName: "old", newName: "new" },
				apiConfiguration: config("id-1"),
			})

			expect(h.profileNames()).toEqual(["new", "old"])
			expect(h.activateProviderProfile).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.rename_api_config")
		})

		it("再アクティブ化の失敗もエラー表示に落ちる（改名自体は完了済み）", async () => {
			const h = setup({ profiles: { old: config("id-old") } })
			h.activateProviderProfile.mockRejectedValue(new Error("activate failed"))

			await call("renameApiConfiguration", h.provider, {
				values: { oldName: "old", newName: "new" },
				apiConfiguration: config("id-1"),
			})

			expect(h.profileNames()).toEqual(["new"])
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.rename_api_config")
		})
	})

	describe("loadApiConfiguration / loadApiConfigurationById（不変条件 4）", () => {
		it.each([
			["loadApiConfiguration", "loadApiConfiguration"],
			["loadApiConfigurationById", "loadApiConfigurationById"],
		] as const)("%s は text が無ければ何もしない", async (_label, type) => {
			const h = setup({ profiles: { a: config("id-a") } })

			await call(type, h.provider, {})

			expect(h.activateProviderProfile).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["a"])
		})

		it("名前でアクティブ化する", async () => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })

			await call("loadApiConfiguration", h.provider, { text: "b" })

			expect(h.activateProviderProfile).toHaveBeenCalledExactlyOnceWith({ name: "b" })
			// 切り替えでプロファイルは 1 件も消えない。
			expect(h.profileNames()).toEqual(["a", "b"])
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it("ID でアクティブ化する", async () => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })

			await call("loadApiConfigurationById", h.provider, { text: "id-b" })

			expect(h.activateProviderProfile).toHaveBeenCalledExactlyOnceWith({ id: "id-b" })
			expect(h.profileNames()).toEqual(["a", "b"])
		})

		it.each([
			["loadApiConfiguration", "loadApiConfiguration"],
			["loadApiConfigurationById", "loadApiConfigurationById"],
		] as const)("%s はアクティブ化に失敗してもプロファイルを消さない", async (_label, type) => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })
			h.activateProviderProfile.mockRejectedValue(new Error("activate failed"))

			await call(type, h.provider, { text: "b" })

			expect(h.profileNames()).toEqual(["a", "b"])
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.load_api_config")
			expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("activate failed"))
		})
	})

	describe("deleteApiConfiguration（不変条件 4）", () => {
		it("text が無ければ確認もせず何もしない", async () => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })

			await call("deleteApiConfiguration", h.provider, {})

			expect(showInformationMessageMock).not.toHaveBeenCalled()
			expect(h.store.deleteConfig).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["a", "b"])
		})

		// 【不変条件 4】確認ダイアログで「はい」以外なら 1 件も消さない。
		it.each([
			["ダイアログを閉じた（undefined）", undefined],
			["別の選択肢", "common:answers.no"],
			["空文字", ""],
		])("%s のときは削除しない", async (_label, answer) => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })
			showInformationMessageMock.mockResolvedValue(answer)

			await call("deleteApiConfiguration", h.provider, { text: "a" })

			expect(h.store.deleteConfig).not.toHaveBeenCalled()
			expect(h.activateProviderProfile).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["a", "b"])
		})

		it("承認されたら削除して別プロファイルへ切り替える", async () => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b"), c: config("id-c") } })
			showInformationMessageMock.mockResolvedValue(YES)

			await call("deleteApiConfiguration", h.provider, { text: "a" })

			expect(showInformationMessageMock).toHaveBeenCalledExactlyOnceWith(
				"common:confirmation.delete_config_profile",
				{ modal: true },
				YES,
			)
			expect(h.store.deleteConfig).toHaveBeenCalledExactlyOnceWith("a")
			// 消えるのは指定した 1 件だけ。切り替え先は残った先頭。
			expect(h.profileNames()).toEqual(["b", "c"])
			expect(h.activateProviderProfile).toHaveBeenCalledExactlyOnceWith({ name: "b" })
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		// 【不変条件 4】切り替え先が無い＝最後の 1 件なら削除しない。
		it("最後の 1 件は削除せずエラー表示する", async () => {
			const h = setup({ profiles: { only: config("id-only") } })
			showInformationMessageMock.mockResolvedValue(YES)

			await call("deleteApiConfiguration", h.provider, { text: "only" })

			expect(h.store.deleteConfig).not.toHaveBeenCalled()
			expect(h.profileNames()).toEqual(["only"])
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.delete_api_config")
		})

		it("存在しない名前を指定した場合も、他のプロファイルは消えない", async () => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })
			showInformationMessageMock.mockResolvedValue(YES)

			await call("deleteApiConfiguration", h.provider, { text: "missing" })

			// 切り替え先は見つかるので削除まで進むが、フェイクは本物と同じく throw する。
			expect(h.store.deleteConfig).toHaveBeenCalledExactlyOnceWith("missing")
			expect(h.profileNames()).toEqual(["a", "b"])
			expect(h.activateProviderProfile).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.delete_api_config")
		})

		it("削除に失敗したら切り替えもせずエラー表示する", async () => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })
			showInformationMessageMock.mockResolvedValue(YES)
			h.store.deleteConfig.mockRejectedValue(new Error("delete failed"))

			await call("deleteApiConfiguration", h.provider, { text: "a" })

			expect(h.profileNames()).toEqual(["a", "b"])
			expect(h.activateProviderProfile).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.delete_api_config")
			expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("delete failed"))
		})

		it("一覧取得が失敗すると確認済みでも削除されない（例外がそのまま伝播する）", async () => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })
			showInformationMessageMock.mockResolvedValue(YES)
			h.store.listConfig.mockRejectedValue(new Error("list failed"))

			// 【バグ】listConfig は try の外にあるため（apiConfigMessageHandlers.ts:174）、
			// ここでの失敗はエラー表示もログも無いまま呼び出し側へ抜ける。
			await expect(call("deleteApiConfiguration", h.provider, { text: "a" })).rejects.toThrow("list failed")

			expect(h.profileNames()).toEqual(["a", "b"])
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		// 【不変条件】catch の中でさらに落ちない（formatError は何を渡されても文字列を返す）。
		//
		// formatError は catch した値を整形する全ハンドラ共通の経路。ここが投げると
		// エラー表示にもログにも到達しないまま、本来の失敗原因とは無関係な例外
		// （TypeError）が呼び出し側へ抜ける。失敗が「別の失敗」に化けて原因が消える。
		// 投げられる値は Error とは限らない（null / undefined / 文字列 / 循環参照）。
		it.each(throwableCases)(
			"【不変条件】$label が投げられてもハンドラは落ちず、ログとエラー表示に到達する",
			async ({ thrown, expected }) => {
				const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })
				showInformationMessageMock.mockResolvedValue(YES)
				h.store.deleteConfig.mockRejectedValue(thrown)

				await expect(call("deleteApiConfiguration", h.provider, { text: "a" })).resolves.toBeUndefined()

				expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(expected))
				expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.delete_api_config")
				// 失敗したので切り替えもせず、プロファイルも 1 件も消えない。
				expect(h.activateProviderProfile).not.toHaveBeenCalled()
				expect(h.profileNames()).toEqual(["a", "b"])
			},
		)
	})

	describe("getListApiConfiguration（不変条件 2）", () => {
		it("一覧を保存して webview へ返す", async () => {
			const h = setup({ profiles: { a: config("id-a"), b: config("id-b") } })

			await call("getListApiConfiguration", h.provider, {})

			const expected = [
				{ name: "a", id: "id-a" },
				{ name: "b", id: "id-b" },
			]
			expect(h.globalKeys()).toEqual(["listApiConfigMeta"])
			expect(h.globalWrites.get("listApiConfigMeta")).toEqual(expected)
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "listApiConfig",
				listApiConfig: expected,
			})
		})

		it("一覧取得に失敗したら listApiConfigMeta を書き換えない", async () => {
			const h = setup({ profiles: { a: config("id-a") } })
			h.store.listConfig.mockRejectedValue(new Error("list failed"))

			await call("getListApiConfiguration", h.provider, {})

			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.list_api_config")
			expect(h.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("list failed"))
		})

		it("保存に失敗した場合も webview へは古い一覧を送らない", async () => {
			const h = setup({ profiles: { a: config("id-a") } })
			h.setValue.mockRejectedValue(new Error("globalState write failed"))

			await call("getListApiConfiguration", h.provider, {})

			expect(h.postMessageToWebview).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith("common:errors.list_api_config")
		})
	})
})
