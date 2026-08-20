import fs from "fs/promises"

import { type HistoryItem } from "@openai-agent/types"

import { ShadowCheckpointService } from "../../services/checkpoints/ShadowCheckpointService"
import { isSafeTaskId } from "../../utils/storage"

export interface TaskDeletionDeps {
	/** id からタスクを引き当てる（存在しなければ "Task not found" を throw）。 */
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	/** 現在アクティブなタスクの id（なければ undefined）。 */
	getCurrentTaskId(): string | undefined
	/** 現在タスクをスタックから取り除く（委譲メタデータ修復込み）。 */
	removeClineFromStack(): Promise<void>
	/** 複数タスクを履歴ストアから一括削除する。 */
	deleteManyFromStore(ids: string[]): Promise<void>
	/** 最近タスクキャッシュを無効化する。 */
	invalidateRecentTasksCache(): void
	/** 履歴に存在しないタスクを state からだけ削除するフォールバック。 */
	deleteFromState(id: string): Promise<void>
	getGlobalStorageDir(): string
	getWorkspaceDir(): string
	postStateToWebview(): Promise<void>
}

/**
 * タスク履歴の削除（deleteTaskWithId）を ClineProvider から分離したもの。
 * 子タスクの再帰収集、スタックからの取り外し、履歴ストア削除、
 * shadow リポジトリ／タスクディレクトリの物理削除までを担う。
 */
export class TaskDeletionController {
	constructor(private readonly deps: TaskDeletionDeps) {}

	async deleteWithId(id: string, cascadeSubtasks: boolean = true): Promise<void> {
		try {
			// Ensure the task exists — a missing task throws "Task not found",
			// handled by the catch below (state-only removal).
			await this.deps.getTaskWithId(id)

			// Collect all task IDs to delete (parent + all subtasks).
			//
			// visited で二重訪問を防ぐ。childIds は履歴 JSON 由来なので、親子が相互に
			// 参照していると（A→B→A）この再帰は await を挟むぶんスタックも溢れず、
			// 止まらないまま allIdsToDelete が伸び続ける。同じ子が 2 回入っている
			// だけでも重複削除になる。
			const visited = new Set<string>([id])
			const allIdsToDelete: string[] = [id]

			if (cascadeSubtasks) {
				// Recursively collect all child IDs.
				const collectChildIds = async (taskId: string): Promise<void> => {
					try {
						const { historyItem: item } = await this.deps.getTaskWithId(taskId)
						if (item.childIds && item.childIds.length > 0) {
							for (const childId of item.childIds) {
								// 壊れた履歴に空文字や `..` が混ざっていると、後段の
								// getTaskDirectoryPath がタスクディレクトリの外を指す。
								// そこへ fs.rm(recursive, force) が飛ぶので、集める前に落とす。
								if (!isSafeTaskId(childId)) {
									console.warn(
										`[deleteTaskWithId] skipping unsafe child task id: ${JSON.stringify(childId)}`,
									)
									continue
								}
								if (visited.has(childId)) continue
								visited.add(childId)
								allIdsToDelete.push(childId)
								await collectChildIds(childId)
							}
						}
					} catch {
						// Child task may already be deleted or not found, continue.
						console.log(`[deleteTaskWithId] child task ${taskId} not found, skipping`)
					}
				}

				await collectChildIds(id)
			}

			// Remove from stack if any of the tasks to delete are the current task.
			for (const taskId of allIdsToDelete) {
				if (taskId === this.deps.getCurrentTaskId()) {
					// Close the current task instance; delegation flows are handled via metadata if applicable.
					await this.deps.removeClineFromStack()
					break
				}
			}

			// Delete all tasks from state in one batch.
			await this.deps.deleteManyFromStore(allIdsToDelete)
			this.deps.invalidateRecentTasksCache()

			// Delete associated shadow repositories or branches and task directories.
			const globalStorageDir = this.deps.getGlobalStorageDir()
			const workspaceDir = this.deps.getWorkspaceDir()
			const { getTaskDirectoryPath } = await import("../../utils/storage")

			for (const taskId of allIdsToDelete) {
				try {
					await ShadowCheckpointService.deleteTask({ taskId, globalStorageDir, workspaceDir })
				} catch (error) {
					console.error(
						`[deleteTaskWithId${taskId}] failed to delete associated shadow repository or branch: ${error instanceof Error ? error.message : String(error)}`,
					)
				}

				// Delete the task directory.
				try {
					const dirPath = await getTaskDirectoryPath(globalStorageDir, taskId)
					await fs.rm(dirPath, { recursive: true, force: true })
					console.log(`[deleteTaskWithId${taskId}] removed task directory`)
				} catch (error) {
					console.error(
						`[deleteTaskWithId${taskId}] failed to remove task directory: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			await this.deps.postStateToWebview()
		} catch (error) {
			// If task is not found, just remove it from state.
			if (error instanceof Error && error.message === "Task not found") {
				await this.deps.deleteFromState(id)
				return
			}
			throw error
		}
	}
}
