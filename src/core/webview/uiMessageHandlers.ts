import * as vscode from "vscode"

import { type WebviewMessage, checkoutDiffPayloadSchema, checkoutRestorePayloadSchema } from "@openai-agent/types"
import pWaitFor from "p-wait-for"

import { t } from "../../i18n"
import { getCommand } from "../../utils/commands"

import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * webview の UI 操作とチェックポイント関連のメッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。パネルのフォーカス、
 * タブ切り替え、アップセル表示の dismiss 管理、およびチェックポイントの
 * 差分表示 / 復元を担う。
 */
type UiMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const uiMessageHandlers: Partial<Record<WebviewMessage["type"], UiMessageHandler>> = {
	focusPanelRequest: async () => {
		// Execute the focusPanel command to focus the WebView
		await vscode.commands.executeCommand(getCommand("focusPanel"))
	},

	switchTab: async (provider, message) => {
		if (!message.tab) {
			return
		}

		await provider.postMessageToWebview({
			type: "action",
			action: "switchTab",
			tab: message.tab,
			values: message.values,
		})
	},

	dismissUpsell: async (provider, message) => {
		if (!message.upsellId) {
			return
		}

		try {
			// Get current list of dismissed upsells
			const dismissedUpsells = provider.contextProxy.getValue("dismissedUpsells") || []

			// Add the new upsell ID if not already present
			let updatedList = dismissedUpsells
			if (!dismissedUpsells.includes(message.upsellId)) {
				updatedList = [...dismissedUpsells, message.upsellId]
				await provider.contextProxy.setValue("dismissedUpsells", updatedList)
			}

			// Send updated list back to webview (use the already computed updatedList)
			await provider.postMessageToWebview({
				type: "dismissedUpsells",
				list: updatedList,
			})
		} catch (error) {
			// Fail silently as per Bruno's comment - it's OK to fail silently in this case
			provider.log(`Failed to dismiss upsell: ${toErrorMessage(error)}`)
		}
	},

	getDismissedUpsells: async (provider) => {
		// Send the current list of dismissed upsells to the webview
		const dismissedUpsells = provider.contextProxy.getValue("dismissedUpsells") || []
		await provider.postMessageToWebview({
			type: "dismissedUpsells",
			list: dismissedUpsells,
		})
	},

	checkpointDiff: async (provider, message) => {
		const result = checkoutDiffPayloadSchema.safeParse(message.payload)

		if (result.success) {
			await provider.getCurrentTask()?.checkpointDiff(result.data)
		}
	},

	checkpointRestore: async (provider, message) => {
		const result = checkoutRestorePayloadSchema.safeParse(message.payload)

		if (!result.success) {
			return
		}

		await provider.cancelTask()

		// cancelTask は同一インスタンスを再水和する。復元は初期化完了を待ってから行う。
		try {
			await pWaitFor(() => provider.getCurrentTask()?.isInitialized === true, { timeout: 3_000 })
		} catch {
			vscode.window.showErrorMessage(t("common:errors.checkpoint_timeout"))
		}

		try {
			await provider.getCurrentTask()?.checkpointRestore(result.data)
		} catch {
			vscode.window.showErrorMessage(t("common:errors.checkpoint_failed"))
		}
	},
}
