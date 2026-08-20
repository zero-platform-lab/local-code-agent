import { AgentEventName } from "@openai-agent/types"

/**
 * `Task.abortTask()` の実装本体。
 *
 * abort/abandoned フラグの立て、error counter のリセット、
 * final token usage の emit、TaskAborted event の emit、dispose、
 * clineMessages の永続化まで一括で行う。
 *
 * dispose や save で例外が出ても abort 自体は必ず成功させる（呼び出し側は
 * この関数から rethrow を受けない）。
 */
export interface AbortTaskHost {
	abandoned: boolean
	abort: boolean
	graceRetry: { resetAll(): void }
	taskId: string
	instanceId: string
	tokenUsageTracker: { emitFinal(): void }
	emit: (event: AgentEventName.TaskAborted) => unknown
	dispose: () => void
	saveClineMessages: () => Promise<boolean>
}

export async function runAbortTask(host: AbortTaskHost, isAbandoned: boolean): Promise<void> {
	// Will stop any autonomously running promises.
	if (isAbandoned) {
		host.abandoned = true
	}

	host.abort = true

	// Reset consecutive error counters on abort (manual intervention)
	host.graceRetry.resetAll()

	// Force final token usage update before abort event
	host.tokenUsageTracker.emitFinal()

	host.emit(AgentEventName.TaskAborted)

	try {
		host.dispose() // Call the centralized dispose method
	} catch (error) {
		console.error(`Error during task ${host.taskId}.${host.instanceId} disposal:`, error)
		// Don't rethrow - we want abort to always succeed
	}

	// Save the countdown message in the automatic retry or other content.
	try {
		await host.saveClineMessages()
	} catch (error) {
		console.error(`Error saving messages during abort for task ${host.taskId}.${host.instanceId}:`, error)
	}
}
