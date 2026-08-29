import type { WebviewMessage } from "@openai-agent/types"

import { getModeBySlug, type Mode } from "../../shared/modes"

import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * モード関連の webview メッセージハンドラ。
 *
 * かつては customModesMessageHandlers（カスタムモードの CRUD と同居）にあったが、
 * カスタムモード機構の撤去に伴い、残る組み込みモードの切替・問い合わせだけを
 * ここへ移した。
 */
type ModeMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

export const modeMessageHandlers: Partial<Record<WebviewMessage["type"], ModeMessageHandler>> = {
	mode: async (provider, message) => {
		// 送られてくる slug は検証しない限り任意の文字列。追従質問のサジェストが
		// 持つ mode（モデルが生成する）もこの経路を通るため、実在しない slug が
		// そのまま globalState とタスク履歴へ書き込まれうる。解決できないものは捨てる。
		const slug = message.text

		if (!slug || !getModeBySlug(slug)) {
			provider.log(`Ignoring switch to unknown mode: ${slug}`)
			return
		}

		await provider.handleModeSwitch(slug as Mode)
	},

	hasOpenedModeSelector: async (provider, message) => {
		await provider.contextProxy.setValue("hasOpenedModeSelector", message.bool ?? true)
		await provider.postStateToWebview()
	},

	requestModes: async (provider) => {
		try {
			const modes = await provider.getModes()
			await provider.postMessageToWebview({ type: "modes", modes })
		} catch (error) {
			provider.log(`Error fetching modes: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			await provider.postMessageToWebview({ type: "modes", modes: [] })
		}
	},
}
