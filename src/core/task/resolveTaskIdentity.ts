import type { HistoryItem, TaskMetadata } from "@openai-agent/types"

/**
 * Task の同一性（id 群）と作業対象（metadata / workspacePath）を options から決める純関数。
 *
 * 「historyItem があればそちらが勝つ」という規則が constructor 内に 5 つの三項演算子
 * として散らばっていたのを 1 箇所に集約したもの。id 生成と workspace の既定値解決だけ
 * 副作用なので deps で注入する（=この module は vscode にも uuid にも依存しない）。
 */
export interface TaskIdentityInput {
	taskId?: string
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	rootTask?: { taskId: string }
	parentTask?: { taskId: string; workspacePath: string }
	workspacePath?: string
}

export interface TaskIdentityDeps {
	/** 新規 task の id。`taskId` option / historyItem のどちらも無いときだけ呼ばれる。 */
	generateTaskId: () => string
	/** 同一 taskId の再構築を区別するための instance 識別子。 */
	generateInstanceId: () => string
	/** parentTask も workspacePath option も無いときの既定 workspace。 */
	resolveDefaultWorkspacePath: () => string
}

export interface TaskIdentity {
	taskId: string
	instanceId: string
	rootTaskId?: string
	parentTaskId?: string
	metadata: TaskMetadata
	workspacePath: string
}

export function resolveTaskIdentity(input: TaskIdentityInput, deps: TaskIdentityDeps): TaskIdentity {
	const { historyItem, parentTask } = input

	return {
		taskId: historyItem ? historyItem.id : (input.taskId ?? deps.generateTaskId()),
		instanceId: deps.generateInstanceId(),
		rootTaskId: historyItem ? historyItem.rootTaskId : input.rootTask?.taskId,
		parentTaskId: historyItem ? historyItem.parentTaskId : parentTask?.taskId,
		metadata: {
			task: historyItem ? historyItem.task : input.task,
			// 再開時の images は履歴側に持たないので常に空（新規 task のみ引き継ぐ）。
			images: historyItem ? [] : input.images,
		},
		// Normal use-case is usually retry similar history task with new workspace.
		// 子 task は親の workspace を必ず引き継ぐ（historyItem.workspace より優先）。
		workspacePath: parentTask
			? parentTask.workspacePath
			: (input.workspacePath ?? deps.resolveDefaultWorkspacePath()),
	}
}
