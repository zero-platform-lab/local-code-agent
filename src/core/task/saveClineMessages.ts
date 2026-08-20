import type { HistoryItem } from "@openai-agent/types"

import { defaultModeSlug } from "../../shared/modes"
import { taskMetadata } from "../task-persistence"
import type { TaskMessageStore } from "./TaskMessageStore"
import type { TaskModeState } from "./TaskModeState"
import type { TokenUsageTracker } from "./TokenUsageTracker"

/**
 * `Task.saveClineMessages()` の実装本体。
 *
 * disk への永続化 → task メタデータ集計 → tokenUsageTracker debounce emit →
 * provider の updateTaskHistory 通知、の 4 段。どこかで例外が投げても既定は
 * false を返し、Task 自体は継続できるようにする既存動作を維持。
 */
export interface SaveClineMessagesStateHost {
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	taskNumber: number
	globalStoragePath: string
	cwd: string
	initialStatus?: "active" | "delegated" | "completed"
	messageStore: TaskMessageStore
	modeState: TaskModeState
	tokenUsageTracker: TokenUsageTracker
	providerRef: WeakRef<{ updateTaskHistory: (item: HistoryItem) => Promise<unknown> | unknown }>
}

export interface SaveClineMessagesDeps {
	host: SaveClineMessagesStateHost
}

export async function saveClineMessages(deps: SaveClineMessagesDeps): Promise<boolean> {
	const { host } = deps
	try {
		await host.messageStore.saveClineMessagesToDisk()

		if (host.modeState.apiConfigName === undefined) {
			await host.modeState.apiConfigReady
		}

		const { historyItem, tokenUsage } = await taskMetadata({
			taskId: host.taskId,
			rootTaskId: host.rootTaskId,
			parentTaskId: host.parentTaskId,
			taskNumber: host.taskNumber,
			messages: host.messageStore.clineMessages,
			globalStoragePath: host.globalStoragePath,
			workspace: host.cwd,
			// Use the task's own mode, not the current provider mode.
			mode: host.modeState.mode || defaultModeSlug,
			// Use the task's own provider profile, not the current provider profile.
			apiConfigName: host.modeState.apiConfigName,
			initialStatus: host.initialStatus,
		})

		// Emit token/tool usage updates using debounced function
		host.tokenUsageTracker.emitDebounced(tokenUsage, host.tokenUsageTracker.toolUsage)

		await deps.host.providerRef.deref()?.updateTaskHistory(historyItem)
		return true
	} catch (error) {
		console.error("Failed to save Agent messages:", error)
		return false
	}
}
