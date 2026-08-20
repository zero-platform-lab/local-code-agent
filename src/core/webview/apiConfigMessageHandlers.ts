import * as vscode from "vscode"

import { type WebviewMessage } from "@openai-agent/types"

import { testOpenAiConnection } from "../../api/providers/openai"
import { t } from "../../i18n"

import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * API 設定プロファイル関連の webview メッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。プロファイルの CRUD は
 * ProviderSettingsManager が持ち、ここは webview からの操作をそこへ振り分け、
 * 一覧メタデータ（listApiConfigMeta）とピン留めをグローバル state に同期する。
 *
 * プロファイルを切り替える系（rename / load / delete）は
 * `activateProviderProfile` を呼び、現在アクティブなプロファイルに紐づく
 * グローバル設定まで更新する。
 */
type ApiConfigMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

/**
 * 失敗時のログ整形。catch した値のプロパティを全て拾う（Error 以外も来るため）。
 *
 * `Object.getOwnPropertyNames` は null / undefined で TypeError を投げる。
 * ここは全ハンドラ共通の catch なので、そこで落ちるとエラー表示にもログにも到達しない。
 */
const formatError = (error: unknown): string => {
	try {
		// Object() で包むのが肝。Object.getOwnPropertyNames は null / undefined を渡すと
		// TypeError を投げるが、Object(null) は {} になるのでそのまま通る。
		return JSON.stringify(error, Object.getOwnPropertyNames(Object(error)), 2)
	} catch {
		// 循環参照など JSON 化できない値
		return String(error)
	}
}

export const apiConfigMessageHandlers: Partial<Record<WebviewMessage["type"], ApiConfigMessageHandler>> = {
	testApiConnection: async (provider, message) => {
		const result = await testOpenAiConnection(
			message?.values?.baseUrl,
			message?.values?.apiKey,
			message?.values?.openAiHeaders,
			message?.values?.modelId,
			message?.values?.useAzure,
			message?.values?.azureApiVersion,
		)
		// 診断ブロックは拡張の Output Channel にも記録する。
		// 「設定画面を見ずに事後で読み返す」経路として重要。ヘッダ値・API キーは
		// testOpenAiConnection 側で伏せ済み。
		if (result.diagnostics) {
			provider.log(result.diagnostics.humanReadable)
		}
		provider.postMessageToWebview({
			type: "apiConnectionTest",
			success: result.success,
			text: result.message,
			// 大きすぎない構造化データ (数百バイト～数KB) なので webview まで送る。
			// UI 側で <details> の中に人間可読ブロックを表示する想定。
			values: result.diagnostics ? { diagnostics: result.diagnostics } : undefined,
		})
	},

	lockApiConfigAcrossModes: async (provider, message) => {
		const enabled = message.bool ?? false
		await provider.context.workspaceState.update("lockApiConfigAcrossModes", enabled)

		await provider.postStateToWebview()
	},

	toggleApiConfigPin: async (provider, message) => {
		if (!message.text) {
			return
		}

		const currentPinned = provider.contextProxy.getValue("pinnedApiConfigs") ?? {}
		const updatedPinned: Record<string, boolean> = { ...currentPinned }

		if (currentPinned[message.text]) {
			delete updatedPinned[message.text]
		} else {
			updatedPinned[message.text] = true
		}

		await provider.contextProxy.setValue("pinnedApiConfigs", updatedPinned)
		await provider.postStateToWebview()
	},

	enhancementApiConfigId: async (provider, message) => {
		await provider.contextProxy.setValue("enhancementApiConfigId", message.text)
		await provider.postStateToWebview()
	},

	saveApiConfiguration: async (provider, message) => {
		if (!message.text || !message.apiConfiguration) {
			return
		}

		try {
			await provider.providerSettingsManager.saveConfig(message.text, message.apiConfiguration)
			const listApiConfig = await provider.providerSettingsManager.listConfig()
			await provider.contextProxy.setValue("listApiConfigMeta", listApiConfig)
		} catch (error) {
			provider.log(`Error save api configuration: ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.save_api_config"))
		}
	},

	upsertApiConfiguration: async (provider, message) => {
		if (message.text && message.apiConfiguration) {
			await provider.upsertProviderProfile(message.text, message.apiConfiguration)
		}
	},

	renameApiConfiguration: async (provider, message) => {
		if (!message.values || !message.apiConfiguration) {
			return
		}

		try {
			const { oldName, newName } = message.values

			if (oldName === newName) {
				return
			}

			// Load the old configuration to get its ID.
			const { id } = await provider.providerSettingsManager.getProfile({ name: oldName })

			// 改名先が既存だと saveConfig が無条件で上書きし、相手の中身（API キー含む）が
			// 消えたうえで直後の deleteConfig(oldName) によりプロファイルが 1 件失われる。
			// 確認も警告も無いので、名前が衝突していたら何もせず知らせる。
			const existingNames = (await provider.providerSettingsManager.listConfig()).map((config) => config.name)
			if (existingNames.includes(newName)) {
				vscode.window.showErrorMessage(t("common:errors.rename_api_config"))
				provider.log(`Refusing to rename api configuration: "${newName}" already exists`)
				return
			}

			// Create a new configuration with the new name and old ID.
			await provider.providerSettingsManager.saveConfig(newName, { ...message.apiConfiguration, id })

			// Delete the old configuration.
			await provider.providerSettingsManager.deleteConfig(oldName)

			// Re-activate to update the global settings related to the
			// currently activated provider profile.
			await provider.activateProviderProfile({ name: newName })
		} catch (error) {
			provider.log(`Error rename api configuration: ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.rename_api_config"))
		}
	},

	loadApiConfiguration: async (provider, message) => {
		if (!message.text) {
			return
		}

		try {
			await provider.activateProviderProfile({ name: message.text })
		} catch (error) {
			provider.log(`Error load api configuration: ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.load_api_config"))
		}
	},

	loadApiConfigurationById: async (provider, message) => {
		if (!message.text) {
			return
		}

		try {
			await provider.activateProviderProfile({ id: message.text })
		} catch (error) {
			provider.log(`Error load api configuration by ID: ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.load_api_config"))
		}
	},

	deleteApiConfiguration: async (provider, message) => {
		if (!message.text) {
			return
		}

		const answer = await vscode.window.showInformationMessage(
			t("common:confirmation.delete_config_profile"),
			{ modal: true },
			t("common:answers.yes"),
		)

		if (answer !== t("common:answers.yes")) {
			return
		}

		const oldName = message.text

		// 削除後に切り替える先。最初に見つかった別プロファイルを使う。
		const newName = (await provider.providerSettingsManager.listConfig()).filter((c) => c.name !== oldName)[0]?.name

		if (!newName) {
			vscode.window.showErrorMessage(t("common:errors.delete_api_config"))
			return
		}

		try {
			await provider.providerSettingsManager.deleteConfig(oldName)
			await provider.activateProviderProfile({ name: newName })
		} catch (error) {
			provider.log(`Error delete api configuration: ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.delete_api_config"))
		}
	},

	getListApiConfiguration: async (provider) => {
		try {
			const listApiConfig = await provider.providerSettingsManager.listConfig()
			await provider.contextProxy.setValue("listApiConfigMeta", listApiConfig)
			provider.postMessageToWebview({ type: "listApiConfig", listApiConfig })
		} catch (error) {
			provider.log(`Error get list api configuration: ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.list_api_config"))
		}
	},
}
