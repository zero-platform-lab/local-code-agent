import * as vscode from "vscode"

import { type ClineMessage, type TodoItem, type HistoryItem, AgentEventName } from "@openai-agent/types"

import type { Mode } from "../../shared/modes"
import { type ApiMessage, readApiMessages, saveApiMessages, saveTaskMessages } from "../task-persistence"
import { textMessage } from "../task-persistence/agentMessageUtils"
import { messageToAgentItems } from "../task-persistence/migrateLegacyApiMessages"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { validateAndFixToolResultIds } from "../task/validateToolResultIds"

/**
 * 委譲で操作する Task の最小表面。実際の Task はこれを構造的に満たすため、
 * 本コントローラは Task 具象型を import せずに済み、循環依存を増やさない。
 */
export interface DelegationTask {
	readonly taskId: string
	flushPendingToolResultsToHistory(): Promise<boolean>
	retrySaveApiConversationHistory(): Promise<boolean>
	start(): unknown
	overwriteClineMessages(messages: ClineMessage[]): Promise<void>
	overwriteApiConversationHistory(messages: unknown[]): Promise<void>
	resumeAfterDelegation(): Promise<void>
}

/**
 * 委譲コントローラが ClineProvider から必要とする依存（タスクライフサイクル操作）。
 */
export interface TaskDelegationDeps {
	log(message: string): void
	emit(eventName: AgentEventName, ...args: unknown[]): void
	getCurrentTask(): DelegationTask | undefined
	removeClineFromStack(options?: { skipDelegationRepair?: boolean }): Promise<void>
	handleModeSwitch(mode: Mode): Promise<void>
	createTask(
		text: string,
		images: string[] | undefined,
		parentTask: DelegationTask,
		options: { initialTodos?: TodoItem[]; initialStatus?: HistoryItem["status"]; startTask?: boolean },
	): Promise<DelegationTask>
	createTaskWithHistoryItem(
		historyItem: HistoryItem,
		options?: { startTask?: boolean },
	): Promise<DelegationTask | undefined>
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]>
	readonly globalStoragePath: string
}

/**
 * 親→子タスク委譲（new_task）と、子完了時の親再開のオーケストレーションを
 * ClineProvider から分離したもの。タスクスタック/履歴/モード切替の各操作は
 * deps 経由で ClineProvider に委譲する（所有権は ClineProvider 側のまま）。
 */
export class TaskDelegationController {
	constructor(private readonly deps: TaskDelegationDeps) {}

	async delegateParentAndOpenChild(params: {
		parentTaskId: string
		message: string
		initialTodos: TodoItem[]
		mode: string
	}): Promise<DelegationTask> {
		const { parentTaskId, message, initialTodos, mode } = params

		// Metadata-driven delegation is always enabled

		// 1) Get parent (must be current task)
		const parent = this.deps.getCurrentTask()
		if (!parent) {
			throw new Error("[delegateParentAndOpenChild] No current task")
		}
		if (parent.taskId !== parentTaskId) {
			throw new Error(
				`[delegateParentAndOpenChild] Parent mismatch: expected ${parentTaskId}, current ${parent.taskId}`,
			)
		}
		// 2) Flush pending tool results to API history BEFORE disposing the parent.
		//    This is critical: when tools are called before new_task,
		//    their tool_result blocks are in userMessageContent but not yet saved to API history.
		//    If we don't flush them, the parent's API conversation will be incomplete and
		//    cause 400 errors when resumed (missing tool_result for tool_use blocks).
		//
		//    NOTE: We do NOT pass the assistant message here because the assistant message
		//    is already added to apiConversationHistory by the normal flow in
		//    recursivelyMakeClineRequests BEFORE tools start executing. We only need to
		//    flush the pending user message with tool_results.
		try {
			const flushSuccess = await parent.flushPendingToolResultsToHistory()

			if (!flushSuccess) {
				console.warn(`[delegateParentAndOpenChild] Flush failed for parent ${parentTaskId}, retrying...`)
				const retrySuccess = await parent.retrySaveApiConversationHistory()

				if (!retrySuccess) {
					console.error(
						`[delegateParentAndOpenChild] CRITICAL: Parent ${parentTaskId} API history not persisted to disk. Child return may produce stale state.`,
					)
					vscode.window.showWarningMessage(
						"Warning: Parent task state could not be saved. The parent task may lose recent context when resumed.",
					)
				}
			}
		} catch (error) {
			this.deps.log(
				`[delegateParentAndOpenChild] Error flushing pending tool results (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		// 3) Enforce single-open invariant by closing/disposing the parent first
		//    This ensures we never have >1 tasks open at any time during delegation.
		//    Await abort completion to ensure clean disposal and prevent unhandled rejections.
		try {
			await this.deps.removeClineFromStack({ skipDelegationRepair: true })
		} catch (error) {
			this.deps.log(
				`[delegateParentAndOpenChild] Error during parent disposal (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			// Non-fatal: proceed with child creation even if parent cleanup had issues
		}

		// 3) Switch provider mode to child's requested mode BEFORE creating the child task
		//    This ensures the child's system prompt and configuration are based on the correct mode.
		//    The mode switch must happen before createTask() because the Task constructor
		//    initializes its mode from provider.getState() during initializeTaskMode().
		try {
			await this.deps.handleModeSwitch(mode as Mode)
		} catch (e) {
			this.deps.log(
				`[delegateParentAndOpenChild] handleModeSwitch failed for mode '${mode}': ${
					(e as Error)?.message ?? String(e)
				}`,
			)
		}

		// 4) Create child as sole active (parent reference preserved for lineage)
		// Pass initialStatus: "active" to ensure the child task's historyItem is created
		// with status from the start, avoiding race conditions where the task might
		// call attempt_completion before status is persisted separately.
		//
		// Pass startTask: false to prevent the child from beginning its task loop
		// (and writing to globalState via saveClineMessages → updateTaskHistory)
		// before we persist the parent's delegation metadata in step 5.
		// Without this, the child's fire-and-forget startTask() races with step 5,
		// and the last writer to globalState overwrites the other's changes—
		// causing the parent's delegation fields to be lost.
		const child = await this.deps.createTask(message, undefined, parent, {
			initialTodos,
			initialStatus: "active",
			startTask: false,
		})

		// 5) Persist parent delegation metadata BEFORE the child starts writing.
		try {
			const { historyItem } = await this.deps.getTaskWithId(parentTaskId)
			const childIds = Array.from(new Set([...(historyItem.childIds ?? []), child.taskId]))
			const updatedHistory: typeof historyItem = {
				...historyItem,
				status: "delegated",
				delegatedToId: child.taskId,
				awaitingChildId: child.taskId,
				childIds,
			}
			await this.deps.updateTaskHistory(updatedHistory)
		} catch (err) {
			this.deps.log(
				`[delegateParentAndOpenChild] Failed to persist parent metadata for ${parentTaskId} -> ${child.taskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 6) Start the child task now that parent metadata is safely persisted.
		child.start()

		// 7) Emit TaskDelegated (provider-level)
		try {
			this.deps.emit(AgentEventName.TaskDelegated, parentTaskId, child.taskId)
		} catch {
			// non-fatal
		}

		return child
	}

	/**
	 * Reopen parent task from delegation with write-back and events.
	 */
	async reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void> {
		const { parentTaskId, childTaskId, completionResultSummary } = params
		const globalStoragePath = this.deps.globalStoragePath

		// 1) Load parent from history and current persisted messages
		const { historyItem } = await this.deps.getTaskWithId(parentTaskId)

		let parentClineMessages: ClineMessage[] = []
		try {
			parentClineMessages = await readTaskMessages({
				taskId: parentTaskId,
				globalStoragePath,
			})
		} catch {
			parentClineMessages = []
		}

		let parentApiMessages: ApiMessage[] = []
		try {
			parentApiMessages = await readApiMessages({
				taskId: parentTaskId,
				globalStoragePath,
			})
		} catch {
			parentApiMessages = []
		}

		// 2) Inject synthetic records: UI subtask_result and update API tool_result
		const ts = Date.now()

		// Defensive: ensure arrays
		if (!Array.isArray(parentClineMessages)) parentClineMessages = []
		if (!Array.isArray(parentApiMessages)) parentApiMessages = []

		const subtaskUiMessage: ClineMessage = {
			type: "say",
			say: "subtask_result",
			text: completionResultSummary,
			ts,
		}
		parentClineMessages.push(subtaskUiMessage)
		await saveTaskMessages({ messages: parentClineMessages, taskId: parentTaskId, globalStoragePath })

		// 履歴は item 列なので、new_task の呼び出しは message の content ではなく
		// 独立した `function_call` item として並んでいる。末尾から探す。
		const resultText = `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`
		let newTaskCallId: string | undefined
		for (let i = parentApiMessages.length - 1; i >= 0; i--) {
			const item = parentApiMessages[i]
			if (item?.type === "function_call" && item.name === "new_task") {
				newTaskCallId = item.call_id
				break
			}
		}

		// Preferred: if the parent history contains the native call for new_task,
		// answer it with a matching `function_call_output` item.
		if (newTaskCallId) {
			// 既に結果 item がある（復帰のリトライ・二重実行）なら中身だけ差し替える。
			const existingOutput = parentApiMessages.find(
				(item) => item?.type === "function_call_output" && item.call_id === newTaskCallId,
			)

			if (existingOutput && existingOutput.type === "function_call_output") {
				existingOutput.output = resultText
			} else {
				// 同じ assistant ターンに他の未応答の呼び出しがあれば一緒に埋めたいので、
				// 従来どおり validateAndFixToolResultIds を通してから item 列へ落とす。
				const validated = validateAndFixToolResultIds(
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: newTaskCallId, content: resultText }],
					},
					parentApiMessages,
				)
				parentApiMessages.push(...messageToAgentItems("user", validated.content, { ts }))
			}
		} else {
			// If there is no corresponding function_call in the parent API history, we cannot emit a
			// function_call_output. Fall back to a plain user text note so the parent can still resume.
			parentApiMessages.push(textMessage("user", resultText, { ts }))
		}

		await saveApiMessages({ messages: parentApiMessages, taskId: parentTaskId, globalStoragePath })

		// 3) Close child instance if still open (single-open-task invariant).
		//    This MUST happen BEFORE updating the child's status to "completed" because
		//    removeClineFromStack() → abortTask(true) → saveClineMessages() writes
		//    the historyItem with initialStatus (typically "active"), which would
		//    overwrite a "completed" status set earlier.
		const current = this.deps.getCurrentTask()
		if (current?.taskId === childTaskId) {
			await this.deps.removeClineFromStack()
		}

		// 4) Update child metadata to "completed" status.
		//    This runs after the abort so it overwrites the stale "active" status
		//    that saveClineMessages() may have written during step 3.
		try {
			const { historyItem: childHistory } = await this.deps.getTaskWithId(childTaskId)
			await this.deps.updateTaskHistory({
				...childHistory,
				status: "completed",
			})
		} catch (err) {
			this.deps.log(
				`[reopenParentFromDelegation] Failed to persist child completed status for ${childTaskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 5) Update parent metadata and persist BEFORE emitting completion event
		const childIds = Array.from(new Set([...(historyItem.childIds ?? []), childTaskId]))
		const updatedHistory: typeof historyItem = {
			...historyItem,
			status: "active",
			completedByChildId: childTaskId,
			completionResultSummary,
			awaitingChildId: undefined,
			childIds,
		}
		await this.deps.updateTaskHistory(updatedHistory)

		// 6) Emit TaskDelegationCompleted (provider-level)
		try {
			this.deps.emit(AgentEventName.TaskDelegationCompleted, parentTaskId, childTaskId, completionResultSummary)
		} catch {
			// non-fatal
		}

		// 7) Reopen the parent from history as the sole active task (restores saved mode)
		//    IMPORTANT: startTask=false to suppress resume-from-history ask scheduling
		const parentInstance = await this.deps.createTaskWithHistoryItem(updatedHistory, { startTask: false })

		// 8) Inject restored histories into the in-memory instance before resuming
		if (parentInstance) {
			try {
				await parentInstance.overwriteClineMessages(parentClineMessages)
			} catch {
				// non-fatal
			}
			try {
				await parentInstance.overwriteApiConversationHistory(parentApiMessages)
			} catch {
				// non-fatal
			}

			// Auto-resume parent without ask("resume_task")
			await parentInstance.resumeAfterDelegation()
		}

		// 9) Emit TaskDelegationResumed (provider-level)
		try {
			this.deps.emit(AgentEventName.TaskDelegationResumed, parentTaskId, childTaskId)
		} catch {
			// non-fatal
		}
	}
}
