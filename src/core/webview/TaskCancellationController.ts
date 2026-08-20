import pWaitFor from "p-wait-for"

import { type HistoryItem } from "@openai-agent/types"

/**
 * キャンセル対象タスクの最小表面。実 Task が構造的に満たす。
 * rootTask / parentTask はそのまま createTaskWithHistoryItem へ素通しするため
 * 具体型を要求せず（generic の TTask 側で解決する）。
 */
export interface CancellableTask {
	readonly taskId: string
	readonly instanceId: string
	readonly rootTask?: unknown
	readonly parentTask?: unknown
	abortReason?: string
	abandoned: boolean
	readonly stream: {
		readonly isStreaming: boolean
		readonly isWaitingForFirstChunk: boolean
	}
	readonly didFinishAbortingStream: boolean
	cancelCurrentRequest(): void
	abortTask(): void
}

export interface TaskCancellationDeps<TTask extends CancellableTask> {
	getCurrentTask(): TTask | undefined
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	createTaskWithHistoryItem(
		item: HistoryItem & { rootTask?: TTask["rootTask"]; parentTask?: TTask["parentTask"] },
	): Promise<unknown>
	log(message: string): void
}

/**
 * 現在タスクのユーザー起因キャンセル（cancelTask）を ClineProvider から分離したもの。
 * 進行中 HTTP リクエストの即時中断 → abort → グレースフル待機 → 同一インスタンスの
 * 履歴からの再水和（flicker-free rehydrate）までのオーケストレーションを担う。
 */
export class TaskCancellationController<TTask extends CancellableTask> {
	constructor(private readonly deps: TaskCancellationDeps<TTask>) {}

	async cancel(): Promise<void> {
		const task = this.deps.getCurrentTask()

		if (!task) {
			return
		}

		console.log(`[cancelTask] cancelling task ${task.taskId}.${task.instanceId}`)

		let historyItem: HistoryItem | undefined
		try {
			const history = await this.deps.getTaskWithId(task.taskId)
			historyItem = history.historyItem
		} catch (error) {
			// During task startup there is a short window where currentTask exists
			// but task history has not been persisted yet. Cancelling should still
			// abort safely; we just skip post-cancel rehydration in that case.
			//
			// 履歴が取れない理由が何であれ、停止は必ず行う。以前は "Task not found" 以外を
			// 再 throw していたため、ストレージ障害のときに abort へ一度も到達せず、
			// 「停止ボタンを押したのにタスクが走り続ける」状態になっていた。
			// 停止できないことのほうが、再水和できないことより重い。
			if (error instanceof Error && error.message === "Task not found") {
				this.deps.log(`[cancelTask] task history missing for ${task.taskId}; skipping rehydrate`)
			} else {
				this.deps.log(
					`[cancelTask] failed to read task history for ${task.taskId}; aborting anyway: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		}

		// Preserve parent and root task information for history item.
		const rootTask = task.rootTask
		const parentTask = task.parentTask

		// Mark this as a user-initiated cancellation so provider-only rehydration can occur
		task.abortReason = "user_cancelled"

		// Capture the current instance to detect if rehydrate already occurred elsewhere
		const originalInstanceId = task.instanceId

		// Immediately cancel the underlying HTTP request if one is in progress
		// This ensures the stream fails quickly rather than waiting for network timeout
		task.cancelCurrentRequest()

		try {
			// Begin abort (non-blocking)
			task.abortTask()
		} catch (error) {
			// abortTask が投げても abandoned は必ず立てる。ここを飛ばすと
			// 中途半端に abort されただけの非 abandoned インスタンスが残り、
			// 残留処理が動き続ける。
			this.deps.log(
				`[cancelTask] abortTask threw for ${task.taskId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		// Immediately mark the original instance as abandoned to prevent any residual activity
		task.abandoned = true

		await pWaitFor(
			() =>
				this.deps.getCurrentTask()! === undefined ||
				this.deps.getCurrentTask()!.stream.isStreaming === false ||
				this.deps.getCurrentTask()!.didFinishAbortingStream ||
				// If only the first chunk is processed, then there's no
				// need to wait for graceful abort (closes edits, browser,
				// etc).
				this.deps.getCurrentTask()!.stream.isWaitingForFirstChunk,
			{
				timeout: 3_000,
			},
		).catch(() => {
			console.error("Failed to abort task")
		})

		// Defensive safeguard: if current instance already changed, skip rehydrate
		const current = this.deps.getCurrentTask()
		if (current && current.instanceId !== originalInstanceId) {
			this.deps.log(
				`[cancelTask] Skipping rehydrate: current instance ${current.instanceId} != original ${originalInstanceId}`,
			)
			return
		}

		// Final race check before rehydrate to avoid duplicate rehydration
		{
			const currentAfterCheck = this.deps.getCurrentTask()
			if (currentAfterCheck && currentAfterCheck.instanceId !== originalInstanceId) {
				this.deps.log(
					`[cancelTask] Skipping rehydrate after final check: current instance ${currentAfterCheck.instanceId} != original ${originalInstanceId}`,
				)
				return
			}
		}

		if (!historyItem) {
			return
		}

		// Clears task again, so we need to abortTask manually above.
		await this.deps.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
	}
}
