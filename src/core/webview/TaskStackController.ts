import { type HistoryItem, AgentEventName } from "@openai-agent/types"

import { t } from "../../i18n"

/** タスクスタックが保持するタスクの最小表面（実 Task が構造的に満たす）。 */
export interface StackTask {
	readonly taskId: string
	readonly parentTaskId?: string
	readonly instanceId: string
	emit(eventName: AgentEventName, ...args: unknown[]): void
	abortTask(isAbandoned: boolean): Promise<void>
}

export interface TaskStackDeps {
	log(message: string): void
	getState(): Promise<{ mode?: unknown }>
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]>
}

/**
 * タスクスタック（委譲でネストするタスク列）と各タスクのイベントリスナ cleanup を
 * 所有・管理する。ClineProvider から task lifecycle の spine を分離したもの。
 * pop 時の abort・リスナ掃除・親メタデータ修復のオーケストレーションもここに集約する。
 */
export class TaskStackController {
	private readonly stack: StackTask[]
	private readonly cleanupFns = new WeakMap<StackTask, Array<() => void>>()

	constructor(
		private readonly deps: TaskStackDeps,
		initialStack: StackTask[] = [],
	) {
		this.stack = [...initialStack]
	}

	get size(): number {
		return this.stack.length
	}

	/** 現在のスタック内容の読み取りビュー（先頭=root、末尾=current）。 */
	get items(): readonly StackTask[] {
		return this.stack
	}

	taskIds(): string[] {
		return this.stack.map((task) => task.taskId)
	}

	getCurrent(): StackTask | undefined {
		if (this.stack.length === 0) {
			return undefined
		}
		return this.stack[this.stack.length - 1]
	}

	getRoot(): StackTask | undefined {
		return this.stack.length > 0 ? this.stack[0] : undefined
	}

	findByTaskId(taskId: string): StackTask | undefined {
		for (let i = this.stack.length - 1; i >= 0; i--) {
			if (this.stack[i].taskId === taskId) {
				return this.stack[i]
			}
		}
		return undefined
	}

	/** タスクのイベントリスナ cleanup 関数群を登録する。 */
	setCleanup(task: StackTask, cleanupFns: Array<() => void>): void {
		this.cleanupFns.set(task, cleanupFns)
	}

	/** 新しいタスクをスタック最上位に積む（getState でモード解決を検証）。 */
	async add(task: StackTask): Promise<void> {
		this.stack.push(task)
		task.emit(AgentEventName.TaskFocused)

		// Ensure getState() resolves correctly.
		const state = await this.deps.getState()

		if (!state || typeof state.mode !== "string") {
			throw new Error(t("common:errors.retrieve_current_mode"))
		}
	}

	/**
	 * 最上位タスクを取り除いて破棄し、直前のタスクを再アクティブ化する。
	 * abort → リスナ掃除 → 委譲された子だった場合は親メタデータを修復する。
	 */
	async removeTop(options?: { skipDelegationRepair?: boolean }): Promise<void> {
		if (this.stack.length === 0) {
			return
		}

		// Pop the top Cline instance from the stack.
		let task = this.stack.pop()

		if (task) {
			// Capture delegation metadata before abort/dispose, since abortTask(true)
			// is async and the task reference is cleared afterwards.
			const childTaskId = task.taskId
			const parentTaskId = task.parentTaskId

			task.emit(AgentEventName.TaskUnfocused)

			try {
				// Abort the running task and set isAbandoned to true so
				// all running promises will exit as well.
				await task.abortTask(true)
			} catch (e) {
				this.deps.log(
					`[ClineProvider#removeClineFromStack] abortTask() failed ${task.taskId}.${task.instanceId}: ${(e as Error).message}`,
				)
			}

			// Remove event listeners before clearing the reference.
			const cleanupFunctions = this.cleanupFns.get(task)

			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.cleanupFns.delete(task)
			}

			// Make sure no reference kept, once promises end it will be
			// garbage collected.
			task = undefined

			// Delegation-aware parent metadata repair:
			// If the popped task was a delegated child, repair the parent's metadata
			// so it transitions from "delegated" back to "active" and becomes resumable
			// from the task history list.
			if (parentTaskId && childTaskId && !options?.skipDelegationRepair) {
				try {
					const { historyItem: parentHistory } = await this.deps.getTaskWithId(parentTaskId)

					if (parentHistory.status === "delegated" && parentHistory.awaitingChildId === childTaskId) {
						await this.deps.updateTaskHistory({
							...parentHistory,
							status: "active",
							awaitingChildId: undefined,
						})
						this.deps.log(
							`[ClineProvider#removeClineFromStack] Repaired parent ${parentTaskId} metadata: delegated → active (child ${childTaskId} removed)`,
						)
					}
				} catch (err) {
					// Non-fatal: log but do not block the pop operation.
					this.deps.log(
						`[ClineProvider#removeClineFromStack] Failed to repair parent metadata for ${parentTaskId} (non-fatal): ${
							err instanceof Error ? err.message : String(err)
						}`,
					)
				}
			}
		}
	}

	/**
	 * 最上位タスクを新しいインスタンスに置き換える（UI ちらつき回避の in-place 差し替え）。
	 * 旧タスクは abort＆リスナ掃除する。
	 */
	async replaceTop(task: StackTask): Promise<void> {
		const stackIndex = this.stack.length - 1

		// Properly dispose of the old task to ensure garbage collection
		const oldTask = this.stack[stackIndex]

		// Abort the old task to stop running processes and mark as abandoned
		try {
			await oldTask.abortTask(true)
		} catch (e) {
			this.deps.log(
				`[createTaskWithHistoryItem] abortTask() failed for old task ${oldTask.taskId}.${oldTask.instanceId}: ${(e as Error).message}`,
			)
		}

		// Remove event listeners from the old task
		const cleanupFunctions = this.cleanupFns.get(oldTask)
		if (cleanupFunctions) {
			cleanupFunctions.forEach((cleanup) => cleanup())
			this.cleanupFns.delete(oldTask)
		}

		// Replace the task in the stack
		this.stack[stackIndex] = task
		task.emit(AgentEventName.TaskFocused)
	}

	/** スタックの全タスクを removeTop で順に破棄する。 */
	async clearAll(): Promise<void> {
		while (this.stack.length > 0) {
			await this.removeTop()
		}
	}
}
