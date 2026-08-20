// npx vitest run core/webview/__tests__/settingsMessageHandlers.spec.ts
//
// settingsMessageHandlers は webview から来たメッセージで
//   - グローバル state（contextProxy）
//   - VSCode のユーザー設定（vscode.workspace.getConfiguration().update）
// を書き換える。webview は拡張の中で最も「外」に近い面なので、
// 「どのキーが書かれるか」そのものを不変条件として固定する。
//
//   1. 設定の書き込みが、意図したキーにだけ起きること
//      （未知のキー・空キー・__proto__ / constructor を渡しても想定外のキーが書かれない）
//   2. 保存に失敗したときに既存の設定が壊れないこと
//   3. VSCode 設定の読み書きはどちらもホワイトリスト外を一切通さないこと
//
// を、update / setValue に渡った引数の「全件」で検証する。

import type { AgentSettings, WebviewMessage } from "@openai-agent/types"

import { describe, it, expect, vi, beforeEach } from "vitest"

import { Package } from "../../../shared/package"
import { experimentDefault } from "../../../shared/experiments"

import { settingsMessageHandlers } from "../settingsMessageHandlers"
import type { WebviewMessageHost } from "../webviewMessageHost"

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

const {
	getConfigurationMock,
	configUpdateMock,
	configGetMock,
	showErrorMessageMock,
	changeLanguageMock,
	terminalMock,
	importSettingsWithFeedbackMock,
	exportSettingsMock,
} = vi.hoisted(() => ({
	getConfigurationMock: vi.fn(),
	configUpdateMock: vi.fn(async (..._args: unknown[]) => undefined),
	configGetMock: vi.fn((..._args: unknown[]): unknown => undefined),
	showErrorMessageMock: vi.fn(),
	changeLanguageMock: vi.fn(),
	terminalMock: {
		setShellIntegrationTimeout: vi.fn(),
		setShellIntegrationDisabled: vi.fn(),
		setCommandDelay: vi.fn(),
		setTerminalZdotdir: vi.fn(),
		setExecaShellPath: vi.fn(),
	},
	importSettingsWithFeedbackMock: vi.fn(async () => undefined),
	exportSettingsMock: vi.fn(async () => undefined),
}))

// ConfigurationTarget.Global は数値の enum。実物と同じ 1 を使う。
vi.mock("vscode", () => ({
	workspace: { getConfiguration: getConfigurationMock },
	window: { showErrorMessage: showErrorMessageMock },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}))

vi.mock("../../../i18n", () => ({ changeLanguage: changeLanguageMock }))

vi.mock("../../../integrations/terminal/Terminal", () => ({ Terminal: terminalMock }))

vi.mock("../../config/importExport", () => ({
	importSettingsWithFeedback: importSettingsWithFeedbackMock,
	exportSettings: exportSettingsMock,
}))

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/** getConfiguration に渡ったセクション名（引数無しなら undefined）を全件返す。 */
const configurationSections = (): unknown[] => getConfigurationMock.mock.calls.map((call) => call[0])

/** update に渡った引数を「セクション付き」で全件返す。どこに何が書かれたかの全量。 */
const configUpdates = (): Array<{ section: unknown; key: unknown; value: unknown; target: unknown }> =>
	configUpdateMock.mock.calls.map((call, index) => ({
		section: getConfigurationMock.mock.calls[index]?.[0],
		key: call[0],
		value: call[1],
		target: call[2],
	}))

interface FakeMcpHub {
	handleMcpEnabledChange: ReturnType<typeof vi.fn>
}

interface SetupOptions {
	/** contextProxy.getValue の戻り値（キー単位）。 */
	storedValues?: Record<string, unknown>
	/** getMcpHub() の戻り値。既定は undefined（未初期化）。 */
	mcpHub?: FakeMcpHub
	/** getCurrentTask() の戻り値。 */
	currentTask?: { handleTerminalOperation: ReturnType<typeof vi.fn> }
}

function setup(options: SetupOptions = {}) {
	// 書かれたキーと値の記録。`__proto__` を素の object に代入するとこの記録自体が
	// 汚染されて検査に使えなくなるため、記録側はあえて Map で受ける。
	const written = new Map<string, unknown>()

	// ContextProxy の stateCache は素のオブジェクト（core/config/ContextProxy.ts の
	// `this.stateCache = {}` と `this.stateCache[key] = value`）。
	// `__proto__` が setValue まで届くとプロトタイプごと差し替わるので、
	// 「汚染されていないこと」を検査できるようにその形をそのまま再現する。
	const stateCache: Record<string, unknown> = {}

	const setValue = vi.fn(async (key: string, value: unknown) => {
		written.set(key, value)
		stateCache[key] = value
	})
	const getValue = vi.fn((key: string): unknown => options.storedValues?.[key])
	const log = vi.fn()
	const postStateToWebview = vi.fn(async () => {})
	const postMessageToWebview = vi.fn(async () => undefined)
	const updateCustomInstructions = vi.fn(async () => undefined)
	const resetState = vi.fn(async () => {})
	const getCurrentTask = vi.fn(() => options.currentTask)
	const getMcpHub = vi.fn(() => options.mcpHub)
	const providerSettingsManager = { marker: "providerSettingsManager" }
	const customModesManager = { marker: "customModesManager" }

	const provider = {
		contextProxy: { getValue, setValue },
		postStateToWebview,
		postMessageToWebview,
		updateCustomInstructions,
		resetState,
		getCurrentTask,
		getMcpHub,
		providerSettingsManager,
		customModesManager,
		log,
	} as unknown as WebviewMessageHost

	return {
		provider,
		setValue,
		getValue,
		postStateToWebview,
		postMessageToWebview,
		updateCustomInstructions,
		resetState,
		getCurrentTask,
		getMcpHub,
		providerSettingsManager,
		customModesManager,
		log,
		/** ContextProxy の stateCache を模した素のオブジェクト。 */
		stateCache,
		/** contextProxy へ書かれたキー → 値。 */
		written,
		/** contextProxy へ書かれたキーを呼ばれた順に全件。 */
		writtenKeys: () => setValue.mock.calls.map((call) => call[0] as string),
		/** provider.log に渡ったメッセージを呼ばれた順に全件。 */
		logMessages: () => log.mock.calls.map((call) => call[0] as string),
	}
}

/** updateSettings を呼ぶ（型の合わない検証用ペイロードも通せるようにキャストを 1 箇所に閉じ込める）。 */
const updateSettings = (provider: WebviewMessageHost, updatedSettings: unknown): Promise<void> =>
	settingsMessageHandlers.updateSettings!(provider, {
		type: "updateSettings",
		updatedSettings: updatedSettings as AgentSettings,
	})

/** 任意のメッセージでハンドラを呼ぶ。 */
const call = (type: WebviewMessage["type"], provider: WebviewMessageHost, message: Partial<WebviewMessage> = {}) =>
	settingsMessageHandlers[type]!(provider, { type, ...message } as WebviewMessage)

/**
 * 「VSCode 設定へは 1 件も書かれていない」ことの検査。
 *
 * updateVSCodeSetting のホワイトリスト検証で最も大事な検査なので、
 * `not.toHaveBeenCalledWith` ではなく呼び出し全件が空であることを見る。
 */
const expectNoVSCodeSettingWrite = (): void => {
	expect(configUpdates()).toEqual([])
}

beforeEach(() => {
	vi.clearAllMocks()
	getConfigurationMock.mockImplementation(() => ({ update: configUpdateMock, get: configGetMock }))
	configUpdateMock.mockImplementation(async () => undefined)
	configGetMock.mockImplementation(() => undefined)
})

// ---------------------------------------------------------------------------

describe("settingsMessageHandlers", () => {
	describe("updateSettings: 書き込み先キー（不変条件 1）", () => {
		it("渡したキーだけが contextProxy に書かれ、VSCode 設定には触らない", async () => {
			const h = setup()

			await updateSettings(h.provider, { alwaysAllowReadOnly: true, diagnosticsEnabled: false })

			expect(h.writtenKeys()).toEqual(["alwaysAllowReadOnly", "diagnosticsEnabled"])
			expect([...h.written.entries()]).toEqual([
				["alwaysAllowReadOnly", true],
				["diagnosticsEnabled", false],
			])
			// contextProxy 以外（VSCode ユーザー設定）には 1 件も書かれない。
			expectNoVSCodeSettingWrite()
			expect(getConfigurationMock).not.toHaveBeenCalled()
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("updatedSettings が無ければ何も書かず state 送信もしない", async () => {
			const h = setup()

			await updateSettings(h.provider, undefined)

			expect(h.setValue).not.toHaveBeenCalled()
			expectNoVSCodeSettingWrite()
			expect(h.postStateToWebview).not.toHaveBeenCalled()
		})

		it("updatedSettings が空オブジェクトなら書き込みゼロで state だけ送る", async () => {
			const h = setup()

			await updateSettings(h.provider, {})

			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		// 【不変条件】プロトタイプ汚染を狙うキーは contextProxy.setValue まで届かない。
		//
		// ハンドラが受け取ったキーを素通しすると `key as keyof AgentSettings` のキャストで
		// 型チェックを抜け、ContextProxy の stateCache（素のオブジェクト）に任意のキーが書ける。
		// `__proto__` にオブジェクトを入れられると stateCache のプロトタイプごと差し替わり、
		// 以後 getValue が「保存した覚えのない値」を返すようになる。
		it("【不変条件】__proto__ / constructor / prototype は setValue へ届かず stateCache も汚れない", async () => {
			const h = setup()
			// オブジェクトリテラルの `__proto__:` は代入にならないので JSON 経由で own property を作る。
			const payload = JSON.parse(
				'{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"prototype":{"polluted":"yes"}}',
			)

			await updateSettings(h.provider, payload)

			// 1 件も contextProxy まで到達しない。
			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.writtenKeys()).toEqual([])
			// stateCache のプロトタイプは差し替わらず、キーも 1 つも増えていない。
			expect(Object.getPrototypeOf(h.stateCache)).toBe(Object.prototype)
			expect(Object.keys(h.stateCache)).toEqual([])
			expect(h.stateCache.polluted).toBeUndefined()
			// グローバルも汚れていない。
			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(Object.prototype).not.toHaveProperty("polluted")
			expect(({} as Record<string, unknown>).prototype).toBeUndefined()
			// VSCode 設定側にも波及しない。
			expectNoVSCodeSettingWrite()
			// 黙って捨てず、落としたキーは全件ログに残る。
			expect(h.logMessages()).toEqual([
				'updateSettings: ignoring unknown setting key "__proto__"',
				'updateSettings: ignoring unknown setting key "constructor"',
				'updateSettings: ignoring unknown setting key "prototype"',
			])
			// 弾いたあとも state の再送までは進む。
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		// 【不変条件】空文字は AgentSettings のキーではないので globalState にも作らせない。
		it("【不変条件】空文字キーは setValue へ届かない", async () => {
			const h = setup()

			await updateSettings(h.provider, { "": "x" })

			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.writtenKeys()).toEqual([])
			expect(h.logMessages()).toEqual(['updateSettings: ignoring unknown setting key ""'])
			expectNoVSCodeSettingWrite()
		})

		// 【不変条件】未知のキーは contextProxy にも VSCode 設定にも 1 件も書かれない。
		// 同じメッセージに混ざった既知のキーの保存は止めない（1 件の不正で全体を捨てない）。
		it("【不変条件】未知のキーは弾き、同じメッセージ内の既知のキーだけを保存する", async () => {
			const h = setup()

			await updateSettings(h.provider, {
				"terminal.integrated.inheritEnv": false,
				"git.path": "/tmp/evil",
				totallyUnknownKey: 1,
				diagnosticsEnabled: true,
			})

			expect(h.writtenKeys()).toEqual(["diagnosticsEnabled"])
			expect(h.written.get("diagnosticsEnabled")).toBe(true)
			expect(h.logMessages()).toEqual([
				'updateSettings: ignoring unknown setting key "terminal.integrated.inheritEnv"',
				'updateSettings: ignoring unknown setting key "git.path"',
				'updateSettings: ignoring unknown setting key "totallyUnknownKey"',
			])
			// VSCode ユーザー設定は 1 件も更新されない。
			expectNoVSCodeSettingWrite()
		})

		// 【不変条件】既知のキーは弾かれない。SECRET_STATE_KEYS 側（GlobalState には
		// 含まれないキー）も通ることを押さえる。ここが落ちると API キーが保存できなくなる。
		it("【不変条件】シークレットキー（openAiApiKey）は既知のキーとして保存される", async () => {
			const h = setup()

			await updateSettings(h.provider, { openAiApiKey: "sk-test" })

			expect(h.writtenKeys()).toEqual(["openAiApiKey"])
			expect(h.written.get("openAiApiKey")).toBe("sk-test")
			expect(h.logMessages()).toEqual([])
			expectNoVSCodeSettingWrite()
		})
	})

	describe("updateSettings: キーごとの副作用", () => {
		it("language は i18n へ反映し、未指定なら en を保存する", async () => {
			const h = setup()

			await updateSettings(h.provider, { language: "ja" })
			expect(changeLanguageMock).toHaveBeenCalledExactlyOnceWith("ja")
			expect(h.written.get("language")).toBe("ja")

			vi.clearAllMocks()
			const fallback = setup()
			await updateSettings(fallback.provider, { language: undefined })
			expect(changeLanguageMock).toHaveBeenCalledExactlyOnceWith("en")
			expect(fallback.written.get("language")).toBe("en")
		})

		it.each(["allowedCommands", "deniedCommands"])(
			"%s は文字列だけに正規化して contextProxy と VSCode 設定の両方へ書く",
			async (key) => {
				const h = setup()

				await updateSettings(h.provider, {
					[key]: ["npm test", "", "   ", 42, null, undefined, { cmd: "rm" }, "git status"],
				})

				const expected = ["npm test", "git status"]
				expect(h.written.get(key)).toEqual(expected)
				// 書き込み先は拡張自身のセクション（Package.name）配下の同名キーだけ。
				expect(configUpdates()).toEqual([{ section: Package.name, key, value: expected, target: 1 }])
			},
		)

		// 【不変条件 2】壊れた値で許可/拒否リストを全消ししない。
		//
		// 配列でない値が 1 通届いただけで拒否リストが空になると、以後そのリストで
		// 止めていたコマンドが全て素通りする。しかも「明示的に空にした」のと区別が
		// つかないので、消えたことに誰も気づけない。保存も VSCode 設定の更新も行わず、
		// 既存の値をそのまま残す。
		const brokenCommandLists: Array<{ label: string; value: unknown }> = [
			{ label: "文字列", value: "npm test" },
			{ label: "undefined", value: undefined },
			{ label: "null", value: null },
			{ label: "数値", value: 42 },
			{ label: "配列風オブジェクト", value: { 0: "npm test", length: 1 } },
			{ label: "真偽値", value: true },
		]

		it.each(brokenCommandLists)(
			"【不変条件】allowedCommands が $label なら保存もせず既存値を残す",
			async ({ value }) => {
				const h = setup({ storedValues: { allowedCommands: ["npm test"] } })

				await updateSettings(h.provider, { allowedCommands: value, diagnosticsEnabled: true })

				// contextProxy へは書かない（同じメッセージ内の他キーの保存は止めない）。
				expect(h.writtenKeys()).toEqual(["diagnosticsEnabled"])
				// VSCode 設定側も触らない。getConfiguration すら呼ばない。
				expectNoVSCodeSettingWrite()
				expect(getConfigurationMock).not.toHaveBeenCalled()
				// スキップしても state の再送までは進む。
				expect(h.postStateToWebview).toHaveBeenCalledOnce()
			},
		)

		it.each(brokenCommandLists)(
			"【不変条件】deniedCommands が $label なら保存もせず既存値を残す",
			async ({ value }) => {
				const h = setup({ storedValues: { deniedCommands: ["rm -rf /"] } })

				await updateSettings(h.provider, { deniedCommands: value, diagnosticsEnabled: true })

				expect(h.writtenKeys()).toEqual(["diagnosticsEnabled"])
				expectNoVSCodeSettingWrite()
				expect(getConfigurationMock).not.toHaveBeenCalled()
			},
		)

		// 空配列は「壊れた値」ではなく「明示的に空にした」なので保存する。
		// ここまでスキップすると、リストを空に戻す操作が webview から実行できなくなる。
		it.each(["allowedCommands", "deniedCommands"])(
			"%s に空配列を渡したときは意図的なクリアとして保存する",
			async (key) => {
				const h = setup({ storedValues: { [key]: ["npm test"] } })

				await updateSettings(h.provider, { [key]: [] })

				expect(h.writtenKeys()).toEqual([key])
				expect(h.written.get(key)).toEqual([])
				expect(configUpdates()).toEqual([{ section: Package.name, key, value: [], target: 1 }])
			},
		)

		// 配列ではあるが中身が全て捨てられる場合も「配列が届いた」＝正規の空指定として扱う。
		it("文字列を 1 つも含まない配列は空配列として保存する", async () => {
			const h = setup({ storedValues: { allowedCommands: ["npm test"] } })

			await updateSettings(h.provider, { allowedCommands: [42, null, "  ", ""] })

			expect(h.written.get("allowedCommands")).toEqual([])
			expect(configUpdates()).toEqual([{ section: Package.name, key: "allowedCommands", value: [], target: 1 }])
		})

		// ターミナル系は「値があるときだけ Terminal へ反映」「保存は常に行う」という形。
		const terminalKeys: Array<{ key: string; setter: keyof typeof terminalMock; value: unknown }> = [
			{ key: "terminalShellIntegrationTimeout", setter: "setShellIntegrationTimeout", value: 5000 },
			{ key: "terminalShellIntegrationDisabled", setter: "setShellIntegrationDisabled", value: true },
			{ key: "terminalCommandDelay", setter: "setCommandDelay", value: 100 },
			{ key: "terminalZdotdir", setter: "setTerminalZdotdir", value: true },
		]

		it.each(terminalKeys)("$key は値があれば Terminal へ反映して保存する", async ({ key, setter, value }) => {
			const h = setup()

			await updateSettings(h.provider, { [key]: value })

			expect(terminalMock[setter]).toHaveBeenCalledExactlyOnceWith(value)
			expect(h.written.get(key)).toBe(value)
			// ターミナル系は VSCode 設定を触らない（保存先は contextProxy だけ）。
			expectNoVSCodeSettingWrite()
		})

		it.each(terminalKeys)("$key は undefined なら Terminal を触らずそのまま保存する", async ({ key, setter }) => {
			const h = setup()

			await updateSettings(h.provider, { [key]: undefined })

			expect(terminalMock[setter]).not.toHaveBeenCalled()
			expect(h.writtenKeys()).toEqual([key])
			expect(h.written.get(key)).toBeUndefined()
		})

		it.each([
			{ label: "パス指定", value: "/bin/zsh" },
			{ label: "未指定（クリア）", value: undefined },
		])("execaShellPath($label) は値の有無に関わらず Terminal へ渡す", async ({ value }) => {
			const h = setup()

			await updateSettings(h.provider, { execaShellPath: value })

			expect(terminalMock.setExecaShellPath).toHaveBeenCalledExactlyOnceWith(value)
			expect(h.writtenKeys()).toEqual(["execaShellPath"])
		})

		it("mcpEnabled は McpHub があれば通知する（未指定は true）", async () => {
			const mcpHub = { handleMcpEnabledChange: vi.fn(async () => {}) }
			const h = setup({ mcpHub })

			await updateSettings(h.provider, { mcpEnabled: false })
			expect(mcpHub.handleMcpEnabledChange).toHaveBeenCalledExactlyOnceWith(false)
			expect(h.written.get("mcpEnabled")).toBe(false)

			mcpHub.handleMcpEnabledChange.mockClear()
			await updateSettings(h.provider, { mcpEnabled: undefined })
			expect(mcpHub.handleMcpEnabledChange).toHaveBeenCalledExactlyOnceWith(true)
			expect(h.written.get("mcpEnabled")).toBe(true)
		})

		it("mcpEnabled は McpHub 未初期化でも保存だけは行う", async () => {
			const h = setup()

			await updateSettings(h.provider, { mcpEnabled: true })

			expect(h.written.get("mcpEnabled")).toBe(true)
			expect(h.getMcpHub).toHaveBeenCalledOnce()
		})

		it("experiments は既存値とマージして保存する", async () => {
			const h = setup({ storedValues: { experiments: { preventFocusDisruption: true, runSlashCommand: true } } })

			await updateSettings(h.provider, { experiments: { runSlashCommand: false } })

			expect(h.written.get("experiments")).toEqual({ preventFocusDisruption: true, runSlashCommand: false })
		})

		it("experiments は既存値が無ければ既定値とマージする", async () => {
			const h = setup()

			await updateSettings(h.provider, { experiments: { runSlashCommand: true } })

			expect(h.written.get("experiments")).toEqual({ ...experimentDefault, runSlashCommand: true })
		})

		// 【不変条件 2】falsy な experiments で既存設定を空にしない。
		it.each([undefined, null, false, 0, ""])(
			"experiments が %o のときは保存自体をスキップする（既存値を潰さない）",
			async (value) => {
				const h = setup({ storedValues: { experiments: { runSlashCommand: true } } })

				await updateSettings(h.provider, { experiments: value, diagnosticsEnabled: true })

				// experiments は書かれず、後続のキーの保存は続く。
				expect(h.writtenKeys()).toEqual(["diagnosticsEnabled"])
				expect(h.postStateToWebview).toHaveBeenCalledOnce()
			},
		)

		it.each([undefined, null, false, ""])(
			"customSupportPrompts が %o のときは保存自体をスキップする（既存値を潰さない）",
			async (value) => {
				const h = setup()

				await updateSettings(h.provider, { customSupportPrompts: value, diagnosticsEnabled: true })

				expect(h.writtenKeys()).toEqual(["diagnosticsEnabled"])
			},
		)

		it("customSupportPrompts に値があればそのまま保存する", async () => {
			const h = setup()
			const prompts = { ENHANCE: "改善して" }

			await updateSettings(h.provider, { customSupportPrompts: prompts })

			expect(h.written.get("customSupportPrompts")).toBe(prompts)
		})
	})

	describe("updateSettings: 保存の失敗（不変条件 2）", () => {
		it("contextProxy への保存が失敗したら reject し、以降のキーは書かれない", async () => {
			const h = setup()
			h.setValue.mockImplementation(async (key: string) => {
				if (key === "diagnosticsEnabled") {
					throw new Error("globalState write failed")
				}
			})

			// 【バグ】ハンドラ側に try/catch が無いため、失敗は webview へも通知されず
			// （webviewMessageHandler も catch しない）、settingsMessageHandlers.ts:156-164 の
			// ループは途中で止まる。先に書けたキーだけが残る＝設定が半端に適用される。
			await expect(
				updateSettings(h.provider, { alwaysAllowReadOnly: true, diagnosticsEnabled: true, writeDelayMs: 2 }),
			).rejects.toThrow("globalState write failed")

			// 3 件目（writeDelayMs）は試行すらされない。
			expect(h.writtenKeys()).toEqual(["alwaysAllowReadOnly", "diagnosticsEnabled"])
			// 失敗時は state 再送も走らないので、webview は古い表示のまま残る。
			expect(h.postStateToWebview).not.toHaveBeenCalled()
		})

		it("VSCode 設定側の update が失敗しても、そのキー以外の VSCode 設定は書き換わらない", async () => {
			const h = setup()
			configUpdateMock.mockRejectedValue(new Error("settings.json is read-only"))

			await expect(
				updateSettings(h.provider, { allowedCommands: ["npm"], deniedCommands: ["rm"] }),
			).rejects.toThrow("settings.json is read-only")

			// 失敗した allowedCommands の 1 件だけ。deniedCommands へは進まない。
			expect(configUpdates()).toEqual([
				{ section: Package.name, key: "allowedCommands", value: ["npm"], target: 1 },
			])
			// 保存に失敗したキーは contextProxy にも書かれない（不整合が残らない）。
			expect(h.setValue).not.toHaveBeenCalled()
		})
	})

	describe("updateVSCodeSetting: ホワイトリスト（不変条件 1 / 3）", () => {
		it("許可されたキーだけを引数どおりに更新する", async () => {
			const h = setup()

			await call("updateVSCodeSetting", h.provider, {
				setting: "terminal.integrated.inheritEnv",
				value: false as unknown as number,
			})

			expect(configurationSections()).toEqual([undefined])
			expect(configUpdates()).toEqual([
				{ section: undefined, key: "terminal.integrated.inheritEnv", value: false, target: true },
			])
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		// proxy は Model（API 設定プロファイル）単位の設定へ移し、拡張独自の
		// VS Code 設定は廃止した。許可リストから外れたことを固定する。
		it("openai-agent.proxyUrl は許可されない", async () => {
			const h = setup()

			await call("updateVSCodeSetting", h.provider, {
				setting: "openai-agent.proxyUrl",
				value: "socks5://127.0.0.1:1080",
			})

			expect(configUpdates()).toEqual([])
			expect(showErrorMessageMock).toHaveBeenCalled()
		})

		// 【不変条件】ホワイトリスト外は 1 件も書かれない。
		// ここが崩れると webview から任意の VSCode グローバル設定を書ける
		// （例: git.path / terminal.integrated.automationProfile.* は任意コマンド実行に化ける）。
		it.each([
			["別セクションの危険な設定", "git.path"],
			["ターミナル自動プロファイル", "terminal.integrated.automationProfile.linux"],
			["拡張自身の設定", `${Package.name}.debug`],
			["空文字", ""],
			["前方一致だけするキー", "terminal.integrated.inheritEnvExtra"],
			["末尾に空白", "terminal.integrated.inheritEnv "],
			["大文字違い", "Terminal.Integrated.InheritEnv"],
			["__proto__", "__proto__"],
			["constructor", "constructor"],
			["toString", "toString"],
			["hasOwnProperty", "hasOwnProperty"],
		])("%s（%s）は拒否してエラー表示のみ", async (_label, setting) => {
			const h = setup()

			await call("updateVSCodeSetting", h.provider, { setting, value: 1 })

			expectNoVSCodeSettingWrite()
			expect(getConfigurationMock).not.toHaveBeenCalled()
			expect(showErrorMessageMock).toHaveBeenCalledExactlyOnceWith(
				`Cannot update restricted VSCode setting: ${setting}`,
			)
			expect(h.setValue).not.toHaveBeenCalled()
		})

		it.each([
			["setting が undefined", { value: 1 }],
			["value が undefined", { setting: "terminal.integrated.inheritEnv" }],
			["両方 undefined", {}],
			// 【バグ】value === undefined で無言 return するため、
			// 許可済みキーを「未設定に戻す」操作（update(key, undefined)）は webview から実行できない。
			["許可キー + value undefined", { setting: "terminal.integrated.inheritEnv", value: undefined }],
		])("%s なら何も書かずエラー表示もしない", async (_label, message) => {
			const h = setup()

			await call("updateVSCodeSetting", h.provider, message as Partial<WebviewMessage>)

			expectNoVSCodeSettingWrite()
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		it("update が失敗すると reject する（呼び出し側で握られないので webview へは伝わらない）", async () => {
			const h = setup()
			configUpdateMock.mockRejectedValue(new Error("update failed"))

			await expect(
				call("updateVSCodeSetting", h.provider, {
					setting: "terminal.integrated.inheritEnv",
					value: true as unknown as number,
				}),
			).rejects.toThrow("update failed")

			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})
	})

	describe("getVSCodeSetting", () => {
		// 許可キーは従来どおり読める（拒否側を足したせいで正規の読み出しまで塞がないこと）。
		it("許可されたキーは設定値を読んで webview へ返す", async () => {
			const h = setup()
			configGetMock.mockReturnValue("read-value")

			await call("getVSCodeSetting", h.provider, { setting: "terminal.integrated.inheritEnv" })

			// セクション指定なしの getConfiguration() から 1 度だけ読む。
			expect(configurationSections()).toEqual([undefined])
			expect(configGetMock).toHaveBeenCalledExactlyOnceWith("terminal.integrated.inheritEnv")
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "vsCodeSetting",
				setting: "terminal.integrated.inheritEnv",
				value: "read-value",
			})
			expect(showErrorMessageMock).not.toHaveBeenCalled()
		})

		// 【不変条件 3】読み出しも updateVSCodeSetting と同じホワイトリストを通す。
		//
		// 書き込みだけ 1 キーに絞っても、読み出しが任意キーを通せば他拡張が
		// settings.json に置いたトークン類を webview 側から吸い出せる。
		// 「読めてしまった値をどうするか」ではなく、読みに行かないことを固定する。
		it.each([
			["別拡張のトークン", "someExtension.apiKey"],
			["別セクションの危険な設定", "git.path"],
			["拡張自身の設定", `${Package.name}.debug`],
			["前方一致だけするキー", "terminal.integrated.inheritEnvExtra"],
			["末尾に空白", "terminal.integrated.inheritEnv "],
			["大文字違い", "Terminal.Integrated.InheritEnv"],
			["__proto__", "__proto__"],
			["constructor", "constructor"],
			["toString", "toString"],
			["hasOwnProperty", "hasOwnProperty"],
		])("【不変条件】%s（%s）は読みに行かずエラーを返す", async (_label, setting) => {
			const h = setup()
			configGetMock.mockReturnValue("secret-token")

			await call("getVSCodeSetting", h.provider, { setting })

			// 値を取りに行った形跡が 1 度も無い（読んでから捨てる、では漏れる経路が残る）。
			expect(getConfigurationMock).not.toHaveBeenCalled()
			expect(configGetMock).not.toHaveBeenCalled()
			// webview には値ではなく理由だけを返す。
			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "vsCodeSetting",
				setting,
				error: `Cannot read restricted VSCode setting: ${setting}`,
				value: undefined,
			})
		})

		it.each([undefined, ""])("setting が %o なら何もしない", async (setting) => {
			const h = setup()

			await call("getVSCodeSetting", h.provider, { setting })

			expect(getConfigurationMock).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("許可キーの読み出しが Error で失敗したらエラー付きで返す", async () => {
			const h = setup()
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			configGetMock.mockImplementation(() => {
				throw new Error("boom")
			})

			await call("getVSCodeSetting", h.provider, { setting: "terminal.integrated.inheritEnv" })

			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "vsCodeSetting",
				setting: "terminal.integrated.inheritEnv",
				error: "Failed to get setting: boom",
				value: undefined,
			})
			expect(consoleErrorSpy).toHaveBeenCalled()
			consoleErrorSpy.mockRestore()
		})

		it("Error 以外（undefined）が投げられても落ちずに返す", async () => {
			const h = setup()
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			configGetMock.mockImplementation(() => {
				throw undefined
			})

			await call("getVSCodeSetting", h.provider, { setting: "terminal.integrated.inheritEnv" })

			expect(h.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "vsCodeSetting",
				setting: "terminal.integrated.inheritEnv",
				error: "Failed to get setting: undefined",
				value: undefined,
			})
			consoleErrorSpy.mockRestore()
		})

		it("postMessageToWebview 自体が失敗した場合はエラー通知も失敗する", async () => {
			const h = setup()
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			h.postMessageToWebview.mockRejectedValue(new Error("webview gone"))

			// 【バグ】catch の中でも postMessageToWebview を await しているため、
			// 送信自体が壊れているとハンドラが reject する。
			await expect(
				call("getVSCodeSetting", h.provider, { setting: "terminal.integrated.inheritEnv" }),
			).rejects.toThrow("webview gone")

			consoleErrorSpy.mockRestore()
		})
	})

	describe("debugSetting", () => {
		it.each([
			{ label: "true", bool: true, expected: true },
			{ label: "false", bool: false, expected: false },
			{ label: "未指定", bool: undefined, expected: false },
		])("bool=$label のとき debug キーだけを更新する", async ({ bool, expected }) => {
			const h = setup()

			await call("debugSetting", h.provider, { bool })

			// 書かれるのは拡張セクションの debug ひとつだけ。
			expect(configUpdates()).toEqual([{ section: Package.name, key: "debug", value: expected, target: 1 }])
			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("update が失敗したら state 送信まで進まない", async () => {
			const h = setup()
			configUpdateMock.mockRejectedValue(new Error("update failed"))

			await expect(call("debugSetting", h.provider, { bool: true })).rejects.toThrow("update failed")

			expect(h.postStateToWebview).not.toHaveBeenCalled()
		})
	})

	describe("その他のハンドラ", () => {
		it("customInstructions は text をそのまま委譲する", async () => {
			const h = setup()

			await call("customInstructions", h.provider, { text: "常に日本語で" })

			expect(h.updateCustomInstructions).toHaveBeenCalledExactlyOnceWith("常に日本語で")
		})

		it("customInstructions は text 未指定でも undefined で委譲する（クリア操作）", async () => {
			const h = setup()

			await call("customInstructions", h.provider, {})

			expect(h.updateCustomInstructions).toHaveBeenCalledExactlyOnceWith(undefined)
		})

		it.each(["continue", "abort"] as const)("terminalOperation(%s) を現在タスクへ渡す", async (operation) => {
			const currentTask = { handleTerminalOperation: vi.fn() }
			const h = setup({ currentTask })

			await call("terminalOperation", h.provider, { terminalOperation: operation })

			expect(currentTask.handleTerminalOperation).toHaveBeenCalledExactlyOnceWith(operation)
		})

		it("terminalOperation が無ければ現在タスクを取りにいかない", async () => {
			const currentTask = { handleTerminalOperation: vi.fn() }
			const h = setup({ currentTask })

			await call("terminalOperation", h.provider, {})

			expect(h.getCurrentTask).not.toHaveBeenCalled()
			expect(currentTask.handleTerminalOperation).not.toHaveBeenCalled()
		})

		it("terminalOperation は実行中タスクが無ければ握り潰す", async () => {
			const h = setup()

			await expect(call("terminalOperation", h.provider, { terminalOperation: "abort" })).resolves.toBeUndefined()

			expect(h.getCurrentTask).toHaveBeenCalledOnce()
		})

		it("importSettings は依存一式を渡して委譲する", async () => {
			const h = setup()

			await call("importSettings", h.provider, {})

			expect(importSettingsWithFeedbackMock).toHaveBeenCalledExactlyOnceWith({
				providerSettingsManager: h.providerSettingsManager,
				contextProxy: h.provider.contextProxy,
				customModesManager: h.customModesManager,
				provider: h.provider,
			})
		})

		it("exportSettings は依存一式を渡して委譲する", async () => {
			const h = setup()

			await call("exportSettings", h.provider, {})

			expect(exportSettingsMock).toHaveBeenCalledExactlyOnceWith({
				providerSettingsManager: h.providerSettingsManager,
				contextProxy: h.provider.contextProxy,
			})
		})

		it("resetState は provider へ委譲する", async () => {
			const h = setup()

			await call("resetState", h.provider, {})

			expect(h.resetState).toHaveBeenCalledOnce()
			// リセットの範囲は provider 側の責務。ここから VSCode 設定は触らない。
			expectNoVSCodeSettingWrite()
		})
	})
})
