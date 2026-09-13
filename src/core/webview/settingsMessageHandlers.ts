import * as vscode from "vscode"

import {
	type AgentSettings,
	type ExperimentId,
	type Language,
	type SkillSource,
	type WebviewMessage,
	isGlobalStateKey,
	isSecretStateKey,
} from "@openai-agent/types"

import { changeLanguage, t } from "../../i18n"
import { Terminal } from "../../integrations/terminal/Terminal"
import { Package } from "../../shared/package"
import { experimentDefault } from "../../shared/experiments"
import { exportSettings, importSettingsWithFeedback } from "../config/importExport"
import { fetchSkillSource } from "../../services/skills/skillSourceFetcher"
import { credentialTargetForUrl, storeSkillSourceCredentials } from "../../services/skills/skillSourceCredentials"
import { clearCopiedMarker, copySkillsToShared, removeCopiedSkills } from "../../services/skills/skillSourceCopy"
import { DICTIONARY_HEADER, exportDictionary } from "../../services/pii/dictionaryEditor"
import { defaultDictionaryPath, resolveDictionaryPath } from "../../services/pii/dictionary"
import { fetchModel } from "../../services/pii/nerFetch"
import { defaultModelDirectory, describeCheck } from "../../services/pii/nerModel"
import { openFile } from "../../integrations/misc/open-file"
import { sharedSkillsDir, skillSourcesBaseDir } from "../../services/skills/skillSourcePaths"

import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * 設定関連の webview メッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。エージェント設定の一括更新、
 * 設定のインポート/エクスポート、VSCode 設定の読み書きを担う。
 */
type SettingsMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

/**
 * webview から書き換えを許可する VSCode 設定のホワイトリスト。
 * ここに無いキーは拒否する（任意の VSCode 設定を webview から触れないようにするため）。
 */
const ALLOWED_VSCODE_SETTINGS = new Set(["terminal.integrated.inheritEnv"])

/**
 * 文字列の配列だけを残す（webview から来る値の防御的な正規化）。
 *
 * 配列でなければ `undefined` を返す。`[]` を返すと、壊れたメッセージ 1 通で
 * 許可/拒否リストが黙って全消えする。「明示的に空にする」と「値が壊れている」は
 * 区別しないと、拒否リストが消えたことに誰も気づけない。
 * commandMessageHandlers.ts 側の同名関数と挙動を揃えてある。
 */
const sanitizeCommandList = (commands: unknown): string[] | undefined =>
	Array.isArray(commands)
		? commands.filter((cmd): cmd is string => typeof cmd === "string" && cmd.trim().length > 0)
		: undefined

/**
 * 設定キーひとつ分の副作用。
 *
 * 大半のキーは contextProxy に保存するだけで足りるが、一部は「保存」に加えて
 * 実行中のモジュールへ即時反映する必要がある（i18n / ターミナル / MCP）。
 * 保存する値そのものを加工するキーもあるため、加工後の値を返す。
 *
 * `undefined` を返した場合はそのキーの保存自体をスキップする（元実装の `continue` 相当）。
 */
const applySettingSideEffects = async (
	provider: WebviewMessageHost,
	key: string,
	value: unknown,
): Promise<{ skip: true } | { skip: false; value: unknown }> => {
	switch (key) {
		case "language": {
			const newValue = value ?? "en"
			changeLanguage(newValue as Language)
			return { skip: false, value: newValue }
		}
		case "allowedCommands":
		case "deniedCommands": {
			const newValue = sanitizeCommandList(value)

			// 壊れた値でリストを空にしない。保存もグローバル設定の更新も行わない。
			if (!newValue) {
				return { skip: true }
			}

			await vscode.workspace
				.getConfiguration(Package.name)
				.update(key, newValue, vscode.ConfigurationTarget.Global)

			return { skip: false, value: newValue }
		}
		case "terminalShellIntegrationTimeout":
			if (value !== undefined) {
				Terminal.setShellIntegrationTimeout(value as number)
			}
			return { skip: false, value }
		case "terminalShellIntegrationDisabled":
			if (value !== undefined) {
				Terminal.setShellIntegrationDisabled(value as boolean)
			}
			return { skip: false, value }
		case "terminalCommandDelay":
			if (value !== undefined) {
				Terminal.setCommandDelay(value as number)
			}
			return { skip: false, value }
		case "terminalZdotdir":
			if (value !== undefined) {
				Terminal.setTerminalZdotdir(value as boolean)
			}
			return { skip: false, value }
		case "execaShellPath":
			Terminal.setExecaShellPath(value as string | undefined)
			return { skip: false, value }
		case "mcpEnabled": {
			const newValue = value ?? true
			const mcpHub = provider.getMcpHub()

			if (mcpHub) {
				await mcpHub.handleMcpEnabledChange(newValue as boolean)
			}

			return { skip: false, value: newValue }
		}
		case "experiments": {
			if (!value) {
				return { skip: true }
			}

			return {
				skip: false,
				value: {
					...(provider.contextProxy.getValue("experiments") ?? experimentDefault),
					...(value as Record<ExperimentId, boolean>),
				},
			}
		}
		case "customSupportPrompts":
			if (!value) {
				return { skip: true }
			}
			return { skip: false, value }
		default:
			return { skip: false, value }
	}
}

export const settingsMessageHandlers: Partial<Record<WebviewMessage["type"], SettingsMessageHandler>> = {
	updateSettings: async (provider, message) => {
		if (!message.updatedSettings) {
			return
		}

		for (const [key, value] of Object.entries(message.updatedSettings)) {
			// webview から来たキーをそのまま setValue に渡すと、`key as keyof AgentSettings` の
			// キャストで型チェックを抜けて ContextProxy の stateCache に任意のキーが書ける。
			// `__proto__` にオブジェクトを入れられると stateCache のプロトタイプごと差し替わる。
			// 既知の設定キーだけ通す。
			if (!isGlobalStateKey(key) && !isSecretStateKey(key)) {
				provider.log(`updateSettings: ignoring unknown setting key ${JSON.stringify(key)}`)
				continue
			}

			const result = await applySettingSideEffects(provider, key, value)

			if (result.skip) {
				continue
			}

			await provider.contextProxy.setValue(key as keyof AgentSettings, result.value)
		}

		await provider.postStateToWebview()
	},

	customInstructions: async (provider, message) => {
		await provider.updateCustomInstructions(message.text)
	},

	terminalOperation: async (provider, message) => {
		if (message.terminalOperation) {
			provider.getCurrentTask()?.handleTerminalOperation(message.terminalOperation)
		}
	},

	importSettings: async (provider) => {
		await importSettingsWithFeedback({
			providerSettingsManager: provider.providerSettingsManager,
			contextProxy: provider.contextProxy,
			provider: provider,
		})
	},

	exportSettings: async (provider) => {
		await exportSettings({
			providerSettingsManager: provider.providerSettingsManager,
			contextProxy: provider.contextProxy,
		})
	},

	resetState: async (provider) => {
		await provider.resetState()
	},

	/**
	 * スキルの取得元を取ってくる（`FR-EXT-05` `FR-EXT-05a`）。
	 *
	 * **利用者が押したときだけ通信する。** 起動時にも定期的にも取りに行かない
	 * （`NFR-PRV-03`）。
	 */
	fetchSkillSource: async (provider, message) => {
		const url = typeof message.values?.url === "string" ? message.values.url : ""
		const proxyMode = message.values?.proxyMode as SkillSource["proxyMode"]
		const proxyUrl = typeof message.values?.proxyUrl === "string" ? message.values.proxyUrl : undefined
		const copyToShared = message.values?.copyToShared === true

		const result = await fetchSkillSource({
			url,
			baseDir: skillSourcesBaseDir(),
			proxy: { mode: proxyMode, url: proxyUrl },
		})

		if (!result.ok) {
			await vscode.window.showErrorMessage(t("common:skills.fetchFailed", { error: result.error }))
			return
		}

		if (result.proxyIgnored) {
			// 黙って無視しない。設定したのに効かない状態を切り分けられなくなる
			// （`FR-EXT-05b3`）。
			await vscode.window.showWarningMessage(t("common:skills.proxyIgnoredForSsh"))
		}

		await vscode.window.showInformationMessage(
			t(result.action === "cloned" ? "common:skills.fetched" : "common:skills.updated", { url }),
		)

		if (copyToShared) {
			const { copied, skipped } = await copySkillsToShared({
				sourceDir: result.directory,
				sharedDir: sharedSkillsDir(),
				url,
			})

			if (skipped.length > 0) {
				// 同じ名前のものが先にあった。ほかのツールが置いたものには触らない
				// （`FR-EXT-05f2`）。黙って飛ばすと、複製したつもりで古い中身が使われる。
				await vscode.window.showWarningMessage(t("common:skills.copySkipped", { names: skipped.join(", ") }))
			}

			await vscode.window.showInformationMessage(t("common:skills.copied", { count: copied.length }))
		} else {
			// 複製をやめたときは、前に置いたものを片づけてから探索先へ戻す。
			const removed = await removeCopiedSkills({ sharedDir: sharedSkillsDir(), url })
			await clearCopiedMarker(result.directory)

			if (removed.length > 0) {
				await vscode.window.showInformationMessage(t("common:skills.copyRemoved", { count: removed.length }))
			}
		}

		await provider.getSkillsManager()?.discoverSkills()
		await provider.postStateToWebview()
	},

	saveSkillSourceCredentials: async (_provider, message) => {
		const url = typeof message.values?.url === "string" ? message.values.url : ""

		const target = credentialTargetForUrl(url)
		if (!target) {
			await vscode.window.showWarningMessage(t("common:skills.credentialNotHttps"))
			return
		}

		// **値は拡張ホスト側で聞く**（`FR-EXT-06b`）。webview を経由すると、渡す経路が
		// 1 つ増えるだけで、どこにも保存しない利点が薄れる。
		const username = await vscode.window.showInputBox({
			prompt: t("common:skills.credentialPrompt", { host: target.host }),
			ignoreFocusOut: true,
		})
		if (!username) {
			return
		}

		const password = await vscode.window.showInputBox({
			prompt: t("common:skills.credentialPasswordPrompt", { host: target.host }),
			password: true,
			ignoreFocusOut: true,
		})
		if (!password) {
			return
		}

		const result = await storeSkillSourceCredentials({ url, username, password })

		if (result.ok) {
			await vscode.window.showInformationMessage(t("common:skills.credentialSaved", { host: result.host }))
			return
		}

		if (result.reason === "no-helper") {
			// 保管庫が無いと `approve` は黙って何もしない。設定の方法まで示す
			// （`FR-EXT-06c`）。
			await vscode.window.showWarningMessage(t("common:skills.credentialNoHelper"))
			return
		}

		if (result.reason === "unsafe-value") {
			await vscode.window.showWarningMessage(t("common:skills.credentialUnsafeValue"))
			return
		}

		await vscode.window.showErrorMessage(t("common:skills.credentialFailed", { error: result.error ?? "" }))
	},

	exportPiiDictionary: async (provider, _message) => {
		// 語は設定と辞書の両方に散らばる。書き出すときは、どちらに書いたかを
		// 気にせずに済むよう 1 つにまとめる（`FR-PII-17a`）。
		const masking = provider.contextProxy.getValue("piiMasking")
		await exportDictionary({ terms: masking?.terms, dictionaryPaths: masking?.dictionaryPaths })
	},

	openPiiDictionary: async (_provider, message) => {
		// **`~` を展開してから開く。** 画面の例示が `~/.agent/pii-dictionary.txt` なので、
		// そのまま渡すと作業ディレクトリの下に `~` というディレクトリを作ってしまう。
		const raw = typeof message.text === "string" ? message.text : ""
		const target = resolveDictionaryPath(raw) ?? defaultDictionaryPath()

		// 無ければ作る。**書き方も一緒に入れる**（`FR-PII-16`）。空のファイルを渡されても、
		// タブが種類を表すことも `/.../` が正規表現になることも分からない。
		await openFile(target, { create: true, content: DICTIONARY_HEADER })
	},

	fetchPiiNerModel: async (provider, _message) => {
		// **利用者が押したときだけ取りに行く（`FR-PII-23c`）。** 282 MB を勝手に取らない。
		const masking = provider.contextProxy.getValue("piiMasking")
		const raw = masking?.properNouns?.modelPath
		const directory = (raw && resolveDictionaryPath(raw)) || defaultModelDirectory()

		// 282 MB を待たせるので、何を取っているかを出す。
		const check = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: t("common:pii.fetchingModel"),
				cancellable: false,
			},
			async (progress) => {
				try {
					return await fetchModel(directory, { report: (one) => progress.report({ message: one }) })
				} catch (error) {
					await vscode.window.showErrorMessage(
						t("common:pii.fetchFailed", { error: error instanceof Error ? error.message : String(error) }),
					)
					return undefined
				}
			},
		)

		if (check === undefined) return

		// **取れたつもりで欠けている状態を作らない。** 欠けたまま入にすると、第 2 層が
		// 静かに動かず、画面の見た目も変わらない。
		const why = describeCheck(check)
		if (why) {
			await vscode.window.showErrorMessage(t("common:pii.modelIncomplete", { detail: why }))
			return
		}

		await vscode.window.showInformationMessage(t("common:pii.modelReady", { path: directory }))
	},

	updateVSCodeSetting: async (_provider, message) => {
		const { setting, value } = message

		if (setting === undefined || value === undefined) {
			return
		}

		if (!ALLOWED_VSCODE_SETTINGS.has(setting)) {
			vscode.window.showErrorMessage(`Cannot update restricted VSCode setting: ${setting}`)
			return
		}

		await vscode.workspace.getConfiguration().update(setting, value, true)
	},

	getVSCodeSetting: async (provider, message) => {
		const { setting } = message

		if (!setting) {
			return
		}

		// 書き込みは ALLOWED_VSCODE_SETTINGS に絞っているのに、読み出しは任意キーが通っていた。
		// VS Code の設定は他拡張のものも同じ名前空間にあるので、そこに置かれた
		// トークン類まで webview へ返せてしまう。読み書きで同じ許可リストを使う。
		if (!ALLOWED_VSCODE_SETTINGS.has(setting)) {
			await provider.postMessageToWebview({
				type: "vsCodeSetting",
				setting,
				error: `Cannot read restricted VSCode setting: ${setting}`,
				value: undefined,
			})
			return
		}

		try {
			await provider.postMessageToWebview({
				type: "vsCodeSetting",
				setting,
				value: vscode.workspace.getConfiguration().get(setting),
			})
		} catch (error) {
			console.error(`Failed to get VSCode setting ${setting}:`, error)

			await provider.postMessageToWebview({
				type: "vsCodeSetting",
				setting,
				error: `Failed to get setting: ${(error as { message?: string } | undefined)?.message}`,
				value: undefined,
			})
		}
	},

	debugSetting: async (provider, message) => {
		await vscode.workspace
			.getConfiguration(Package.name)
			.update("debug", message.bool ?? false, vscode.ConfigurationTarget.Global)
		await provider.postStateToWebview()
	},
}
