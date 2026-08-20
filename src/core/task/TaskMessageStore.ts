import type { ClineMessage } from "@openai-agent/types"

import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	readTaskMessages,
	saveTaskMessages,
} from "../task-persistence"

/**
 * タスクの会話履歴（API 用の apiConversationHistory と UI 用の clineMessages）を
 * 所有し、ディスクへの読み書き I/O を担うストア。Task から storage 責務を分離した。
 *
 * 注: 追加時の reasoning 整形・tool_result 検証・メタデータ/トークン更新といった
 * orchestration は Task 側の責務として残し、本クラスは「配列の保持」と「素の I/O」に
 * 徹する。
 *
 * 参照側は `task.messageStore.clineMessages` のように**このストアを直接**触る
 * （Task 側の getter/setter プロキシは撤去済み）。
 */
export class TaskMessageStore {
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	constructor(
		private readonly taskId: string,
		private readonly globalStoragePath: string,
	) {}

	/** ディスクから API 会話履歴を読み込む。 */
	async readApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	/** 現在の API 会話履歴をディスクへ保存する（失敗時は false）。 */
	async saveApiConversationHistory(): Promise<boolean> {
		try {
			await saveApiMessages({
				messages: structuredClone(this.apiConversationHistory),
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})
			return true
		} catch (error) {
			console.error("Failed to save API conversation history:", error)
			return false
		}
	}

	/** ディスクから UI メッセージ（clineMessages）を読み込む。 */
	async readClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	/**
	 * 現在の clineMessages をディスクへ保存する（素の I/O のみ・throws）。
	 * メタデータ計算やトークン更新は呼び出し側（Task）が同一 try 内で行う。
	 */
	async saveClineMessagesToDisk(): Promise<void> {
		await saveTaskMessages({
			messages: structuredClone(this.clineMessages),
			taskId: this.taskId,
			globalStoragePath: this.globalStoragePath,
		})
	}

	/** タイムスタンプで clineMessages を後方から検索する。 */
	findMessageByTimestamp(ts: number): ClineMessage | undefined {
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			if (this.clineMessages[i].ts === ts) {
				return this.clineMessages[i]
			}
		}

		return undefined
	}
}
