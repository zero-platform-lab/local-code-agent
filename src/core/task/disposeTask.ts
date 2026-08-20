import * as path from "path"

import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { getTaskDirectoryPath } from "../../utils/storage"

import { AgentIgnoreController } from "../ignore/AgentIgnoreController"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { MessageQueueService } from "../message-queue/MessageQueueService"

import type { TaskSubscriptions } from "./TaskSubscriptions"

/**
 * Task の dispose を担うヘルパー。
 *
 * リソース cleanup を try-catch で個別に包む構造は元コード通り。ある cleanup が
 * 失敗しても他の cleanup は続行する（メモリリーク回避が最優先）。
 *
 * 外部 emitter への購読解除は `TaskSubscriptions` が所有する（旧実装は
 * `providerProfileChangeListener` / `messageQueueStateChangedHandler` を
 * host の mutable field 経由で受け取り、ここで off していた）。
 */
export interface DisposeTaskStateHost {
	taskId: string
	instanceId: string | number
	globalStoragePath: string
	subscriptions: TaskSubscriptions
	messageQueueService: MessageQueueService
	rooIgnoreController?: AgentIgnoreController
	fileContextTracker: FileContextTracker
	stream: { isStreaming: boolean }
	diffViewProvider: DiffViewProvider
	cancelCurrentRequest: () => void
	removeAllListeners: () => void
}

export interface DisposeTaskDeps {
	host: DisposeTaskStateHost
}

export function disposeTask(deps: DisposeTaskDeps): void {
	const { host } = deps
	console.log(`[Task#dispose] disposing task ${host.taskId}.${host.instanceId}`)

	// Cancel any in-progress HTTP request
	try {
		host.cancelCurrentRequest()
	} catch (error) {
		console.error("Error cancelling current request:", error)
	}

	// Unsubscribe from external emitters (message queue / provider profile).
	// disposeAll() は個々の失敗を内部で握り潰すので throw しない。
	host.subscriptions.disposeAll()

	// Dispose message queue.
	try {
		host.messageQueueService.dispose()
	} catch (error) {
		console.error("Error disposing message queue:", error)
	}

	// Remove all event listeners to prevent memory leaks.
	try {
		host.removeAllListeners()
	} catch (error) {
		console.error("Error removing event listeners:", error)
	}

	// Release any terminals associated with this task.
	try {
		TerminalRegistry.releaseTerminalsForTask(host.taskId)
	} catch (error) {
		console.error("Error releasing terminals:", error)
	}

	// Cleanup command output artifacts
	getTaskDirectoryPath(host.globalStoragePath, host.taskId)
		.then((taskDir) => {
			const outputDir = path.join(taskDir, "command-output")
			return OutputInterceptor.cleanup(outputDir)
		})
		.catch((error) => {
			console.error("Error cleaning up command output artifacts:", error)
		})

	try {
		if (host.rooIgnoreController) {
			host.rooIgnoreController.dispose()
			host.rooIgnoreController = undefined
		}
	} catch (error) {
		console.error("Error disposing AgentIgnoreController:", error)
		// This is the critical one for the leak fix.
	}

	try {
		host.fileContextTracker.dispose()
	} catch (error) {
		console.error("Error disposing file context tracker:", error)
	}

	try {
		// If we're not streaming then `abortStream` won't be called.
		if (host.stream.isStreaming && host.diffViewProvider.isEditing) {
			host.diffViewProvider.revertChanges().catch(console.error)
		}
	} catch (error) {
		console.error("Error reverting diff changes:", error)
	}
}
