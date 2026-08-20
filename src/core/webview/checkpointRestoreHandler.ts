import { saveTaskMessages } from "../task-persistence"
import * as vscode from "vscode"
import pWaitFor from "p-wait-for"
import { ClineMessage, HistoryItem } from "@openai-agent/types"
import { t } from "../../i18n"
import type { ContextProxy } from "../config/ContextProxy"

/**
 * Narrow surface of ClineProvider consumed by this handler. Declared locally
 * so this module does not import the concrete ClineProvider (which would form
 * the webview cycle via ClineProvider → webviewMessageHandler →
 * checkpointRestoreHandler).
 */
export interface CheckpointRestoreProvider {
	readonly contextProxy: ContextProxy
	readonly pendingEditOperations: {
		set(
			operationId: string,
			value: {
				messageTs: number
				editedContent: string
				images?: string[]
				messageIndex: number
				apiConversationHistoryIndex: number
			},
		): unknown
	}
	getCurrentTask(): { taskId: string; isInitialized?: boolean } | undefined
	getTaskWithId(taskId: string): Promise<{ historyItem: HistoryItem }>
	createTaskWithHistoryItem(historyItem: HistoryItem): Promise<unknown>
}

/**
 * Narrow structural view of {@link Task} required by the checkpoint-restore handler.
 * Declared as an interface (rather than importing the concrete `Task`) so this
 * module does not depend on the task layer. `Task` satisfies it structurally.
 *
 * `checkpointRestore`'s options are inlined (rather than importing
 * `CheckpointRestoreOptions` from `../checkpoints`) to avoid a module cycle.
 */
export interface CheckpointRestoreTask {
	readonly abort: boolean
	abortTask(): Promise<void>
	readonly taskId: string
	readonly messageStore: { clineMessages: ClineMessage[] }
	checkpointRestore(options: {
		ts: number
		commitHash: string
		mode: "preview" | "restore"
		operation?: "delete" | "edit"
	}): Promise<void>
}

export interface CheckpointRestoreConfig {
	provider: CheckpointRestoreProvider
	currentCline: CheckpointRestoreTask
	messageTs: number
	messageIndex: number
	checkpoint: { hash: string }
	operation: "delete" | "edit"
	editData?: {
		editedContent: string
		images?: string[]
		apiConversationHistoryIndex: number
	}
}

/**
 * Handles checkpoint restoration for both delete and edit operations.
 * This consolidates the common logic while handling operation-specific behavior.
 */
export async function handleCheckpointRestoreOperation(config: CheckpointRestoreConfig): Promise<void> {
	const { provider, currentCline, messageTs, checkpoint, operation, editData } = config

	try {
		// For delete operations, ensure the task is properly aborted to handle any pending ask operations
		// This prevents "Current ask promise was ignored" errors
		// For edit operations, we don't abort because the checkpoint restore will handle it
		if (operation === "delete" && currentCline && !currentCline.abort) {
			currentCline.abortTask()
			// Wait a bit for the abort to complete
			await pWaitFor(() => currentCline.abort === true, {
				timeout: 1000,
				interval: 50,
			}).catch(() => {
				// Continue even if timeout - the abort flag should be set
			})
		}

		// For edit operations, set up pending edit data before restoration
		if (operation === "edit" && editData) {
			const operationId = `task-${currentCline.taskId}`
			provider.pendingEditOperations.set(operationId, {
				messageTs,
				editedContent: editData.editedContent,
				images: editData.images,
				messageIndex: config.messageIndex,
				apiConversationHistoryIndex: editData.apiConversationHistoryIndex,
			})
		}

		// Perform the checkpoint restoration
		await currentCline.checkpointRestore({
			ts: messageTs,
			commitHash: checkpoint.hash,
			mode: "restore",
			operation,
		})

		// For delete operations, we need to save messages and reinitialize
		// For edit operations, the reinitialization happens automatically
		// and processes the pending edit
		if (operation === "delete") {
			// Save the updated messages to disk after checkpoint restoration
			await saveTaskMessages({
				messages: currentCline.messageStore.clineMessages,
				taskId: currentCline.taskId,
				globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
			})

			// Get the updated history item and reinitialize
			const { historyItem } = await provider.getTaskWithId(currentCline.taskId)
			await provider.createTaskWithHistoryItem(historyItem)
		}
		// For edit operations, the task cancellation in checkpointRestore
		// will trigger reinitialization, which will process pendingEditAfterRestore
	} catch (error) {
		console.error(`Error in checkpoint restore (${operation}):`, error)
		vscode.window.showErrorMessage(
			`Error during checkpoint restore: ${error instanceof Error ? error.message : String(error)}`,
		)
		throw error
	}
}

/**
 * Common checkpoint restore validation and initialization utility.
 * This can be used by any checkpoint restore flow that needs to wait for initialization.
 */
export async function waitForClineInitialization(
	provider: CheckpointRestoreProvider,
	timeoutMs: number = 3000,
): Promise<boolean> {
	try {
		await pWaitFor(() => provider.getCurrentTask()?.isInitialized === true, {
			timeout: timeoutMs,
		})
		return true
	} catch (_error) {
		vscode.window.showErrorMessage(t("common:errors.checkpoint_timeout"))
		return false
	}
}
