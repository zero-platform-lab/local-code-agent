import { z } from "zod"

import { AgentEventName } from "./events.js"
import type { AgentSettings } from "./global-settings.js"
import type { ClineMessage, QueuedMessage, TokenUsage } from "./message.js"
import type { ToolUsage, ToolName } from "./tool.js"
import type { TodoItem } from "./todo.js"

/**
 * TaskProviderLike
 */

export interface TaskProviderLike {
	// Tasks
	getCurrentTask(): TaskLike | undefined
	getRecentTasks(): string[]
	createTask(
		text?: string,
		images?: string[],
		parentTask?: TaskLike,
		options?: CreateTaskOptions,
		configuration?: AgentSettings,
	): Promise<TaskLike>
	cancelTask(): Promise<void>
	clearTask(): Promise<void>
	resumeTask(taskId: string): void

	// Modes
	getModes(): Promise<{ slug: string; name: string }[]>
	getMode(): Promise<string>
	setMode(mode: string): Promise<void>

	// Provider Profiles
	getProviderProfiles(): Promise<{ name: string; provider?: string }[]>
	getProviderProfile(): Promise<string>
	setProviderProfile(providerProfile: string): Promise<void>

	readonly cwd: string

	// Event Emitter
	on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this

	off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this

	// @TODO: Find a better way to do this.
	postStateToWebview(): Promise<void>
}

export type TaskProviderEvents = {
	[AgentEventName.TaskCreated]: [task: TaskLike]
	[AgentEventName.TaskStarted]: [taskId: string]
	[AgentEventName.TaskCompleted]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
	[AgentEventName.TaskAborted]: [taskId: string]
	[AgentEventName.TaskFocused]: [taskId: string]
	[AgentEventName.TaskUnfocused]: [taskId: string]
	[AgentEventName.TaskActive]: [taskId: string]
	[AgentEventName.TaskInteractive]: [taskId: string]
	[AgentEventName.TaskResumable]: [taskId: string]
	[AgentEventName.TaskIdle]: [taskId: string]

	[AgentEventName.TaskPaused]: [taskId: string]
	[AgentEventName.TaskUnpaused]: [taskId: string]
	[AgentEventName.TaskSpawned]: [taskId: string]
	[AgentEventName.TaskDelegated]: [parentTaskId: string, childTaskId: string]
	[AgentEventName.TaskDelegationCompleted]: [parentTaskId: string, childTaskId: string, summary: string]
	[AgentEventName.TaskDelegationResumed]: [parentTaskId: string, childTaskId: string]

	[AgentEventName.TaskUserMessage]: [taskId: string]

	[AgentEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]

	[AgentEventName.ModeChanged]: [mode: string]
	[AgentEventName.ProviderProfileChanged]: [config: { name: string; provider?: string }]
}

/**
 * TaskLike
 */

export interface CreateTaskOptions {
	taskId?: string
	enableCheckpoints?: boolean
	consecutiveMistakeLimit?: number
	experiments?: Record<string, boolean>
	initialTodos?: TodoItem[]
	/** Initial status for the task's history item (e.g., "active" for child tasks) */
	initialStatus?: "active" | "delegated" | "completed"
	/** Whether to start the task loop immediately (default: true).
	 *  When false, the caller must invoke `task.start()` manually. */
	startTask?: boolean
}

export enum TaskStatus {
	Running = "running",
	Interactive = "interactive",
	Resumable = "resumable",
	Idle = "idle",
	None = "none",
}

export const taskMetadataSchema = z.object({
	task: z.string().optional(),
	images: z.array(z.string()).optional(),
})

export type TaskMetadata = z.infer<typeof taskMetadataSchema>

export interface TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	readonly childTaskId?: string
	readonly metadata: TaskMetadata
	readonly taskStatus: TaskStatus
	readonly taskAsk: ClineMessage | undefined
	readonly queuedMessages: QueuedMessage[]
	readonly tokenUsage: TokenUsage | undefined

	on<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this
	off<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this

	approveAsk(options?: { text?: string; images?: string[] }): void
	denyAsk(options?: { text?: string; images?: string[] }): void
	submitUserMessage(text: string, images?: string[], mode?: string, providerProfile?: string): Promise<void>
	abortTask(): void
}

export type TaskEvents = {
	// Task Lifecycle
	[AgentEventName.TaskStarted]: []
	[AgentEventName.TaskCompleted]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
	[AgentEventName.TaskAborted]: []
	[AgentEventName.TaskFocused]: []
	[AgentEventName.TaskUnfocused]: []
	[AgentEventName.TaskActive]: [taskId: string]
	[AgentEventName.TaskInteractive]: [taskId: string]
	[AgentEventName.TaskResumable]: [taskId: string]
	[AgentEventName.TaskIdle]: [taskId: string]

	// Subtask Lifecycle
	[AgentEventName.TaskPaused]: [taskId: string]
	[AgentEventName.TaskUnpaused]: [taskId: string]
	[AgentEventName.TaskSpawned]: [taskId: string]

	// Task Execution
	[AgentEventName.Message]: [{ action: "created" | "updated"; message: ClineMessage }]
	[AgentEventName.TaskModeSwitched]: [taskId: string, mode: string]
	[AgentEventName.TaskAskResponded]: []
	[AgentEventName.TaskUserMessage]: [taskId: string]
	[AgentEventName.QueuedMessagesUpdated]: [taskId: string, messages: QueuedMessage[]]

	// Task Analytics
	[AgentEventName.TaskToolFailed]: [taskId: string, tool: ToolName, error: string]
	[AgentEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
}
