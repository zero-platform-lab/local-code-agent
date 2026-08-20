import { type ClineAskResponse, type ClineMessage } from "@openai-agent/types"

import type { ApiMessage } from "../task-persistence/apiMessages"
import type { PendingEditData, PendingEditOperation } from "./PendingEditOperationManager"

/**
 * 保留編集の再生対象となるタスクの最小表面（実 Task が構造的に満たす）。
 */
export interface PendingEditTarget {
	readonly taskId: string
	readonly messageStore: { clineMessages: ClineMessage[]; apiConversationHistory: ApiMessage[] }
	overwriteClineMessages(messages: ClineMessage[]): Promise<void>
	overwriteApiConversationHistory(messages: ApiMessage[]): Promise<void>
	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]): unknown
}

/** 保留編集ストアのうち、再生に必要な最小表面。 */
export interface PendingEditStore {
	get(operationId: string): PendingEditOperation | undefined
	clear(operationId: string): boolean
}

/**
 * task が「完全に立ち上がる」までの待ち時間。チェックポイント復元直後は履歴の読み込みが
 * 走っているため、即座に上書きすると復元途中の状態を壊す。
 */
const REPLAY_DELAY_MS = 100

const operationIdFor = (taskId: string) => `task-${taskId}`

/**
 * 保留編集（チェックポイント復元をまたいで持ち越されたメッセージ編集）を再生する。
 *
 * 編集対象メッセージ以降を UI 履歴／API 履歴の両方から切り落としたうえで、編集後の内容を
 * ユーザー発話として投入し直す。対象メッセージが見つからなければ何もしない。
 */
export async function replayPendingEdit(task: PendingEditTarget, pendingEdit: PendingEditData): Promise<void> {
	// Find the message index in the restored state
	const messageIndex = task.messageStore.clineMessages.findIndex((msg) => msg.ts === pendingEdit.messageTs)

	if (messageIndex === -1) {
		return
	}

	const apiConversationHistoryIndex = task.messageStore.apiConversationHistory.findIndex(
		(msg) => msg.ts === pendingEdit.messageTs,
	)

	// Remove the target message and all subsequent messages
	await task.overwriteClineMessages(task.messageStore.clineMessages.slice(0, messageIndex))

	if (apiConversationHistoryIndex !== -1) {
		await task.overwriteApiConversationHistory(
			task.messageStore.apiConversationHistory.slice(0, apiConversationHistoryIndex),
		)
	}

	// Process the edited message
	await task.handleWebviewAskResponse("messageResponse", pendingEdit.editedContent, pendingEdit.images)
}

/**
 * チェックポイント復元後のタスクに保留編集が残っていれば、その再生を予約する。
 *
 * 保留が無ければ何もしない（no-op）。予約は fire-and-forget で、失敗は log に落として
 * タスクの復元自体は継続させる。
 *
 * @returns 再生を予約したかどうか。
 */
export function schedulePendingEditReplay(
	task: PendingEditTarget,
	pendingEdits: PendingEditStore,
	log: (message: string) => void,
	delayMs: number = REPLAY_DELAY_MS,
): boolean {
	const operationId = operationIdFor(task.taskId)
	const pendingEdit = pendingEdits.get(operationId)

	if (!pendingEdit) {
		return false
	}

	pendingEdits.clear(operationId)
	log(`[createTaskWithHistoryItem] Processing pending edit after checkpoint restoration`)

	setTimeout(() => {
		replayPendingEdit(task, pendingEdit).catch((error) => {
			log(`[createTaskWithHistoryItem] Error processing pending edit: ${error}`)
		})
	}, delayMs)

	return true
}
