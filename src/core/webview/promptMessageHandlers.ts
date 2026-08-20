import * as vscode from "vscode"

import { type WebviewMessage } from "@openai-agent/types"

import { getOpenAiModels } from "../../api/providers/openai"
import { t } from "../../i18n"

import { generateSystemPrompt } from "./generateSystemPrompt"
import { MessageEnhancer } from "./messageEnhancer"
import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * プロンプト関連の webview メッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。モード別カスタムプロンプトの
 * 更新、システムプロンプトの生成（表示 / クリップボードコピー）、入力文の推敲、
 * OpenAI 互換エンドポイントのモデル一覧取得を担う。
 */
type PromptMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

/** 失敗時のログ整形。catch した値のプロパティを全て拾う（Error 以外も来るため）。 */
const formatError = (error: unknown): string => JSON.stringify(error, Object.getOwnPropertyNames(error), 2)

export const promptMessageHandlers: Partial<Record<WebviewMessage["type"], PromptMessageHandler>> = {
	requestOpenAiModels: async (provider, message) => {
		if (!message?.values?.baseUrl || !message?.values?.apiKey) {
			return
		}

		const openAiModels = await getOpenAiModels(
			message.values.baseUrl,
			message.values.apiKey,
			message.values.openAiHeaders,
			{ mode: message.values.openAiProxyMode, url: message.values.openAiProxyUrl },
		)

		provider.postMessageToWebview({ type: "openAiModels", openAiModels })
	},

	updatePrompt: async (provider, message) => {
		if (!message.promptMode || message.customPrompt === undefined) {
			return
		}

		const existingPrompts = provider.contextProxy.getValue("customModePrompts") ?? {}
		const updatedPrompts = { ...existingPrompts, [message.promptMode]: message.customPrompt }
		await provider.contextProxy.setValue("customModePrompts", updatedPrompts)

		// 保存直後の state を組み立てて返す。postStateToWebview を待たずに
		// 更新後のプロンプトを webview へ反映するため。
		const currentState = await provider.getStateToPostToWebview()
		const stateWithPrompts = {
			...currentState,
			customModePrompts: updatedPrompts,
			hasOpenedModeSelector: currentState.hasOpenedModeSelector ?? false,
		}
		provider.postMessageToWebview({ type: "state", state: stateWithPrompts })
	},

	enhancePrompt: async (provider, message) => {
		if (!message.text) {
			return
		}

		try {
			const state = await provider.getState()

			const {
				apiConfiguration,
				customSupportPrompts,
				listApiConfigMeta = [],
				enhancementApiConfigId,
				includeTaskHistoryInEnhance,
			} = state

			const currentCline = provider.getCurrentTask()

			const result = await MessageEnhancer.enhanceMessage({
				text: message.text,
				apiConfiguration,
				customSupportPrompts,
				listApiConfigMeta,
				enhancementApiConfigId,
				includeTaskHistoryInEnhance,
				currentClineMessages: currentCline?.messageStore.clineMessages,
				providerSettingsManager: provider.providerSettingsManager,
			})

			if (result.success && result.enhancedText) {
				await provider.postMessageToWebview({ type: "enhancedPrompt", text: result.enhancedText })
			} else {
				throw new Error(result.error || "Unknown error")
			}
		} catch (error) {
			provider.log(`Error enhancing prompt: ${formatError(error)}`)

			vscode.window.showErrorMessage(t("common:errors.enhance_prompt"))
			// text 無しで返して webview 側の推敲中状態を解除する。
			await provider.postMessageToWebview({ type: "enhancedPrompt" })
		}
	},

	getSystemPrompt: async (provider, message) => {
		try {
			const systemPrompt = await generateSystemPrompt(provider, message)

			await provider.postMessageToWebview({
				type: "systemPrompt",
				text: systemPrompt,
				mode: message.mode,
			})
		} catch (error) {
			provider.log(`Error getting system prompt:  ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.get_system_prompt"))
		}
	},

	copySystemPrompt: async (provider, message) => {
		try {
			const systemPrompt = await generateSystemPrompt(provider, message)

			await vscode.env.clipboard.writeText(systemPrompt)
			await vscode.window.showInformationMessage(t("common:info.clipboard_copy"))
		} catch (error) {
			provider.log(`Error getting system prompt:  ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.get_system_prompt"))
		}
	},
}
