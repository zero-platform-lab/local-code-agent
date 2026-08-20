import type { ContentBlockParam, MessageParam, ToolResultBlockParam } from "@openai-agent/types"
import * as path from "path"
import * as vscode from "vscode"
import os from "os"
import crypto from "crypto"
import { v7 as uuidv7 } from "uuid"
import EventEmitter from "events"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderSettings,
	type TokenUsage,
	type ToolName,
	type ContextCondense,
	type ContextTruncation,
	type ClineMessage,
	type ClineSay,
	type ClineAsk,
	type ToolProgressStatus,
	type HistoryItem,
	type CreateTaskOptions,
	type ClineApiReqCancelReason,
	AgentEventName,
	TaskStatus,
	TodoItem,
	QueuedMessage,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
} from "@openai-agent/types"

// api
import { ApiHandler, buildApiHandler } from "../../api"
import { ApiStream } from "../../api/transform/stream"

// shared
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { DiffStrategy } from "../../shared/tools"

// services
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { AgentTerminalProcess } from "../../integrations/terminal/types"

// utils
import { getWorkspacePath } from "../../utils/path"

// prompts
import { formatResponse } from "../prompts/responses"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { restoreTodoListForTask } from "../tools/UpdateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { AgentIgnoreController } from "../ignore/AgentIgnoreController"
import { AgentProtectedController } from "../protect/AgentProtectedController"
import { presentAssistantMessage } from "../assistant-message/presentAssistantMessage"
import type { TaskProviderRef } from "./taskProviderRef"
import { type ApiMessage } from "../task-persistence"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { MessageQueueService } from "../message-queue/MessageQueueService"
import { AutoApprovalHandler } from "../auto-approval"
import { MessageManager } from "../message-manager"
import { resumeTaskFromHistory as runResumeTaskFromHistory } from "./resumeTaskFromHistory"
import { addToApiConversationHistory as runAddToApiConversationHistory } from "./addToApiConversationHistory"
import { say as runSay } from "./say"
import { submitUserMessage as runSubmitUserMessage } from "./submitUserMessage"
import { handleWebviewAskResponse as runHandleWebviewAskResponse } from "./handleWebviewAskResponse"
import { startTask as runStartTask } from "./startTask"
import { flushPendingToolResultsToHistory as runFlushPendingToolResultsToHistory } from "./flushPendingToolResultsToHistory"
import { disposeTask as runDisposeTask } from "./disposeTask"
import { resumeAfterDelegation as runResumeAfterDelegation } from "./resumeAfterDelegation"
import { buildSystemPrompt } from "./buildSystemPrompt"
import { runInitiateTaskLoop } from "./runInitiateTaskLoop"
import { getEnabledMcpToolsCount as runGetEnabledMcpToolsCount } from "./getEnabledMcpToolsCount"
import { retrySaveApiConversationHistory as runRetrySaveApiConversationHistory } from "./retrySaveApiConversationHistory"
import { startSubtask as runStartSubtask } from "./startSubtask"
import { pushToolResultToUserContent as runPushToolResultToUserContent } from "./pushToolResultToUserContent"
import { processQueuedMessages as runProcessQueuedMessages } from "./processQueuedMessages"
import { saveClineMessages as runSaveClineMessages } from "./saveClineMessages"
import { runRecursiveClineLoop } from "./runRecursiveClineLoop"
import { buildApiRequestDeps as runBuildApiRequestDeps } from "./buildApiRequestDeps"
import { runAskFlow } from "./runAskFlow"
import { runAbortTask } from "./runAbortTask"
import {
	attemptApiRequest as runAttemptApiRequest,
	condenseContext as runCondenseContext,
	handleContextWindowExceededError as runHandleContextWindowExceededError,
	type ApiRequestOrchestratorDeps,
} from "./apiRequestOrchestrator"
import { TaskMessageStore } from "./TaskMessageStore"
import { TokenUsageTracker } from "./TokenUsageTracker"
import { ApiRequestTimingController } from "./ApiRequestTimingController"
import { AskState } from "./AskState"
import { GraceRetryCounter } from "./GraceRetryCounter"
import { MistakeTracker } from "./MistakeTracker"
import { StreamingSession } from "./StreamingSession"
import { resolveTaskIdentity } from "./resolveTaskIdentity"
import { buildTaskCollaborators, type TaskCollaborators } from "./TaskBuilder"
import { TaskLauncher } from "./TaskLauncher"
import { TaskModeState } from "./TaskModeState"
import { TaskSubscriptions } from "./TaskSubscriptions"
import { subscribeMessageQueueStateChanged } from "./subscribeMessageQueueStateChanged"
import { subscribeProviderProfileChange } from "./subscribeProviderProfileChange"
import { validateTaskOptions } from "./validateTaskOptions"

export interface TaskOptions extends CreateTaskOptions {
	provider: TaskProviderRef
	apiConfiguration: ProviderSettings
	enableCheckpoints?: boolean
	checkpointTimeout?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (task: Task) => void
	initialTodos?: TodoItem[]
	workspacePath?: string
	/** Initial status for the task's history item (e.g., "active" for child tasks) */
	initialStatus?: "active" | "delegated" | "completed"
	/**
	 * 事前に組み立てた collaborator 一式。省略時は `buildTaskCollaborators` が
	 * production の実インスタンスを組む。テストが fake を差し込むための注入口で、
	 * `vi.mock("../../ignore/AgentIgnoreController")` のようなモジュール単位の
	 * モックを使わずに済ませるためにある。
	 */
	collaborators?: TaskCollaborators
}

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	childTaskId?: string

	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	readonly rootTask: Task | undefined = undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string

	/**
	 * mode / provider profile とその非同期初期化の所有者。参照側は `task.modeState.mode`
	 * のように直接触る（askState / stream / mistakeTracker と同じ流儀）。
	 */
	readonly modeState: TaskModeState

	providerRef: WeakRef<TaskProviderRef>
	readonly globalStoragePath: string
	abort: boolean = false

	// TaskStatus + ask 系状態は AskState 集約（idleAsk/resumableAsk/interactiveAsk +
	// askResponse/askResponseText/askResponseImages + lastMessageTs + autoApprovalTimeoutRef）。
	// 内部モジュールは全て `host.askState.foo` 経由でアクセス、Task 側の proxy は撤去済み。
	readonly askState = new AskState()

	didFinishAbortingStream = false
	abandoned = false
	abortReason?: ClineApiReqCancelReason
	isInitialized = false
	isPaused: boolean = false

	// API
	apiConfiguration: ProviderSettings
	api: ApiHandler
	private static lastGlobalApiRequestTime?: number
	autoApprovalHandler: AutoApprovalHandler

	/** test-only。static state をリセットして test 間の汚染を防ぐ。 */
	static resetGlobalApiRequestTime(): void {
		Task.lastGlobalApiRequestTime = undefined
	}

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: AgentIgnoreController
	rooProtectedController?: AgentProtectedController
	fileContextTracker: FileContextTracker
	terminalProcess?: AgentTerminalProcess

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	didEditFile: boolean = false

	// LLM Messages & Chat Messages — 2 配列の保持と disk I/O は TaskMessageStore が所有する。
	// 参照側は `task.messageStore.clineMessages` のように直接触る（proxy 撤去済み）。
	readonly messageStore: TaskMessageStore

	// Tool Use: MistakeTracker collaborator に集約（旧 4 field + proxy を撤去済み、
	// 内部 module も外部 tools/tests も `mistakeTracker.count` / `.limit` /
	// `.applyDiffMisses` / `.editFileMisses` 経由でアクセス）。
	readonly mistakeTracker: MistakeTracker
	readonly graceRetry = new GraceRetryCounter()

	// Checkpoints
	enableCheckpoints: boolean
	checkpointTimeout: number
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Message Queue Service
	public readonly messageQueueService: MessageQueueService

	/**
	 * 外部 emitter への購読（message queue / provider profile）の所有者。登録は
	 * constructor、解除は `dispose()` → `disposeTask` から `disposeAll()` 一発。
	 */
	readonly subscriptions = new TaskSubscriptions()

	// Streaming（1 request 分の状態は StreamingSession collaborator に集約）:
	// buffers / lifecycle / turn flags / HTTP abort の 17 field。内部 module も
	// 外部 tools/tests も全て `task.stream.foo` 経由でアクセス、proxy 撤去済み。
	readonly stream = new StreamingSession()

	/** 重複 tool_use_id を弾く（API 400 防止）。true=追加成功 / false=重複スキップ。 */
	public pushToolResultToUserContent(toolResult: ToolResultBlockParam): boolean {
		return runPushToolResultToUserContent(this.stream.userMessageContent, toolResult)
	}
	/** 起動元と起動済みフラグの所有者。constructor で確定する。 */
	private readonly launcher: TaskLauncher

	// Token Usage Throttling interval (throttle-like debounce)
	private readonly TOKEN_USAGE_EMIT_INTERVAL_MS = 2000 // 2 seconds
	// Token/tool usage computation, snapshot cache and debounced emit (extracted)
	readonly tokenUsageTracker: TokenUsageTracker
	private readonly apiRequestTiming: ApiRequestTimingController

	// Cloud Sync Tracking
	// Initial status for the task's history item (set at creation time to avoid race conditions)
	readonly initialStatus?: "active" | "delegated" | "completed"

	// MessageManager for high-level message operations (lazy initialized)
	private _messageManager?: MessageManager

	constructor({
		provider,
		apiConfiguration,
		enableCheckpoints = true,
		checkpointTimeout = DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		taskId,
		task,
		images,
		historyItem,
		experiments: _experimentsConfig,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
		initialTodos,
		workspacePath,
		initialStatus,
		collaborators: injectedCollaborators,
	}: TaskOptions) {
		super()

		validateTaskOptions({ startTask, task, images, historyItem, checkpointTimeout })

		const identity = resolveTaskIdentity(
			{ taskId, task, images, historyItem, rootTask, parentTask, workspacePath },
			{
				generateTaskId: () => uuidv7(),
				generateInstanceId: () => crypto.randomUUID().slice(0, 8),
				resolveDefaultWorkspacePath: () => getWorkspacePath(path.join(os.homedir(), "Desktop")),
			},
		)

		this.taskId = identity.taskId
		this.instanceId = identity.instanceId
		this.rootTaskId = identity.rootTaskId
		this.parentTaskId = identity.parentTaskId
		this.childTaskId = undefined
		this.metadata = identity.metadata
		this.workspacePath = identity.workspacePath

		this.providerRef = new WeakRef(provider)
		this.globalStoragePath = provider.context.globalStorageUri.fsPath

		// Task 自身を必要としない collaborator は factory 経由で組み立てる。
		// DiffViewProvider / TokenUsageTracker / ApiRequestTimingController は
		// `this` を host として要求するため下で個別に new する。
		const collaborators =
			injectedCollaborators ??
			buildTaskCollaborators({
				apiConfiguration,
				provider,
				taskId: this.taskId,
				cwd: this.cwd,
				globalStoragePath: this.globalStoragePath,
				consecutiveMistakeLimit,
			})
		this.apiConfiguration = collaborators.apiConfiguration
		this.api = collaborators.api
		this.autoApprovalHandler = collaborators.autoApprovalHandler
		this.rooIgnoreController = collaborators.rooIgnoreController
		this.rooProtectedController = collaborators.rooProtectedController
		this.fileContextTracker = collaborators.fileContextTracker
		this.mistakeTracker = collaborators.mistakeTracker
		this.messageStore = collaborators.messageStore
		this.messageQueueService = collaborators.messageQueueService
		this.diffStrategy = collaborators.diffStrategy
		this.toolRepetitionDetector = collaborators.toolRepetitionDetector

		this.diffViewProvider = new DiffViewProvider(this.cwd, this)
		this.enableCheckpoints = enableCheckpoints
		this.checkpointTimeout = checkpointTimeout

		this.parentTask = parentTask
		this.taskNumber = taskNumber
		this.initialStatus = initialStatus

		// 外部 emitter への購読は registry が所有する（解除も同じ場所が返す teardown で行う）。
		this.subscriptions.add(subscribeMessageQueueStateChanged(this))
		this.subscriptions.add(subscribeProviderProfileChange(this, this.providerRef))

		// Initialize todo list if provided
		if (initialTodos && initialTodos.length > 0) {
			this.todoList = initialTodos
		}

		// Token/tool usage computation, snapshot cache and throttle-like debounced emit.
		this.tokenUsageTracker = new TokenUsageTracker(this, this.TOKEN_USAGE_EMIT_INTERVAL_MS)

		this.apiRequestTiming = new ApiRequestTimingController(this, {
			getLastGlobalApiRequestTime: () => Task.lastGlobalApiRequestTime,
		})

		this.modeState = historyItem ? TaskModeState.fromHistoryItem(historyItem) : TaskModeState.fromProvider(provider)

		// 起動元（fresh / history）はここで 1 度だけ確定し、以降の起動判断は launcher が持つ。
		this.launcher = new TaskLauncher(TaskLauncher.sourceFrom({ task, images, historyItem }), {
			startTask: (taskText, taskImages) => this.startTask(taskText, taskImages),
			resumeTaskFromHistory: () => this.resumeTaskFromHistory(),
		})

		onCreated?.(this)

		if (startTask) {
			void this.launcher.start()
		}
	}

	// API Messages

	async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return this.messageStore.readApiConversationHistory()
	}

	async addToApiConversationHistory(message: MessageParam, reasoning?: string) {
		await runAddToApiConversationHistory({ host: this }, message, reasoning)
	}

	// NOTE: We intentionally do NOT mutate stored messages to merge consecutive user turns.
	// For API requests, consecutive same-role messages are merged via mergeConsecutiveApiMessages()
	// so rewind/edit behavior can still reference original message boundaries.

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		this.messageStore.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	/**
	 * delegation（new_task 等）で親が dispose する前に `userMessageContent` の
	 * tool_result を永続化する。flush しないと親再開時に「tool_use に対応する
	 * tool_result が欠落」で API 400 になる。
	 */
	public async flushPendingToolResultsToHistory(): Promise<boolean> {
		return runFlushPendingToolResultsToHistory({ host: this })
	}

	async saveApiConversationHistory(): Promise<boolean> {
		return this.messageStore.saveApiConversationHistory()
	}

	/** 指数バックオフで最大 3 回 retry。delegation flow の flush 失敗時に呼ぶ。 */
	public async retrySaveApiConversationHistory(): Promise<boolean> {
		return runRetrySaveApiConversationHistory({ host: this })
	}

	// Cline Messages

	async getSavedClineMessages(): Promise<ClineMessage[]> {
		return this.messageStore.readClineMessages()
	}

	public async addToClineMessages(message: ClineMessage) {
		this.messageStore.clineMessages.push(message)
		// taskHistory は webview 側で保持 → 毎チャット更新で再送しない（`WithoutTaskHistory`）。
		await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
		this.emit(AgentEventName.Message, { action: "created", message })
		await this.saveClineMessages()
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.messageStore.clineMessages = newMessages
		restoreTodoListForTask(this)
		await this.saveClineMessages()
	}

	async updateClineMessage(message: ClineMessage) {
		await this.providerRef.deref()?.postMessageToWebview({ type: "messageUpdated", clineMessage: message })
		this.emit(AgentEventName.Message, { action: "updated", message })
	}

	async saveClineMessages(): Promise<boolean> {
		return runSaveClineMessages({ host: this })
	}

	private findMessageByTimestamp(ts: number): ClineMessage | undefined {
		return this.messageStore.findMessageByTimestamp(ts)
	}

	/** `partial`: true=更新中 / false=完成版で置換 / undefined=通常の完成メッセージ。 */
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		return runAskFlow({ host: this as never }, type, text, partial, progressStatus, isProtected)
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		runHandleWebviewAskResponse({ host: this }, askResponse, text, images)
	}

	/** ユーザー操作で auto-approval timer をキャンセルする（発火前の抑止）。 */
	public cancelAutoApprovalTimeout(): void {
		this.askState.cancelAutoApprovalTimeout()
	}

	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("yesButtonClicked", text, images)
	}

	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("noButtonClicked", text, images)
	}

	public supersedePendingAsk(): void {
		this.askState.lastMessageTs = Date.now()
	}

	public updateApiConfiguration(newApiConfiguration: ProviderSettings): void {
		this.apiConfiguration = newApiConfiguration
		this.api = buildApiHandler(this.apiConfiguration)
	}

	public async submitUserMessage(
		text: string,
		images?: string[],
		mode?: string,
		providerProfile?: string,
	): Promise<void> {
		await runSubmitUserMessage({ host: this }, text, images, mode, providerProfile)
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	private async getFilesReadByAgentSafely(context: string): Promise<string[] | undefined> {
		try {
			return await this.fileContextTracker.getFilesReadByAgent()
		} catch (error) {
			console.error(`[Task#${context}] Failed to get files read by Agent:`, error)
			return undefined
		}
	}

	public async condenseContext(): Promise<void> {
		await runCondenseContext(this.buildApiRequestDeps())
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined> {
		return runSay(
			{ host: this },
			type,
			text,
			images,
			partial,
			checkpoint,
			progressStatus,
			options,
			contextCondense,
			contextTruncation,
		)
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Agent tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	// Lifecycle
	// Start / Resume / Abort / Dispose

	getEnabledMcpToolsCount(): Promise<{ enabledToolCount: number; enabledServerCount: number }> {
		return runGetEnabledMcpToolsCount(this.providerRef)
	}

	/**
	 * `startTask: false` で作った task を手動起動する。constructor で起動済みなら no-op。
	 * delegation で親メタを先に globalState へ書いてから child を書き始めさせる
	 * （read-modify-write race 回避）用途。
	 */
	public start(): Promise<void> {
		return this.launcher.start()
	}

	private async startTask(task?: string, images?: string[]): Promise<void> {
		await runStartTask({ host: this }, task, images)
	}

	public postStateToWebviewWithoutTaskHistory(): Promise<unknown> | undefined {
		return this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
	}

	private async resumeTaskFromHistory() {
		await runResumeTaskFromHistory({ host: this })
	}

	/**
	 * Cancels the current HTTP request if one is in progress.
	 * This immediately aborts the underlying stream rather than waiting for the next chunk.
	 */
	public cancelCurrentRequest(): void {
		if (this.stream.currentRequestAbortController) {
			console.log(`[Task#${this.taskId}.${this.instanceId}] Aborting current HTTP request`)
			this.stream.currentRequestAbortController.abort()
			this.stream.currentRequestAbortController = undefined
		}
	}

	public async abortTask(isAbandoned = false) {
		await runAbortTask(this, isAbandoned)
	}

	/**
	 * apiRequestOrchestrator（attemptApiRequest / condenseContext /
	 * handleContextWindowExceededError）へ委譲するときの deps を組み立てる。
	 * 3メソッドから同一の deps を要求されるため一箇所にまとめている。
	 */
	private buildApiRequestDeps(): ApiRequestOrchestratorDeps {
		return runBuildApiRequestDeps(this as never, {
			getProvider: () => this.providerRef.deref() as never,
			stampLastGlobalApiRequestTime: () => {
				Task.lastGlobalApiRequestTime = performance.now()
			},
		})
	}

	public dispose(): void {
		runDisposeTask({ host: this })
	}

	// Subtasks
	// Spawn / Wait / Complete

	public async startSubtask(message: string, initialTodos: TodoItem[], mode: string) {
		return runStartSubtask(this.providerRef as never, this.taskId, message, initialTodos, mode)
	}

	/**
	 * Delegation 完了後に親 task を resume する。resume ask は表示せず、ask states を
	 * クリアして abort/streaming flag をリセットし、次の API 呼び出しに full context を
	 * 含めて即ループ再開する（metadata 駆動 subtask flow で使用）。
	 */
	public async resumeAfterDelegation(): Promise<void> {
		await runResumeAfterDelegation({ host: this as never })
	}

	// Task Loop

	async initiateTaskLoop(userContent: ContentBlockParam[]): Promise<void> {
		await runInitiateTaskLoop({ host: this }, userContent)
	}

	public initCheckpointService(): unknown {
		return getCheckpointService(this)
	}

	public async recursivelyMakeClineRequests(
		userContent: ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		return runRecursiveClineLoop(
			{
				host: this,
				provider: this.providerRef.deref(),
				stampLastGlobalApiRequestTime: () => {
					Task.lastGlobalApiRequestTime = performance.now()
				},
				presentAssistantMessage: () => presentAssistantMessage(this),
			},
			userContent,
			includeFileDetails,
		)
	}

	private async getSystemPrompt(): Promise<string> {
		return buildSystemPrompt({
			providerRef: this.providerRef,
			api: this.api,
			cwd: this.cwd,
			diffStrategy: this.diffStrategy,
			rooIgnoreController: this.rooIgnoreController,
			vscode,
		})
	}

	private getCurrentProfileId(state: any): string {
		return (
			state?.listApiConfigMeta?.find((profile: any) => profile.name === state?.currentApiConfigName)?.id ??
			"default"
		)
	}

	private async handleContextWindowExceededError(): Promise<void> {
		await runHandleContextWindowExceededError(this.buildApiRequestDeps())
	}

	/** ユーザー設定のレート制限を待つ。エラーではなく `api_req_rate_limit_wait` say で告知。 */
	async maybeWaitForProviderRateLimit(retryAttempt: number): Promise<void> {
		return this.apiRequestTiming.maybeWaitForRateLimit(retryAttempt)
	}

	public async *attemptApiRequest(
		retryAttempt: number = 0,
		options: { skipProviderRateLimit?: boolean } = {},
	): ApiStream {
		yield* runAttemptApiRequest(this.buildApiRequestDeps(), retryAttempt, options)
	}

	// Shared exponential backoff for retries (first-chunk and mid-stream)
	async backoffAndAnnounce(retryAttempt: number, error: any): Promise<void> {
		return this.apiRequestTiming.backoffAndAnnounce(retryAttempt, error)
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false) {
		return checkpointSave(this, force, suppressMessage)
	}

	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	// Metrics

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	// Getters

	public get taskStatus(): TaskStatus {
		if (this.askState.interactiveAsk) return TaskStatus.Interactive
		if (this.askState.resumableAsk) return TaskStatus.Resumable
		if (this.askState.idleAsk) return TaskStatus.Idle
		return TaskStatus.Running
	}

	public get taskAsk(): ClineMessage | undefined {
		return this.askState.currentAsk
	}

	public get queuedMessages(): QueuedMessage[] {
		return this.messageQueueService.messages
	}

	public get tokenUsage(): TokenUsage | undefined {
		return this.tokenUsageTracker.getCachedTokenUsage()
	}

	public get cwd() {
		return this.workspacePath
	}

	/**
	 * Lazy 初期化 + キャッシュ済 MessageManager を返す。`new MessageManager(task)` は
	 * 直接呼ばず必ずこの getter 経由（rewind 等の operation を単一 instance に集約する）。
	 */
	get messageManager(): MessageManager {
		if (!this._messageManager) {
			this._messageManager = new MessageManager(this)
		}
		return this._messageManager
	}

	/** queue に溜まった user message を 1 件 dequeue して submit する。 */
	public processQueuedMessages(): void {
		runProcessQueuedMessages(this)
	}
}
