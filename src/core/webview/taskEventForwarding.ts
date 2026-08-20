import { AgentEventName, type HistoryItem, type TaskEvents } from "@openai-agent/types"

import type { Task } from "../task/Task"

/** イベント転送に必要な ClineProvider の最小表面（ClineProvider が構造的に満たす）。 */
export interface TaskEventForwardingHost {
	log(message: string): void
	getCurrentTask(): Task | undefined
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	createTaskWithHistoryItem(item: HistoryItem & { rootTask?: Task; parentTask?: Task }): Promise<unknown>
}

export interface TaskEventForwardingDeps {
	/** ClineProvider の typed emit は可変長引数で呼べないため呼び出し側で cast する。 */
	emit: (eventName: AgentEventName, ...args: unknown[]) => void
	/** listener 解除関数を TaskStackController に預ける（stack から pop される時に実行される）。 */
	setCleanup: (task: Task, cleanupFns: Array<() => void>) => void
}

/** task 側の引数（先頭が taskId）をそのまま provider へ中継するイベント。 */
const RELAYED_EVENTS = [
	AgentEventName.TaskCompleted,
	AgentEventName.TaskActive,
	AgentEventName.TaskInteractive,
	AgentEventName.TaskResumable,
	AgentEventName.TaskIdle,
	AgentEventName.TaskPaused,
	AgentEventName.TaskUnpaused,
	AgentEventName.TaskSpawned,
	AgentEventName.TaskUserMessage,
	AgentEventName.TaskTokenUsageUpdated,
] as const

/** task 側が引数を持たないため、provider へ流す際に taskId を補うイベント。 */
const TASK_ID_ONLY_EVENTS = [
	AgentEventName.TaskStarted,
	AgentEventName.TaskFocused,
	AgentEventName.TaskUnfocused,
] as const

type TaskListener = (...args: never[]) => void

/**
 * ストリーミング失敗による abort だけ、同じ履歴から task を作り直す。
 * ユーザー起因のキャンセルは cancelTask() が別途 rehydrate するのでここでは何もしない。
 */
async function rehydrateAfterStreamingFailure(host: TaskEventForwardingHost, instance: Task): Promise<void> {
	try {
		if (instance.abortReason !== "streaming_failed") {
			return
		}

		// 別経路が既に instance を差し替えていたら二重生成しない。
		const current = host.getCurrentTask()

		if (current && current.instanceId !== instance.instanceId) {
			host.log(
				`[onTaskAborted] Skipping rehydrate: current instance ${current.instanceId} != aborted ${instance.instanceId}`,
			)
			return
		}

		const { historyItem } = await host.getTaskWithId(instance.taskId)
		const rootTask = instance.rootTask
		const parentTask = instance.parentTask
		await host.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
	} catch (error) {
		host.log(
			`[onTaskAborted] Failed to rehydrate after streaming failure: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}

/**
 * task の lifecycle イベントを provider の同名イベントへ転送する `onCreated` callback を作る。
 * IPC 経由の API も同じ形でイベントを中継している。
 *
 * 登録した listener の解除関数は `deps.setCleanup` に預け、task が stack から外れた時に
 * まとめて外す（listener を配列から組み立てるので on/off の対応漏れが起きない）。
 */
export function makeTaskCreationCallback(
	host: TaskEventForwardingHost,
	deps: TaskEventForwardingDeps,
): (task: Task) => void {
	return (instance: Task) => {
		deps.emit(AgentEventName.TaskCreated, instance)

		const listeners: Array<[keyof TaskEvents, TaskListener]> = [
			...RELAYED_EVENTS.map(
				(event) =>
					[event, (...args: unknown[]) => deps.emit(event, ...args)] as [keyof TaskEvents, TaskListener],
			),
			...TASK_ID_ONLY_EVENTS.map(
				(event) => [event, () => deps.emit(event, instance.taskId)] as [keyof TaskEvents, TaskListener],
			),
			[
				AgentEventName.TaskAborted,
				async () => {
					deps.emit(AgentEventName.TaskAborted, instance.taskId)
					await rehydrateAfterStreamingFailure(host, instance)
				},
			],
		]

		for (const [event, listener] of listeners) {
			instance.on(event, listener)
		}

		deps.setCleanup(
			instance,
			listeners.map(
				([event, listener]) =>
					() =>
						instance.off(event, listener),
			),
		)
	}
}
