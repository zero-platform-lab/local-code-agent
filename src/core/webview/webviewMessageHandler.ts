import { type GlobalState, type WebviewMessage } from "@openai-agent/types"

import type { WebviewMessageHost } from "./webviewMessageHost"
import { checkExistKey } from "../../shared/checkExistApiConfig"
import { getTheme } from "../../integrations/theme/getTheme"

import { skillsMessageHandlers } from "./skillsMessageHandler"
import { worktreeMessageHandlers } from "./worktreeMessageHandlers"
import { codeIndexMessageHandlers } from "./codeIndexMessageHandlers"
import { customModesMessageHandlers } from "./customModesMessageHandlers"
import { commandMessageHandlers } from "./commandMessageHandlers"
import { apiConfigMessageHandlers } from "./apiConfigMessageHandlers"
import { mcpMessageHandlers } from "./mcpMessageHandlers"
import { taskMessageHandlers } from "./taskMessageHandlers"
import { fileEditorMessageHandlers } from "./fileEditorMessageHandlers"
import { settingsMessageHandlers } from "./settingsMessageHandlers"
import { promptMessageHandlers } from "./promptMessageHandlers"
import { uiMessageHandlers } from "./uiMessageHandlers"

const describeError = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error))

export const webviewMessageHandler = async (provider: WebviewMessageHost, message: WebviewMessage) => {
	// ドメインごとに切り出したハンドラへ委譲する。
	// 下の switch に残っているのは webviewDidLaunch（起動時ブートストラップ）のみ。
	const groupedHandler =
		worktreeMessageHandlers[message.type] ??
		codeIndexMessageHandlers[message.type] ??
		customModesMessageHandlers[message.type] ??
		commandMessageHandlers[message.type] ??
		apiConfigMessageHandlers[message.type] ??
		mcpMessageHandlers[message.type] ??
		skillsMessageHandlers[message.type] ??
		taskMessageHandlers[message.type] ??
		fileEditorMessageHandlers[message.type] ??
		settingsMessageHandlers[message.type] ??
		promptMessageHandlers[message.type] ??
		uiMessageHandlers[message.type]

	if (groupedHandler) {
		await groupedHandler(provider, message)
		return
	}

	// Utility functions provided for concise get/update of global state via contextProxy API.
	const getGlobalState = <K extends keyof GlobalState>(key: K) => provider.contextProxy.getValue(key)
	const updateGlobalState = async <K extends keyof GlobalState>(key: K, value: GlobalState[K]) =>
		await provider.contextProxy.setValue(key, value)

	switch (message.type) {
		case "webviewDidLaunch":
			// custom modes の読み込み失敗で初回 state の送信ごと落とさない。ここで throw すると
			// webview は didHydrateState が立たないまま真っ白で固まる（`getCustomModes` は
			// TTL 切れのたびに実ファイル I/O を行うので、一過性の失敗を引きうる）。
			try {
				const customModes = await provider.customModesManager.getCustomModes()
				await updateGlobalState("customModes", customModes)
			} catch (error) {
				provider.log(`[webviewDidLaunch] Failed to load custom modes: ${describeError(error)}`)
			}

			// 初回 state は hydration の唯一の入口。fire-and-forget のままだと reject が
			// unhandled rejection として消え、白い画面の理由がどこにも残らない。
			provider.postStateToWebview().catch((error) => {
				provider.log(`[webviewDidLaunch] Failed to post initial state: ${describeError(error)}`)
			})

			provider.workspaceTracker?.initializeFilePaths() // Don't await.

			getTheme().then((theme) => provider.postMessageToWebview({ type: "theme", text: JSON.stringify(theme) }))

			// If MCP Hub is already initialized, update the webview with
			// current server list.
			const mcpHub = provider.getMcpHub()

			if (mcpHub) {
				provider.postMessageToWebview({ type: "mcpServers", mcpServers: mcpHub.getAllServers() })
			}

			provider.providerSettingsManager
				.listConfig()
				.then(async (listApiConfig) => {
					if (!listApiConfig) {
						return
					}

					if (listApiConfig.length === 1) {
						// Check if first time init then sync with exist config.
						if (!checkExistKey(listApiConfig[0])) {
							const { apiConfiguration } = await provider.getState()

							// Only save if the current configuration has meaningful settings
							// (e.g., API keys). This prevents saving a default "anthropic"
							// fallback when no real config exists, which can happen during
							// CLI initialization before provider settings are applied.
							if (checkExistKey(apiConfiguration)) {
								await provider.providerSettingsManager.saveConfig(
									listApiConfig[0].name ?? "default",
									apiConfiguration,
								)

								listApiConfig[0].apiProvider = apiConfiguration.apiProvider
							}
						}
					}

					const currentConfigName = getGlobalState("currentApiConfigName")

					if (currentConfigName) {
						if (!(await provider.providerSettingsManager.hasConfig(currentConfigName))) {
							// Current config name not valid, get first config in list.
							const name = listApiConfig[0]?.name
							await updateGlobalState("currentApiConfigName", name)

							if (name) {
								await provider.activateProviderProfile({ name })
								return
							}
						}
					}

					await Promise.all([
						await updateGlobalState("listApiConfigMeta", listApiConfig),
						await provider.postMessageToWebview({ type: "listApiConfig", listApiConfig }),
					])
				})
				.catch((error) =>
					provider.log(
						`Error list api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					),
				)

			provider.isViewLaunched = true
			break
		default: {
			// console.log(`Unhandled message type: ${message.type}`)
			//
			// Currently unhandled:
			//
			// "currentApiConfigName" |
			// "codebaseIndexEnabled" |
			// "enhancedPrompt" |
			// "systemPrompt" |
			// "exportModeResult" |
			// "importModeResult" |
			// "checkRulesDirectoryResult" |
			// "browserConnectionResult" |
			// "vsCodeSetting" |
			// "indexingStatusUpdate" |
			// "indexCleared" |
			// "shareTaskSuccess" |
			// "draggedImages" |
			// "setApiConfigPassword" |
			// "setopenAiCustomModelInfo"
			break
		}
	}
}
