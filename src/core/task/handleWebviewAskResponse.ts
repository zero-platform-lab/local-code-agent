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
 * - askResponse 3 フィールドを反映
 * - messageResponse なら checkpoint を1つ作る（timeline を汚さないよう chatRow は抑制）
 * - 直近の未回答 followup ask を answered にマーク
 * - yesButtonClicked のとき直近の未回答 tool ask も answered にマーク
 *
 * 「answered にマーク → 保存」の副作用は failure がユーザー体験を壊さないよう、
 * catch でログに落とすだけの構造をそのまま維持する（元コードの意図）。
 */
/** 実行の承認を求める ask。承認されたら回答済みの印を付ける。 */
const APPROVAL_ASKS: readonly string[] = ["tool", "command", "use_mcp_server"]
const isApprovalAsk = (ask: string | undefined) => !!ask && APPROVAL_ASKS.includes(ask)

export function handleWebviewAskResponse(
	deps: HandleWebviewAskResponseDeps,
	askResponse: ClineAskResponse,
	text: string | undefined,
	images: string[] | undefined,
): void {
	const { host } = deps

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

	// 承認した（自動承認を含む）承認待ちの ask を、回答済みにする。
	// tool だけでなく command と use_mcp_server も印を付ける。付けないと、自動承認した
	// コマンドの実行中も、画面に「実行／拒否」が残る（chatAskUiState の askPatch が見る）。
	// 拒否では付けない。tool の回答済みは「承認したファイルの変更」の数え上げに使う
	// （fileChangesFromMessages）ため、拒否したものまで数えてしまう。
	if (askResponse === "yesButtonClicked") {
		const messages = host.messageStore.clineMessages
		const lastToolAskIndex = findLastIndex(
			messages,
			(msg) => msg.type === "ask" && isApprovalAsk(msg.ask) && !msg.isAnswered,
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
