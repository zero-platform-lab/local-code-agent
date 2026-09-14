import * as vscode from "vscode"

import { type WebviewMessage } from "@openai-agent/types"

import { getOpenAiModels } from "../../api/providers/openai"
import { t } from "../../i18n"

import { generateSystemPrompt } from "./generateSystemPrompt"
import { MessageEnhancer } from "./messageEnhancer"
import { TaskPiiMasker } from "../../services/pii/TaskPiiMasker"
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
				// **文の手直しでも伏せる**（`FR-PII-01`）。会話が動いていれば
				// その対応表を使い、番号が食い違わないようにする。
				maskForPrompt: async (text) => {
					const masker = piiMaskerFor(provider)
					const masked = await masker.maskPrompt(text)
					// 辞書が読めなかったことを黙らない（`FR-PII-03d`）。
					for (const trouble of masker.takeDictionaryTroubles()) {
						await vscode.window.showWarningMessage(t("common:pii.dictionaryFailed", { paths: trouble }))
					}
					return masked
				},
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

/**
 * 文の手直しで実行する伏せ字。
 *
 * 会話が動いていればその対応表を使う。番号が食い違うと、会話の中の伏せ字と手直しの中の
 * 伏せ字が別の値を指す。会話が無ければ、その場限りの対応表で伏せる。
 */
/**
 * 会話が無いときに使う伏せ字。1 つだけ作って使い回す。
 *
 * 作り直すと、押すたびに辞書のファイルを全部読み直すことになる。
 */
let standalone: TaskPiiMasker | undefined
/**
 * どの provider のために作ったか。
 *
 * **弱い参照で持つ。** 強く持つと、側面の画面を閉じたあとも provider と
 * `contextProxy` を抱え続け、拡張ホストが終わるまで解放されない。
 */
let standaloneFor: WeakRef<WebviewMessageHost> | undefined

/**
 * その provider で使う伏せ字を返す。会話が動いていればそれを、無ければその場限りのものを。
 *
 * **会話の外からも呼ぶ。** 右クリックのファイルの置き換えも、会話が無いときはここを使う。
 * 使わないと第 2 層が渡らず、辞書に書いていない人名がファイルに残る。
 */
export function piiMaskerFor(provider: WebviewMessageHost): TaskPiiMasker {
	const current = provider.getCurrentTask()?.piiMasker
	if (current) return current

	// **`?? {}` を付けない。** 付けると読み取りが必ず真になり、`TaskPiiMasker` の
	// 「読めなければ最後に分かっていた設定を使う」という守りが効かなくなる。設定がまだ
	// 読めていない間に `{}` で上書きされ、**伏せていない要求が黙って送られる**。
	//
	// **provider が変われば作り直す。** 側面の画面を閉じて開き直すと別の provider に
	// なる。持ち越すと、死んだ `contextProxy` を読み続ける。
	if (!standalone || standaloneFor?.deref() !== provider) {
		standalone = new TaskPiiMasker(() => provider.contextProxy.getValue("piiMasking"))
		standaloneFor = new WeakRef(provider)
	}
	return standalone
}
