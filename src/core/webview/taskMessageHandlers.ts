import * as vscode from "vscode"

import {
	type ClineMessage,
	type EditQueuedMessagePayload,
	type WebviewMessage,
	DEFAULT_AUTONOMY_MODE,
} from "@openai-agent/types"

import { t } from "../../i18n"
import { resolveImageMentions } from "../mentions/resolveImageMentions"
import { saveTaskMessages } from "../task-persistence"
import { type ApiMessage } from "../task-persistence/apiMessages"
import { setPendingTodoList } from "../tools/UpdateTodoListTool"

import { handleCheckpointRestoreOperation } from "./checkpointRestoreHandler"
import type { HandlerTaskView, WebviewMessageHost } from "./webviewMessageHost"

/**
 * タスク操作関連の webview メッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。タスクの生成 / 破棄 /
 * キャンセルといったライフサイクル、履歴タスクの表示・削除・エクスポート、
 * チャットメッセージの編集 / 削除（確認ダイアログ往復を含む）、
 * メッセージキュー、自動承認まわりを担う。
 *
 * 具象 `Task` / `ClineProvider` は import せず、`WebviewMessageHost` が公開する
 * narrow な surface だけを使う（webview 層の循環依存ガードを壊さないため）。
 */
type TaskMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

/** catch した値をユーザー向け文字列へ。Error 以外も来るため String() でフォールバックする。 */
const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 現在のタスクの cwd。タスクが無ければ provider の cwd にフォールバックする。 */
const getCurrentCwd = (provider: WebviewMessageHost): string => provider.getCurrentTask()?.cwd || provider.cwd

/**
 * Resolves image file mentions in incoming messages.
 * Matches read_file behavior: respects size limits and model capabilities.
 */
const resolveIncomingImages = async (provider: WebviewMessageHost, payload: { text?: string; images?: string[] }) => {
	const text = payload.text ?? ""
	const images = payload.images
	const currentTask = provider.getCurrentTask()
	const state = await provider.getState()
	const resolved = await resolveImageMentions({
		text,
		images,
		cwd: getCurrentCwd(provider),
		rooIgnoreController: currentTask?.rooIgnoreController,
		maxImageFileSize: state.maxImageFileSize,
		maxTotalImageSize: state.maxTotalImageSize,
	})
	return resolved
}

/**
 * Shared utility to find message indices based on timestamp.
 * When multiple messages share the same timestamp (e.g., after condense),
 * this function prefers non-summary messages to ensure user operations
 * target the intended message rather than the summary.
 */
const findMessageIndices = (messageTs: number, currentCline: HandlerTaskView) => {
	// Find the exact message by timestamp, not the first one after a cutoff
	const messageIndex = currentCline.messageStore.clineMessages.findIndex((msg: ClineMessage) => msg.ts === messageTs)

	// Find all matching API messages by timestamp
	const allApiMatches = currentCline.messageStore.apiConversationHistory
		.map((msg: ApiMessage, idx: number) => ({ msg, idx }))
		.filter(({ msg }: { msg: ApiMessage }) => msg.ts === messageTs)

	// Prefer non-summary message if multiple matches exist (handles timestamp collision after condense)
	const preferred = allApiMatches.find(({ msg }: { msg: ApiMessage }) => !msg.isSummary) || allApiMatches[0]
	const apiConversationHistoryIndex = preferred?.idx ?? -1

	return { messageIndex, apiConversationHistoryIndex }
}

/**
 * Fallback: find first API history index at or after a timestamp.
 * Used when the exact user message isn't present in apiConversationHistory (e.g., after condense).
 */
const findFirstApiIndexAtOrAfter = (ts: number, currentCline: HandlerTaskView) => {
	if (typeof ts !== "number") return -1
	return currentCline.messageStore.apiConversationHistory.findIndex(
		(msg: ApiMessage) => typeof msg?.ts === "number" && (msg.ts as number) >= ts,
	)
}

/**
 * Handles message deletion operations with user confirmation
 */
const handleDeleteOperation = async (provider: WebviewMessageHost, messageTs: number): Promise<void> => {
	// Check if there's a checkpoint before this message
	const currentCline = provider.getCurrentTask()
	let hasCheckpoint = false

	if (!currentCline) {
		await vscode.window.showErrorMessage(t("common:errors.message.no_active_task_to_delete"))
		return
	}

	const { messageIndex } = findMessageIndices(messageTs, currentCline)

	if (messageIndex !== -1) {
		// Find the last checkpoint before this message
		const checkpoints = currentCline.messageStore.clineMessages.filter(
			(msg) => msg.say === "checkpoint_saved" && msg.ts > messageTs,
		)
		hasCheckpoint = checkpoints.length > 0
	}

	// Send message to webview to show delete confirmation dialog
	await provider.postMessageToWebview({
		type: "showDeleteMessageDialog",
		messageTs,
		hasCheckpoint,
	})
}

/**
 * Handles confirmed message deletion from webview dialog
 */
const handleDeleteMessageConfirm = async (
	provider: WebviewMessageHost,
	messageTs: number,
	restoreCheckpoint?: boolean,
): Promise<void> => {
	const currentCline = provider.getCurrentTask()
	if (!currentCline) {
		console.error("[handleDeleteMessageConfirm] No current cline available")
		return
	}

	const { messageIndex, apiConversationHistoryIndex } = findMessageIndices(messageTs, currentCline)
	// Determine API truncation index with timestamp fallback if exact match not found
	let apiIndexToUse = apiConversationHistoryIndex
	const tsThreshold = currentCline.messageStore.clineMessages[messageIndex]?.ts
	if (apiIndexToUse === -1 && typeof tsThreshold === "number") {
		apiIndexToUse = findFirstApiIndexAtOrAfter(tsThreshold, currentCline)
	}

	if (messageIndex === -1) {
		await vscode.window.showErrorMessage(t("common:errors.message.message_not_found", { messageTs }))
		return
	}

	try {
		const targetMessage = currentCline.messageStore.clineMessages[messageIndex]

		// If checkpoint restoration is requested, find and restore to the last checkpoint before this message
		if (restoreCheckpoint) {
			// Find the last checkpoint before this message
			const checkpoints = currentCline.messageStore.clineMessages.filter(
				(msg) => msg.say === "checkpoint_saved" && msg.ts > messageTs,
			)

			const nextCheckpoint = checkpoints[0]

			if (nextCheckpoint && nextCheckpoint.text) {
				await handleCheckpointRestoreOperation({
					provider,
					currentCline,
					messageTs: targetMessage.ts!,
					messageIndex,
					checkpoint: { hash: nextCheckpoint.text },
					operation: "delete",
				})
			} else {
				// No checkpoint found before this message
				console.log("[handleDeleteMessageConfirm] No checkpoint found before message")
				vscode.window.showWarningMessage("No checkpoint found before this message")
			}
		} else {
			// For non-checkpoint deletes, preserve checkpoint associations for remaining messages
			// Store checkpoints from messages that will be preserved
			const preservedCheckpoints = new Map<number, any>()
			for (let i = 0; i < messageIndex; i++) {
				const msg = currentCline.messageStore.clineMessages[i]
				if (msg?.checkpoint && msg.ts) {
					preservedCheckpoints.set(msg.ts, msg.checkpoint)
				}
			}

			// Delete this message and all subsequent messages using MessageManager
			await currentCline.messageManager.rewindToTimestamp(targetMessage.ts!, { includeTargetMessage: false })

			// Restore checkpoint associations for preserved messages
			for (const [ts, checkpoint] of preservedCheckpoints) {
				const msgIndex = currentCline.messageStore.clineMessages.findIndex((msg) => msg.ts === ts)
				if (msgIndex !== -1) {
					currentCline.messageStore.clineMessages[msgIndex].checkpoint = checkpoint
				}
			}

			// Save the updated messages with restored checkpoints
			await saveTaskMessages({
				messages: currentCline.messageStore.clineMessages,
				taskId: currentCline.taskId,
				globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
			})

			// Update the UI to reflect the deletion
			await provider.postStateToWebview()
		}
	} catch (error) {
		console.error("Error in delete message:", error)
		vscode.window.showErrorMessage(
			t("common:errors.message.error_deleting_message", {
				error: toErrorMessage(error),
			}),
		)
	}
}

/**
 * Handles message editing operations with user confirmation
 */
const handleEditOperation = async (
	provider: WebviewMessageHost,
	messageTs: number,
	editedContent: string,
	images?: string[],
): Promise<void> => {
	// Check if there's a checkpoint before this message
	const currentCline = provider.getCurrentTask()
	let hasCheckpoint = false
	if (currentCline) {
		const { messageIndex } = findMessageIndices(messageTs, currentCline)
		if (messageIndex !== -1) {
			// Find the last checkpoint before this message
			const checkpoints = currentCline.messageStore.clineMessages.filter(
				(msg) => msg.say === "checkpoint_saved" && msg.ts > messageTs,
			)

			hasCheckpoint = checkpoints.length > 0
		} else {
			console.log("[webviewMessageHandler] Edit - Message not found in clineMessages!")
		}
	} else {
		console.log("[webviewMessageHandler] Edit - No currentCline available!")
	}

	// Send message to webview to show edit confirmation dialog
	await provider.postMessageToWebview({
		type: "showEditMessageDialog",
		messageTs,
		text: editedContent,
		hasCheckpoint,
		images,
	})
}

/**
 * Handles confirmed message editing from webview dialog
 */
const handleEditMessageConfirm = async (
	provider: WebviewMessageHost,
	messageTs: number,
	editedContent: string,
	restoreCheckpoint?: boolean,
	images?: string[],
): Promise<void> => {
	const currentCline = provider.getCurrentTask()
	if (!currentCline) {
		console.error("[handleEditMessageConfirm] No current cline available")
		return
	}

	// Use findMessageIndices to find messages based on timestamp
	const { messageIndex, apiConversationHistoryIndex } = findMessageIndices(messageTs, currentCline)

	if (messageIndex === -1) {
		const errorMessage = t("common:errors.message.message_not_found", { messageTs })
		console.error("[handleEditMessageConfirm]", errorMessage)
		await vscode.window.showErrorMessage(errorMessage)
		return
	}

	try {
		const targetMessage = currentCline.messageStore.clineMessages[messageIndex]

		// If checkpoint restoration is requested, find and restore to the last checkpoint before this message
		if (restoreCheckpoint) {
			// Find the last checkpoint before this message
			const checkpoints = currentCline.messageStore.clineMessages.filter(
				(msg) => msg.say === "checkpoint_saved" && msg.ts > messageTs,
			)

			const nextCheckpoint = checkpoints[0]

			if (nextCheckpoint && nextCheckpoint.text) {
				await handleCheckpointRestoreOperation({
					provider,
					currentCline,
					messageTs: targetMessage.ts!,
					messageIndex,
					checkpoint: { hash: nextCheckpoint.text },
					operation: "edit",
					editData: {
						editedContent,
						images,
						apiConversationHistoryIndex,
					},
				})
				// The task will be cancelled and reinitialized by checkpointRestore
				// The pending edit will be processed in the reinitialized task
				return
			} else {
				// No checkpoint found before this message
				console.log("[handleEditMessageConfirm] No checkpoint found before message")
				vscode.window.showWarningMessage("No checkpoint found before this message")
				// Continue with non-checkpoint edit
			}
		}

		// For non-checkpoint edits, remove the ORIGINAL user message being edited and all subsequent messages
		// Determine the correct starting index to delete from (prefer the last preceding user_feedback message)
		let deleteFromMessageIndex = messageIndex
		let deleteFromApiIndex = apiConversationHistoryIndex

		// Find the nearest preceding user message to ensure we replace the original, not just the assistant reply
		for (let i = messageIndex; i >= 0; i--) {
			const m = currentCline.messageStore.clineMessages[i]
			if (m?.say === "user_feedback") {
				deleteFromMessageIndex = i
				// Align API history truncation to the same user message timestamp if present
				const userTs = m.ts
				if (typeof userTs === "number") {
					const apiIdx = currentCline.messageStore.apiConversationHistory.findIndex(
						(am: ApiMessage) => am.ts === userTs,
					)
					if (apiIdx !== -1) {
						deleteFromApiIndex = apiIdx
					}
				}
				break
			}
		}

		// Timestamp fallback for API history when exact user message isn't present
		if (deleteFromApiIndex === -1) {
			const tsThresholdForEdit = currentCline.messageStore.clineMessages[deleteFromMessageIndex]?.ts
			if (typeof tsThresholdForEdit === "number") {
				deleteFromApiIndex = findFirstApiIndexAtOrAfter(tsThresholdForEdit, currentCline)
			}
		}

		// Store checkpoints from messages that will be preserved
		const preservedCheckpoints = new Map<number, any>()
		for (let i = 0; i < deleteFromMessageIndex; i++) {
			const msg = currentCline.messageStore.clineMessages[i]
			if (msg?.checkpoint && msg.ts) {
				preservedCheckpoints.set(msg.ts, msg.checkpoint)
			}
		}

		// Delete the original (user) message and all subsequent messages using MessageManager
		const rewindTs = currentCline.messageStore.clineMessages[deleteFromMessageIndex]?.ts
		if (rewindTs) {
			await currentCline.messageManager.rewindToTimestamp(rewindTs, { includeTargetMessage: false })
		}

		// Restore checkpoint associations for preserved messages
		for (const [ts, checkpoint] of preservedCheckpoints) {
			const msgIndex = currentCline.messageStore.clineMessages.findIndex((msg) => msg.ts === ts)
			if (msgIndex !== -1) {
				currentCline.messageStore.clineMessages[msgIndex].checkpoint = checkpoint
			}
		}

		// Save the updated messages with restored checkpoints
		await saveTaskMessages({
			messages: currentCline.messageStore.clineMessages,
			taskId: currentCline.taskId,
			globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
		})

		// Update the UI to reflect the deletion
		await provider.postStateToWebview()

		await currentCline.submitUserMessage(editedContent, images)
	} catch (error) {
		console.error("Error in edit message:", error)
		vscode.window.showErrorMessage(
			t("common:errors.message.error_editing_message", {
				error: toErrorMessage(error),
			}),
		)
	}
}

/**
 * Handles message modification operations (delete or edit) with confirmation dialog
 * @param messageTs Timestamp of the message to operate on
 * @param operation Type of operation ('delete' or 'edit')
 * @param editedContent New content for edit operations
 * @returns Promise<void>
 */
const handleMessageModificationsOperation = async (
	provider: WebviewMessageHost,
	messageTs: number,
	operation: "delete" | "edit",
	editedContent?: string,
	images?: string[],
): Promise<void> => {
	if (operation === "delete") {
		await handleDeleteOperation(provider, messageTs)
	} else if (operation === "edit" && editedContent) {
		await handleEditOperation(provider, messageTs, editedContent, images)
	}
}

export const taskMessageHandlers: Partial<Record<WebviewMessage["type"], TaskMessageHandler>> = {
	newTask: async (provider, message) => {
		// Initializing new instance of Cline will make sure that any
		// agentically running promises in old instance don't affect our new
		// task. This essentially creates a fresh slate for the new task.
		try {
			const resolved = await resolveIncomingImages(provider, { text: message.text, images: message.images })
			await provider.createTask(
				resolved.text,
				resolved.images,
				undefined,
				{ taskId: message.taskId },
				message.taskConfiguration,
			)
			// Task created successfully - notify the UI to reset
			await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
		} catch (error) {
			// For all errors, reset the UI and show error
			await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
			// Show error to user
			vscode.window.showErrorMessage(`Failed to create task: ${toErrorMessage(error)}`)
		}
	},

	clearTask: async (provider) => {
		// Clear task resets the current session. Delegation flows are
		// handled via metadata; parent resumption occurs through
		// reopenParentFromDelegation, not via finishSubTask.
		await provider.clearTask()
		await provider.postStateToWebview()
	},

	cancelTask: async (provider) => {
		await provider.cancelTask()
	},

	askResponse: async (provider, message) => {
		const resolved = await resolveIncomingImages(provider, { text: message.text, images: message.images })
		provider.getCurrentTask()?.handleWebviewAskResponse(message.askResponse!, resolved.text, resolved.images)
	},

	// ---- Chat Message Queue ----

	queueMessage: async (provider, message) => {
		const resolved = await resolveIncomingImages(provider, { text: message.text, images: message.images })
		provider.getCurrentTask()?.messageQueueService.addMessage(resolved.text, resolved.images)
	},

	removeQueuedMessage: async (provider, message) => {
		provider.getCurrentTask()?.messageQueueService.removeMessage(message.text ?? "")
	},

	editQueuedMessage: async (provider, message) => {
		if (!message.payload) {
			return
		}

		const { id, text, images } = message.payload as EditQueuedMessagePayload
		provider.getCurrentTask()?.messageQueueService.updateMessage(id, text, images)
	},

	// ---- Message edit / delete ----

	submitEditedMessage: async (provider, message) => {
		const messageTs = message.value

		if (
			!provider.getCurrentTask() ||
			typeof messageTs !== "number" ||
			!messageTs ||
			!message.editedMessageContent
		) {
			return
		}

		await handleMessageModificationsOperation(
			provider,
			messageTs,
			"edit",
			message.editedMessageContent,
			message.images,
		)
	},

	editMessageConfirm: async (provider, message) => {
		if (!message.messageTs || !message.text) {
			return
		}

		const resolved = await resolveIncomingImages(provider, { text: message.text, images: message.images })
		await handleEditMessageConfirm(
			provider,
			message.messageTs,
			resolved.text,
			message.restoreCheckpoint,
			resolved.images,
		)
	},

	deleteMessage: async (provider, message) => {
		if (!provider.getCurrentTask()) {
			await vscode.window.showErrorMessage(t("common:errors.message.no_active_task_to_delete"))
			return
		}

		if (typeof message.value !== "number" || !message.value) {
			await vscode.window.showErrorMessage(t("common:errors.message.invalid_timestamp_for_deletion"))
			return
		}

		await handleMessageModificationsOperation(provider, message.value, "delete")
	},

	deleteMessageConfirm: async (provider, message) => {
		if (!message.messageTs) {
			await vscode.window.showErrorMessage(t("common:errors.message.cannot_delete_missing_timestamp"))
			return
		}

		if (typeof message.messageTs !== "number") {
			await vscode.window.showErrorMessage(t("common:errors.message.cannot_delete_invalid_timestamp"))
			return
		}

		await handleDeleteMessageConfirm(provider, message.messageTs, message.restoreCheckpoint)
	},

	// ---- History task operations ----

	showTaskWithId: async (provider, message) => {
		provider.showTaskWithId(message.text!)
	},

	deleteTaskWithId: async (provider, message) => {
		provider.deleteTaskWithId(message.text!)
	},

	deleteMultipleTasksWithIds: async (provider, message) => {
		const ids = message.ids

		if (!Array.isArray(ids)) {
			return
		}

		// Process in batches of 20 (or another reasonable number)
		const batchSize = 20
		const results = []

		// Only log start and end of the operation
		console.log(`Batch deletion started: ${ids.length} tasks total`)

		for (let i = 0; i < ids.length; i += batchSize) {
			const batch = ids.slice(i, i + batchSize)

			const batchPromises = batch.map(async (id) => {
				try {
					await provider.deleteTaskWithId(id)
					return { id, success: true }
				} catch (error) {
					// Keep error logging for debugging purposes
					console.log(`Failed to delete task ${id}: ${toErrorMessage(error)}`)
					return { id, success: false }
				}
			})

			// Process each batch in parallel but wait for completion before starting the next batch
			const batchResults = await Promise.all(batchPromises)
			results.push(...batchResults)

			// Update the UI after each batch to show progress
			await provider.postStateToWebview()
		}

		// Log final results
		const successCount = results.filter((r) => r.success).length
		const failCount = results.length - successCount
		console.log(
			`Batch deletion completed: ${successCount}/${ids.length} tasks successful, ${failCount} tasks failed`,
		)
	},

	exportCurrentTask: async (provider) => {
		const currentTaskId = provider.getCurrentTask()?.taskId

		if (!currentTaskId) {
			return
		}

		provider.exportTaskWithId(currentTaskId)
	},

	exportTaskWithId: async (provider, message) => {
		provider.exportTaskWithId(message.text!)
	},

	getTaskWithAggregatedCosts: async (provider, message) => {
		try {
			const taskId = message.text
			if (!taskId) {
				throw new Error("Task ID is required")
			}
			const result = await provider.getTaskWithAggregatedCosts(taskId)
			await provider.postMessageToWebview({
				type: "taskWithAggregatedCosts",
				// IMPORTANT: ChatView stores aggregatedCostsMap keyed by message.text (taskId)
				// so we must include it here.
				text: taskId,
				historyItem: result.historyItem,
				aggregatedCosts: result.aggregatedCosts,
			})
		} catch (error) {
			console.error("Error getting task with aggregated costs:", error)
			await provider.postMessageToWebview({
				type: "taskWithAggregatedCosts",
				// Include taskId when available for correlation in UI logs.
				text: message.text,
				error: toErrorMessage(error),
			})
		}
	},

	condenseTaskContextRequest: async (provider, message) => {
		provider.condenseTaskContext(message.text!)
	},

	// ---- Todo list / auto-approval / autonomy ----

	updateTodoList: async (_provider, message) => {
		const payload = message.payload as { todos?: any[] }
		const todos = payload?.todos

		if (!Array.isArray(todos)) {
			return
		}

		await setPendingTodoList(todos)
	},

	cancelAutoApproval: async (provider) => {
		// Cancel any pending auto-approval timeout for the current task
		provider.getCurrentTask()?.cancelAutoApprovalTimeout()
	},

	autoApprovalEnabled: async (provider, message) => {
		await provider.contextProxy.setValue("autoApprovalEnabled", message.bool ?? false)
		await provider.postStateToWebview()
	},

	setAutonomyMode: async (provider, message) => {
		await provider.setAutonomyMode(message.autonomyMode ?? DEFAULT_AUTONOMY_MODE)
	},
}
