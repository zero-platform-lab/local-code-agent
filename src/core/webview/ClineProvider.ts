import EventEmitter from "events"

import * as vscode from "vscode"

import {
	type TaskProviderLike,
	type TaskProviderEvents,
	type GlobalState,
	type ProviderName,
	type ProviderSettings,
	type AgentSettings,
	type ProviderSettingsEntry,
	type HistoryItem,
	type CreateTaskOptions,
	type ExtensionMessage,
	type ExtensionState,
	type AutonomyMode,
	ORGANIZATION_ALLOW_ALL,
	DEFAULT_MODES,
	AUTONOMY_PRESETS,
} from "@openai-agent/types"
import { type AggregatedCosts } from "./aggregateTaskCosts"

import { Package } from "../../shared/package"
import { Mode } from "../../shared/modes"
import { WebviewMessage } from "../../shared/WebviewMessage"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"
import { ProfileValidator } from "../../shared/ProfileValidator"

import type WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

import type { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { CodeIndexManager } from "../../services/code-index/manager"
import type { SkillsManager } from "../../services/skills/SkillsManager"

import { getWorkspacePath } from "../../utils/path"
import { OrganizationAllowListViolationError } from "../../utils/errors"

import { initializeWebview } from "./initializeWebview"
import { applyCreateTaskConfiguration } from "./applyCreateTaskConfiguration"
import { schedulePendingEditReplay } from "./replayPendingEdit"
import {
	getVisibleProvider,
	getVisibleInstance,
	handleCodeAction,
	handleTerminalAction,
	isActiveTask,
	registerProvider,
	unregisterProvider,
} from "./clineProviderRegistry"

import { t } from "../../i18n"

import type { ContextProxy } from "../config/ContextProxy"
import type { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { Task, type TaskOptions } from "../task/Task"

/**
 * Task 構築の差し込み口。既定は `(opts) => new Task(opts)`。テストで
 * `vi.mock("../../task/Task", ...)` を張らずに `new ClineProvider(..., { taskFactory })` で
 * 制御可能にするための seam。
 */
export type TaskFactory = (options: TaskOptions) => Task

/** ClineProvider の差し込み口（テスト用 DI seam）。 */
export interface ClineProviderOptions {
	/** Task 構築の差し込み口。既定は `(opts) => new Task(opts)`。 */
	taskFactory?: TaskFactory
	/** collaborator 一式の差し込み口。既定は `buildProviderCollaborators(this)`。 */
	collaborators?: ProviderCollaborators
}

import { webviewMessageHandler } from "./webviewMessageHandler"
import type { TodoItem } from "@openai-agent/types"
import type { TaskHistoryStore } from "../task-persistence"
import type { WebviewContentGenerator } from "./WebviewContentGenerator"
import type { TaskHistoryReader, TaskWithId } from "./TaskHistoryReader"
import { exportTaskToMarkdown } from "./exportTask"
import { ensureSettingsDirectory } from "./providerDirectories"
import { buildExtensionState } from "./buildExtensionState"
import { buildState } from "./buildState"
import type { TaskDelegationController } from "./TaskDelegationController"
import type { ProviderProfileController } from "./ProviderProfileController"
import type { ModeController } from "./ModeController"
import type { TaskStackController } from "./TaskStackController"
import type { TaskDeletionController } from "./TaskDeletionController"
import type { TaskCancellationController } from "./TaskCancellationController"
import type { HistoryProfileRestorer } from "./HistoryProfileRestorer"
import type { CodeIndexStatusSubscriber } from "./CodeIndexStatusSubscriber"
import type { PendingEditOperationManager } from "./PendingEditOperationManager"
import type { RecentTasksCache } from "./RecentTasksCache"
import type { GlobalStateHistoryWriteThrough } from "./GlobalStateHistoryWriteThrough"
import {
	buildProviderCollaborators,
	type ProviderCollaborators,
	type ProviderStateSnapshot,
} from "./buildProviderCollaborators"
import { mergeAllowedCommands, mergeDeniedCommands } from "./mergeCommandLists"

/**
 * https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
 * https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
 */

export class ClineProvider
	extends EventEmitter<TaskProviderEvents>
	implements vscode.WebviewViewProvider, TaskProviderLike
{
	// Used in package.json as the view's id. This value cannot be changed due
	// to how VSCode caches views based on their id, and updating the id would
	// break existing instances of the extension.
	public static readonly sideBarId = `${Package.name}.SidebarProvider`
	public static readonly tabPanelId = `${Package.name}.TabPanelProvider`
	// Public for host-pattern extraction (initializeWebview 等が disposable の push / view 参照に使う)
	public disposables: vscode.Disposable[] = []
	public webviewDisposables: vscode.Disposable[] = []
	public view?: vscode.WebviewView | vscode.WebviewPanel
	private readonly taskStack: TaskStackController
	public readonly codeIndexStatus: CodeIndexStatusSubscriber
	private _workspaceTracker?: WorkspaceTracker // workSpaceTracker read-only for access outside this class
	protected mcpHub?: McpHub // Change from private to protected
	protected skillsManager?: SkillsManager
	private taskCreationCallback: (task: Task) => void
	private currentWorkspacePath: string | undefined
	private _disposed = false

	private readonly recentTasks: RecentTasksCache
	public readonly taskHistoryStore: TaskHistoryStore
	private readonly taskHistoryReader: TaskHistoryReader
	private readonly taskDelegation: TaskDelegationController
	private readonly taskDeletion: TaskDeletionController
	private readonly taskCancellation: TaskCancellationController<Task>
	private readonly historyProfileRestorer: HistoryProfileRestorer
	private readonly providerProfile: ProviderProfileController
	private readonly modeController: ModeController
	private readonly historyWriteThrough: GlobalStateHistoryWriteThrough
	public readonly pendingEditOperations: PendingEditOperationManager

	/**
	 * Monotonically increasing sequence number for clineMessages state pushes.
	 * Used by the frontend to reject stale state that arrives out-of-order.
	 */
	private clineMessagesSeq = 0

	public isViewLaunched = false
	public settingsImportedAt?: number
	public readonly providerSettingsManager: ProviderSettingsManager
	public readonly webviewContent: WebviewContentGenerator

	private readonly taskFactory: TaskFactory

	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly renderContext: "sidebar" | "editor" = "sidebar",
		public readonly contextProxy: ContextProxy,
		options: ClineProviderOptions = {},
	) {
		super()
		this.taskFactory = options.taskFactory ?? ((taskOptions) => new Task(taskOptions))
		this.currentWorkspacePath = getWorkspacePath()

		registerProvider(this)

		this.updateGlobalState("codebaseIndexModels", EMBEDDING_MODEL_PROFILES)

		// 配線は buildProviderCollaborators が持つ。ここは所有権の受け取りだけ。
		const collaborators =
			options.collaborators ??
			buildProviderCollaborators(this, {
				// private alias なので host interface では渡せない（spec が spy を張る seam でもある）
				getGlobalState: (key) => this.getGlobalState(key),
				updateGlobalState: (key, value) => this.updateGlobalState(key, value),
			})

		this.taskHistoryStore = collaborators.taskHistoryStore
		this.historyWriteThrough = collaborators.historyWriteThrough
		this.recentTasks = collaborators.recentTasks
		this.taskHistoryReader = collaborators.taskHistoryReader
		this.taskStack = collaborators.taskStack
		this.taskDelegation = collaborators.taskDelegation
		this.taskDeletion = collaborators.taskDeletion
		this.taskCancellation = collaborators.taskCancellation
		this.codeIndexStatus = collaborators.codeIndexStatus
		this._workspaceTracker = collaborators.workspaceTracker
		this.webviewContent = collaborators.webviewContent
		this.pendingEditOperations = collaborators.pendingEditOperations
		this.providerSettingsManager = collaborators.providerSettingsManager
		this.providerProfile = collaborators.providerProfile
		this.modeController = collaborators.modeController
		this.historyProfileRestorer = collaborators.historyProfileRestorer
		this.skillsManager = collaborators.skillsManager
		this.taskCreationCallback = collaborators.taskCreationCallback

		// 起動処理は代入が終わってから（factory 内で走らせると代入前の field を掴む）。
		collaborators
			.startBackgroundInitialization?.()
			.then((hub) => {
				this.mcpHub = hub
				this.mcpHub.registerClient()
			})
			.catch((error) => {
				this.log(`Failed to initialize MCP Hub: ${error}`)
			})
	}

	/**
	 * Override EventEmitter's on method to match TaskProviderLike interface
	 */
	override on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.on(event, listener as any)
	}

	/**
	 * Override EventEmitter's off method to match TaskProviderLike interface
	 */
	override off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.off(event, listener as any)
	}

	// Adds a new Task instance to clineStack, marking the start of a new task.
	// The instance is pushed to the top of the stack (LIFO order).
	// When the task is completed, the top instance is removed, reactivating the
	// previous task.
	async addClineToStack(task: Task) {
		return this.taskStack.add(task)
	}

	// Removes and destroys the top Cline instance (the current finished task),
	// activating the previous one (resuming the parent task).
	async removeClineFromStack(options?: { skipDelegationRepair?: boolean }) {
		return this.taskStack.removeTop(options)
	}

	getTaskStackSize(): number {
		return this.taskStack.size
	}

	public getCurrentTaskStack(): string[] {
		return this.taskStack.taskIds()
	}

	// Pending Edit Operations Management

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	public clearWebviewResources() {
		while (this.webviewDisposables.length) {
			const x = this.webviewDisposables.pop()
			if (x) {
				x.dispose()
			}
		}
	}

	async dispose() {
		if (this._disposed) {
			return
		}

		this._disposed = true
		this.log("Disposing ClineProvider...")

		// Clear all tasks from the stack.
		await this.taskStack.clearAll()

		this.log("Cleared all tasks")

		// Clear all pending edit operations to prevent memory leaks
		this.pendingEditOperations.clearAll()
		this.log("Cleared pending operations")

		if (this.view && "dispose" in this.view) {
			this.view.dispose()
			this.log("Disposed webview")
		}

		this.clearWebviewResources()

		while (this.disposables.length) {
			const x = this.disposables.pop()

			if (x) {
				x.dispose()
			}
		}

		this._workspaceTracker?.dispose()
		this._workspaceTracker = undefined
		await this.mcpHub?.unregisterClient()
		this.mcpHub = undefined
		await this.skillsManager?.dispose()
		this.skillsManager = undefined
		this.taskHistoryStore.dispose()
		this.historyWriteThrough.flush()
		this.log("Disposed all disposables")
		unregisterProvider(this)

		// Clean up any event listeners attached to this provider
		this.removeAllListeners()

		McpServerManager.unregisterProvider(this)
	}

	// Static dispatch helpers moved to `./clineProviderRegistry`. Aliased as
	// static members here so existing `ClineProvider.getVisibleInstance()` /
	// `ClineProvider.handleCodeAction()` etc. callers keep working unchanged.
	public static readonly getVisibleInstance = getVisibleProvider
	public static readonly getInstance = getVisibleInstance
	public static readonly isActiveTask = isActiveTask
	public static readonly handleCodeAction = handleCodeAction
	public static readonly handleTerminalAction = handleTerminalAction

	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		await initializeWebview(this, webviewView)
	}

	public async createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	) {
		// CLI injects runtime provider settings from command flags/env at startup.
		// Restoring provider profiles from task history can overwrite those
		// runtime settings with stale/incomplete persisted profiles.
		const skipProfileRestoreFromHistory = process.env.ROO_CLI_RUNTIME === "1"

		// Check if we're rehydrating the current task to avoid flicker
		const currentTask = this.getCurrentTask()
		const isRehydratingCurrentTask = currentTask && currentTask.taskId === historyItem.id

		if (!isRehydratingCurrentTask) {
			await this.removeClineFromStack()
		}

		// Restore the saved mode and provider profile (API config) from the history item.
		await this.historyProfileRestorer.restore(historyItem, skipProfileRestoreFromHistory)

		const { apiConfiguration, enableCheckpoints, checkpointTimeout, experiments } = await this.getState()

		const task = this.taskFactory({
			provider: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			historyItem,
			experiments,
			rootTask: historyItem.rootTask,
			parentTask: historyItem.parentTask,
			taskNumber: historyItem.number,
			workspacePath: historyItem.workspace,
			onCreated: this.taskCreationCallback,
			startTask: options?.startTask ?? true,
			// Preserve the status from the history item to avoid overwriting it when the task saves messages
			initialStatus: historyItem.status,
		})

		if (isRehydratingCurrentTask) {
			// Replace the current task in-place to avoid UI flicker
			await this.taskStack.replaceTop(task)

			this.log(
				`[createTaskWithHistoryItem] rehydrated task ${task.taskId}.${task.instanceId} in-place (flicker-free)`,
			)
		} else {
			await this.addClineToStack(task)

			this.log(
				`[createTaskWithHistoryItem] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
			)
		}

		// Replay any message edit that was held across the checkpoint restoration.
		schedulePendingEditReplay(task, this.pendingEditOperations, (message) => this.log(message))

		return task
	}

	public async postMessageToWebview(message: ExtensionMessage) {
		if (this._disposed) {
			return
		}

		try {
			await this.view?.webview.postMessage(message)
		} catch {
			// View disposed, drop message silently
		}
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	public setWebviewMessageListener(webview: vscode.Webview) {
		// ハンドラの reject は誰も待っていない。catch しないと unhandled rejection として
		// 消え、webview が反応しない理由がログのどこにも残らない。
		const onReceiveMessage = async (message: WebviewMessage) =>
			webviewMessageHandler(this, message).catch((error) =>
				this.log(
					`Error handling webview message "${message.type}": ${
						error instanceof Error ? (error.stack ?? error.message) : String(error)
					}`,
				),
			)

		const messageDisposable = webview.onDidReceiveMessage(onReceiveMessage)
		this.webviewDisposables.push(messageDisposable)
	}

	/**
	 * Handle switching to a new mode, including updating the associated API configuration
	 * @param newMode The mode to switch to
	 */
	public async handleModeSwitch(newMode: Mode) {
		return this.modeController.handleModeSwitch(newMode)
	}

	// Provider Profile Management

	getProviderProfileEntries(): ProviderSettingsEntry[] {
		return this.providerProfile.getProviderProfileEntries()
	}

	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.providerProfile.getProviderProfileEntry(name)
	}

	public hasProviderProfileEntry(name: string): boolean {
		return this.providerProfile.hasProviderProfileEntry(name)
	}

	async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		return this.providerProfile.upsertProviderProfile(name, providerSettings, activate)
	}

	async deleteProviderProfile(profileToDelete: ProviderSettingsEntry) {
		return this.providerProfile.deleteProviderProfile(profileToDelete)
	}

	async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	) {
		return this.providerProfile.activateProviderProfile(args, options)
	}

	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field.
		await this.updateGlobalState("customInstructions", instructions || undefined)
		await this.postStateToWebview()
	}

	// MCP

	async ensureSettingsDirectoryExists(): Promise<string> {
		return ensureSettingsDirectory(this.contextProxy)
	}

	// Task history

	async getTaskWithId(id: string): Promise<TaskWithId> {
		return this.taskHistoryReader.getTaskWithId(id)
	}

	async getTaskWithAggregatedCosts(taskId: string): Promise<{
		historyItem: HistoryItem
		aggregatedCosts: AggregatedCosts
	}> {
		return this.taskHistoryReader.getTaskWithAggregatedCosts(taskId)
	}

	async showTaskWithId(id: string) {
		if (id !== this.getCurrentTask()?.taskId) {
			// Non-current task.
			const { historyItem } = await this.getTaskWithId(id)
			await this.createTaskWithHistoryItem(historyItem) // Clears existing task.
		}

		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		await exportTaskToMarkdown(historyItem.ts, apiConversationHistory, this.contextProxy)
	}

	/* Condenses a task's message history to use fewer tokens. */
	async condenseTaskContext(taskId: string) {
		const task = this.taskStack.findByTaskId(taskId) as Task | undefined
		if (!task) {
			throw new Error(`Task with id ${taskId} not found in stack`)
		}
		await task.condenseContext()
		await this.postMessageToWebview({ type: "condenseTaskContextResponse", text: taskId })
	}

	// this function deletes a task from task history, and deletes its checkpoints and delete the task folder
	// If the task has subtasks (childIds), they will also be deleted recursively
	async deleteTaskWithId(id: string, cascadeSubtasks: boolean = true) {
		return this.taskDeletion.deleteWithId(id, cascadeSubtasks)
	}

	async deleteTaskFromState(id: string) {
		await this.taskHistoryStore.delete(id)
		this.recentTasks.invalidate()

		await this.postStateToWebview()
	}

	async refreshWorkspace() {
		this.currentWorkspacePath = getWorkspacePath()
		await this.postStateToWebview()
	}

	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		this.clineMessagesSeq++
		state.clineMessagesSeq = this.clineMessagesSeq
		this.postMessageToWebview({ type: "state", state })
	}

	/**
	 * Apply an autonomy mode preset (Claude Code-style permission modes).
	 *
	 * Overwrites exactly the auto-approval flags in the preset and records the selected
	 * mode. Command policy (allowedCommands / deniedCommands) and the *OutsideWorkspace /
	 * *Protected escalations are intentionally left untouched so a mode switch never
	 * silently widens them. This is user-driven only — never call it from tool handling.
	 */
	async setAutonomyMode(mode: AutonomyMode) {
		const preset = AUTONOMY_PRESETS[mode]

		await Promise.all([
			this.contextProxy.setValue("autonomyMode", mode),
			this.contextProxy.setValue("autoApprovalEnabled", preset.autoApprovalEnabled),
			this.contextProxy.setValue("alwaysAllowReadOnly", preset.alwaysAllowReadOnly),
			this.contextProxy.setValue("alwaysAllowWrite", preset.alwaysAllowWrite),
			this.contextProxy.setValue("alwaysAllowExecute", preset.alwaysAllowExecute),
			this.contextProxy.setValue("alwaysAllowMcp", preset.alwaysAllowMcp),
			this.contextProxy.setValue("alwaysAllowSubtasks", preset.alwaysAllowSubtasks),
		])

		await this.postStateToWebview()
	}

	/**
	 * Like postStateToWebview but intentionally omits taskHistory.
	 *
	 * Rationale:
	 * - taskHistory can be large and was being resent on every chat message update.
	 * - The webview maintains taskHistory in-memory and receives updates via
	 *   `taskHistoryUpdated` / `taskHistoryItemUpdated`.
	 */
	async postStateToWebviewWithoutTaskHistory(): Promise<void> {
		const state = await this.getStateToPostToWebview()
		this.clineMessagesSeq++
		state.clineMessagesSeq = this.clineMessagesSeq
		const { taskHistory: _omit, ...rest } = state
		this.postMessageToWebview({ type: "state", state: rest })
	}

	/**
	 * Like postStateToWebview but intentionally omits both clineMessages and taskHistory.
	 *
	 * Rationale:
	 * - Settings and mode changes trigger state pushes
	 *   that have nothing to do with chat messages. Including clineMessages in these pushes
	 *   creates race conditions where a stale snapshot of clineMessages (captured during async
	 *   getStateToPostToWebview) overwrites newer messages the task has streamed in the meantime.
	 * - This method ensures non-message events only push the state fields they actually affect
	 *   without interfering with task message streaming.
	 */
	async postStateToWebviewWithoutClineMessages(): Promise<void> {
		const state = await this.getStateToPostToWebview()
		const { clineMessages: _omitMessages, taskHistory: _omitHistory, ...rest } = state
		this.postMessageToWebview({ type: "state", state: rest })
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		// Ensure the store is initialized before reading task history
		await this.taskHistoryStore.initialized

		const state = await this.getState()
		const { allowedCommands, deniedCommands } = state
		const currentTask = this.getCurrentTask()

		return buildExtensionState(state, {
			version: this.context.extension?.packageJSON?.version ?? "",
			cwd: this.cwd,
			currentTaskId: currentTask?.taskId,
			currentTaskItem: currentTask?.taskId ? this.taskHistoryStore.get(currentTask.taskId) : undefined,
			clineMessages: currentTask?.messageStore.clineMessages || [],
			currentTaskTodos: currentTask?.todoList || [],
			messageQueue: currentTask?.messageQueueService?.messages,
			taskHistory: this.taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task),
			mergedAllowedCommands: mergeAllowedCommands(allowedCommands),
			mergedDeniedCommands: mergeDeniedCommands(deniedCommands),
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			renderContext: this.renderContext,
			settingsImportedAt: this.settingsImportedAt,
			hasOpenedModeSelector: this.getGlobalState("hasOpenedModeSelector") ?? false,
		})
	}

	/**
	 * Storage
	 * https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	 * https://www.eliostruyf.com/devhack-code-extension-storage-options/
	 */

	async getState(): Promise<ProviderStateSnapshot> {
		const stateValues = this.contextProxy.getValues()

		// This build only ships the OpenAI Compatible provider.
		const apiProvider: ProviderName = stateValues.apiProvider ?? "openai"

		// Build the apiConfiguration object combining state values and secrets.
		const providerSettings = this.contextProxy.getProviderSettings()

		// Ensure apiProvider is set properly if not already in state
		if (!providerSettings.apiProvider) {
			providerSettings.apiProvider = apiProvider
		}

		return buildState(stateValues, {
			apiConfiguration: providerSettings,
			taskHistory: this.taskHistoryStore.getAll(),
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			organizationAllowList: ORGANIZATION_ALLOW_ALL,
			lockApiConfigAcrossModes: this.context.workspaceState.get("lockApiConfigAcrossModes", false),
		})
	}

	/**
	 * Updates a task in the task history and optionally broadcasts the updated history to the webview.
	 * Now delegates to TaskHistoryStore for per-task file persistence.
	 *
	 * @param item The history item to update or add
	 * @param options.broadcast Whether to broadcast the updated history to the webview (default: true)
	 * @returns The updated task history array
	 */
	async updateTaskHistory(item: HistoryItem, options: { broadcast?: boolean } = {}): Promise<HistoryItem[]> {
		const { broadcast = true } = options

		const history = await this.taskHistoryStore.upsert(item)
		this.recentTasks.invalidate()

		// Broadcast the updated history to the webview if requested.
		// Prefer per-item updates to avoid repeatedly cloning/sending the full history.
		if (broadcast && this.isViewLaunched) {
			const updatedItem = this.taskHistoryStore.get(item.id) ?? item
			await this.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedItem })
		}

		return history
	}

	/**
	 * Broadcasts a task history update to the webview.
	 * This sends a lightweight message with just the task history, rather than the full state.
	 * @param history The task history to broadcast (if not provided, reads from the store)
	 */
	public async broadcastTaskHistoryUpdate(history?: HistoryItem[]): Promise<void> {
		if (!this.isViewLaunched) {
			return
		}

		const taskHistory = history ?? this.taskHistoryStore.getAll()

		// Sort and filter the history the same way as getStateToPostToWebview
		const sortedHistory = taskHistory
			.filter((item: HistoryItem) => item.ts && item.task)
			.sort((a: HistoryItem, b: HistoryItem) => b.ts - a.ts)

		await this.postMessageToWebview({
			type: "taskHistoryUpdated",
			taskHistory: sortedHistory,
		})
	}

	// ContextProxy

	// @deprecated - Use `ContextProxy#setValue` instead.
	private async updateGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]) {
		await this.contextProxy.setValue(key, value)
	}

	// @deprecated - Use `ContextProxy#getValue` instead.
	private getGlobalState<K extends keyof GlobalState>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public async setValue<K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) {
		await this.contextProxy.setValue(key, value)
	}

	public getValue<K extends keyof AgentSettings>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public getValues() {
		return this.contextProxy.getValues()
	}

	public async setValues(values: AgentSettings) {
		await this.contextProxy.setValues(values)
	}

	// dev

	async resetState() {
		const answer = await vscode.window.showInformationMessage(
			t("common:confirmation.reset_state"),
			{ modal: true },
			t("common:answers.yes"),
		)

		if (answer !== t("common:answers.yes")) {
			return
		}

		await this.contextProxy.resetAllState()
		await this.providerSettingsManager.resetAllConfigs()
		await this.removeClineFromStack()
		await this.postStateToWebview()
		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	// logging

	public log(message: string) {
		this.outputChannel.appendLine(message)
		console.log(message)
	}

	// getters

	public get workspaceTracker(): WorkspaceTracker | undefined {
		return this._workspaceTracker
	}

	get viewLaunched() {
		return this.isViewLaunched
	}

	/** True when this provider's webview is currently visible to the user. */
	public isVisible(): boolean {
		return this.view?.visible === true
	}

	get messages() {
		return this.getCurrentTask()?.messageStore.clineMessages || []
	}

	public getMcpHub(): McpHub | undefined {
		return this.mcpHub
	}

	public getSkillsManager(): SkillsManager | undefined {
		return this.skillsManager
	}

	/**
	 * Gets the CodeIndexManager for the current active workspace
	 * @returns CodeIndexManager instance for the current workspace or the default one
	 */
	public getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined {
		return CodeIndexManager.getInstance(this.context)
	}

	/**
	 * Updates the code index status subscription to listen to the current workspace manager
	 */
	public updateCodeIndexStatusSubscription(): void {
		this.codeIndexStatus.update()
	}

	/**
	 * TaskProviderLike
	 */

	public getCurrentTask(): Task | undefined {
		return this.taskStack.getCurrent() as Task | undefined
	}

	public getRecentTasks(): string[] {
		return this.recentTasks.get()
	}

	// When initializing a new task, (not from history but from a tool command
	// new_task) there is no need to remove the previous task since the new
	// task is a subtask of the previous one, and when it finishes it is removed
	// from the stack and the caller is resumed in this way we can have a chain
	// of tasks, each one being a sub task of the previous one until the main
	// task is finished.
	public async createTask(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options: CreateTaskOptions = {},
		configuration: AgentSettings = {},
	): Promise<Task> {
		await applyCreateTaskConfiguration(this, configuration)

		const { apiConfiguration, organizationAllowList, enableCheckpoints, checkpointTimeout, experiments } =
			await this.getState()

		// Single-open-task invariant: always enforce for user-initiated top-level tasks
		if (!parentTask) {
			try {
				await this.removeClineFromStack()
			} catch {
				// Non-fatal
			}
		}

		if (!ProfileValidator.isProfileAllowed(apiConfiguration, organizationAllowList)) {
			throw new OrganizationAllowListViolationError(t("common:errors.violated_organization_allowlist"))
		}

		const task = this.taskFactory({
			provider: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			task: text,
			images,
			experiments,
			rootTask: this.taskStack.getRoot() as Task | undefined,
			parentTask,
			taskNumber: this.taskStack.size + 1,
			onCreated: this.taskCreationCallback,
			initialTodos: options.initialTodos,
			// Ensure this task is present in clineStack before startTask() emits
			// its initial state update, so state.currentTaskId is available ASAP.
			startTask: false,
			...options,
		})

		await this.addClineToStack(task)
		task.start()

		this.log(
			`[createTask] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
		)

		return task
	}

	public async cancelTask(): Promise<void> {
		return this.taskCancellation.cancel()
	}

	// Clear the current task without treating it as a subtask.
	// This is used when the user cancels a task that is not a subtask.
	public async clearTask(): Promise<void> {
		const task = this.taskStack.getCurrent()
		if (task) {
			console.log(`[clearTask] clearing task ${task.taskId}.${task.instanceId}`)
			await this.removeClineFromStack()
		}
	}

	public resumeTask(taskId: string): void {
		// Use the existing showTaskWithId method which handles both current and
		// historical tasks.
		this.showTaskWithId(taskId).catch((error) => {
			this.log(`Failed to resume task ${taskId}: ${error.message}`)
		})
	}

	// Modes

	public async getModes(): Promise<{ slug: string; name: string }[]> {
		return DEFAULT_MODES.map(({ slug, name }) => ({ slug, name }))
	}

	public async getMode(): Promise<string> {
		const { mode } = await this.getState()
		return mode
	}

	public async setMode(mode: string): Promise<void> {
		await this.setValues({ mode })
	}

	// Provider Profiles

	public async getProviderProfiles(): Promise<{ name: string; provider?: string }[]> {
		return this.providerProfile.getProviderProfiles()
	}

	public async getProviderProfile(): Promise<string> {
		return this.providerProfile.getProviderProfile()
	}

	public async setProviderProfile(name: string): Promise<void> {
		return this.providerProfile.setProviderProfile(name)
	}

	public get cwd() {
		return this.currentWorkspacePath || getWorkspacePath()
	}

	/**
	 * Delegate parent task and open child task.
	 *
	 * - Enforce single-open invariant
	 * - Persist parent delegation metadata
	 * - Emit TaskDelegated (task-level; API forwards to provider/bridge)
	 * - Create child as sole active and switch mode to child's mode
	 */
	public async delegateParentAndOpenChild(params: {
		parentTaskId: string
		message: string
		initialTodos: TodoItem[]
		mode: string
	}): Promise<Task> {
		return this.taskDelegation.delegateParentAndOpenChild(params) as unknown as Promise<Task>
	}

	/**
	 * Reopen parent task from delegation with write-back and events.
	 */
	public async reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void> {
		return this.taskDelegation.reopenParentFromDelegation(params)
	}

	/**
	 * Convert a file path to a webview-accessible URI
	 * This method safely converts file paths to URIs that can be loaded in the webview
	 *
	 * @param filePath - The absolute file path to convert
	 * @returns The webview URI string, or the original file URI if conversion fails
	 * @throws {Error} When webview is not available
	 * @throws {TypeError} When file path is invalid
	 */
	public convertToWebviewUri(filePath: string): string {
		try {
			const fileUri = vscode.Uri.file(filePath)

			// Check if we have a webview available
			if (this.view?.webview) {
				const webviewUri = this.view.webview.asWebviewUri(fileUri)
				return webviewUri.toString()
			}

			// Specific error for no webview available
			const error = new Error("No webview available for URI conversion")
			console.error(error.message)
			// Fallback to file URI if no webview available
			return fileUri.toString()
		} catch (error) {
			// More specific error handling
			if (error instanceof TypeError) {
				console.error("Invalid file path provided for URI conversion:", error)
			} else {
				console.error("Failed to convert to webview URI:", error)
			}
			// Return file URI as fallback
			return vscode.Uri.file(filePath).toString()
		}
	}
}
