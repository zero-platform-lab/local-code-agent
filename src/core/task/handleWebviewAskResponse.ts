import { type ClineMessage } from "@openai-agent/types"

import { ClineAskResponse } from "../../shared/WebviewMessage"
import { findLastIndex } from "../../shared/array"
import type { AskState } from "./AskState"

/**
 * webview からの ask 応答を Task の状態に反映するときの副作用。
 *
 * ask 系 3 field は `host.askState` に集約されたので、モジュール内は `askState` 経由で読む。
 * 外部呼び出しのみ callback で受ける。
 */
export interface HandleWebviewAskResponseStateHost {
	askState: AskState
	messageStore: { clineMessages: ClineMessage[] }
	checkpointSave: (attemptToSuppressMessage?: boolean, suppressChatRow?: boolean) => Promise<unknown> | void
	updateClineMessage: (message: ClineMessage) => Promise<unknown> | void
	saveClineMessages: () => Promise<unknown>
}

export interface HandleWebviewAskResponseDeps {
	host: HandleWebviewAskResponseStateHost
}

/**
 * webview からユーザー応答（yes / no / messageResponse）を受けた時の状態更新。
 *
 * - auto-approval タイマーを取り消す
 * - askResponse 3 フィールドを反映
 * - messageResponse なら checkpoint を1つ作る（timeline を汚さないよう chatRow は抑制）
 * - 直近の未回答 followup ask を answered にマーク
 * - yesButtonClicked のとき直近の未回答 tool ask も answered にマーク
 *
 * 「answered にマーク → 保存」の副作用は failure がユーザー体験を壊さないよう、
 * catch でログに落とすだけの構造をそのまま維持する（元コードの意図）。
 */
export function handleWebviewAskResponse(
	deps: HandleWebviewAskResponseDeps,
	askResponse: ClineAskResponse,
	text: string | undefined,
	images: string[] | undefined,
): void {
	const { host } = deps

	// Clear any pending auto-approval timeout when user responds
	host.askState.cancelAutoApprovalTimeout()

	host.askState.askResponse = askResponse
	host.askState.askResponseText = text
	host.askState.askResponseImages = images

	// Create a checkpoint whenever the user sends a message.
	// Use allowEmpty=true to ensure a checkpoint is recorded even if there are no file changes.
	// Suppress the checkpoint_saved chat row for this particular checkpoint to keep the timeline clean.
	if (askResponse === "messageResponse") {
		void host.checkpointSave(false, true)
	}

	// Mark the last follow-up question as answered
	if (askResponse === "messageResponse" || askResponse === "yesButtonClicked") {
		const messages = host.messageStore.clineMessages
		// Find the last unanswered follow-up message using findLastIndex
		const lastFollowUpIndex = findLastIndex(
			messages,
			(msg) => msg.type === "ask" && msg.ask === "followup" && !msg.isAnswered,
		)

		if (lastFollowUpIndex !== -1) {
			// Mark this follow-up as answered
			messages[lastFollowUpIndex].isAnswered = true
			// Save the updated messages
			host.saveClineMessages().catch((error) => {
				console.error("Failed to save answered follow-up state:", error)
			})
		}
	}

	// Mark the last tool-approval ask as answered when user approves (or auto-approval)
	if (askResponse === "yesButtonClicked") {
		const messages = host.messageStore.clineMessages
		const lastToolAskIndex = findLastIndex(
			messages,
			(msg) => msg.type === "ask" && msg.ask === "tool" && !msg.isAnswered,
		)
		if (lastToolAskIndex !== -1) {
			messages[lastToolAskIndex].isAnswered = true
			void host.updateClineMessage(messages[lastToolAskIndex])
			host.saveClineMessages().catch((error) => {
				console.error("Failed to save answered tool-ask state:", error)
			})
		}
	}
}
