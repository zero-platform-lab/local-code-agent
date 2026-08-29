import * as vscode from "vscode"

import {
	type AgentEventName,
	type CreateTaskOptions,
	type ExtensionMessage,
	type ExtensionState,
	type GlobalState,
	type HistoryItem,
	type ProviderSettings,
} from "@openai-agent/types"

import type { Mode } from "../../shared/modes"

import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { CodeIndexManager } from "../../services/code-index/manager"
import { SkillsManager } from "../../services/skills/SkillsManager"

import { ContextProxy } from "../config/ContextProxy"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { TaskHistoryStore } from "../task-persistence"
import type { Task } from "../task/Task"

import { CodeIndexStatusSubscriber } from "./CodeIndexStatusSubscriber"
import { GlobalStateHistoryWriteThrough } from "./GlobalStateHistoryWriteThrough"
import { HistoryProfileRestorer } from "./HistoryProfileRestorer"
import { ModeController } from "./ModeController"
import { PendingEditOperationManager } from "./PendingEditOperationManager"
import { ProviderProfileController } from "./ProviderProfileController"
import { RecentTasksCache } from "./RecentTasksCache"
import { TaskCancellationController } from "./TaskCancellationController"
import { TaskDelegationController } from "./TaskDelegationController"
import { TaskDeletionController } from "./TaskDeletionController"
import { TaskHistoryReader } from "./TaskHistoryReader"
import { TaskStackController } from "./TaskStackController"
import { WebviewContentGenerator } from "./WebviewContentGenerator"
import { makeTaskCreationCallback } from "./taskEventForwarding"
import { runTaskHistoryStoreInitialization } from "./initializeTaskHistoryStore"
import { updateTaskApiHandlerIfNeeded } from "./updateTaskApiHandler"

/** `ClineProvider.getState()` が返す状態スナップショット。 */
export type ProviderStateSnapshot = Omit<
	ExtensionState,
	"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version"
>

/**
 * collaborator の配線が ClineProvider に要求する最小表面。
 *
 * ClineProvider は構造的にこれを満たすので、本モジュールは ClineProvider 具象を
 * import せずに済む（`initializeWebview` / `taskEventForwarding` と同じ host パターン）。
 * ここに載っているメンバはすべて「collaborator が実行時に呼び返すもの」であり、
 * **構築時に読まれるものではない**。したがって closure が host を遅延参照する限り、
 * factory の返り値を host へ代入し終える前に呼ばれることはない。
 */
export interface ProviderCollaboratorHost {
	readonly context: vscode.ExtensionContext
	readonly contextProxy: ContextProxy
	readonly cwd: string
	view?: vscode.WebviewView | vscode.WebviewPanel
	webviewDisposables: vscode.Disposable[]

	/**
	 * 構築後に差し替えられうる collaborator は host 経由の遅延参照にする
	 * （spec が `provider.providerSettingsManager = fake` のように後から差し替えるため）。
	 */
	readonly providerSettingsManager: ProviderSettingsManager
	readonly taskHistoryStore: TaskHistoryStore

	getState(): Promise<ProviderStateSnapshot>
	getCurrentTask(): Task | undefined
	getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined

	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]>
	deleteTaskFromState(id: string): Promise<void>

	addClineToStack(task: Task): Promise<void>
	removeClineFromStack(options?: { skipDelegationRepair?: boolean }): Promise<void>
	handleModeSwitch(mode: Mode): Promise<void>
	createTask(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options?: CreateTaskOptions,
		configuration?: Record<string, unknown>,
	): Promise<Task>
	createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	): Promise<Task>
	activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	): Promise<void>

	postStateToWebview(): Promise<void>
	postStateToWebviewWithoutClineMessages(): Promise<void>
	postMessageToWebview(message: ExtensionMessage): Promise<void>

	ensureSettingsDirectoryExists(): Promise<string>

	/** ClineProvider の typed emit。可変長で呼ぶため factory 側で cast する。 */
	emit(eventName: never, ...args: never[]): boolean
	log(message: string): void
}

/**
 * host の private メンバに由来する差し込み口。
 *
 * `getGlobalState` / `updateGlobalState` は `ContextProxy#getValue/setValue` の
 * deprecated な alias で ClineProvider の private のまま残したいが、collaborator の
 * 配線からは呼ぶ必要がある（かつ spec がこの alias に spy を張って履歴を差し込む）。
 * public 面を広げずに渡すため、host interface ではなく明示的な引数にしている。
 */
export interface ProviderCollaboratorHostInternals {
	getGlobalState<K extends keyof GlobalState>(key: K): GlobalState[K]
	updateGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]): Promise<void>
}

/**
 * ClineProvider constructor が `new` していた collaborator 一式。
 *
 * `taskFactory` と同じく、テストがまるごと差し替えられる DI seam
 * （`new ClineProvider(..., { collaborators })`）。
 */
export interface ProviderCollaborators {
	taskHistoryStore: TaskHistoryStore
	historyWriteThrough: GlobalStateHistoryWriteThrough
	recentTasks: RecentTasksCache
	taskHistoryReader: TaskHistoryReader
	taskStack: TaskStackController
	taskDelegation: TaskDelegationController
	taskDeletion: TaskDeletionController
	taskCancellation: TaskCancellationController<Task>
	codeIndexStatus: CodeIndexStatusSubscriber
	workspaceTracker: WorkspaceTracker
	webviewContent: WebviewContentGenerator
	pendingEditOperations: PendingEditOperationManager
	providerSettingsManager: ProviderSettingsManager
	providerProfile: ProviderProfileController
	modeController: ModeController
	historyProfileRestorer: HistoryProfileRestorer
	skillsManager: SkillsManager
	taskCreationCallback: (task: Task) => void
	/**
	 * host が collaborator を field へ代入し**終えてから**呼ぶ起動処理。
	 * 返り値は MCP hub（シングルトンから非同期で届く。解決後に host が保持する）。
	 *
	 * ここで走らせる初期化は host の field を経由して他の collaborator を読む。
	 * factory 内で開始すると代入前の undefined を掴む。
	 *
	 * 注入した collaborator では省略できる（＝副作用のある起動処理が走らない）。
	 */
	startBackgroundInitialization?(): Promise<McpHub>
}

/** ClineProvider の typed emit を可変長で呼ぶための緩いラッパ。 */
function makeLooseEmit(host: ProviderCollaboratorHost): (eventName: AgentEventName, ...args: unknown[]) => void {
	const emit = host.emit as unknown as (name: unknown, ...args: unknown[]) => boolean
	return (eventName, ...args) => {
		emit.call(host, eventName, ...args)
	}
}

/**
 * ClineProvider の collaborator を組み立てる。
 *
 * 責務は「誰が誰を必要とするか」の配線のみ。ここに集約したことで
 * - constructor が代入だけになり、依存グラフが 1 箇所で読める
 * - spec が `collaborators` を丸ごと注入して webview 層の実体化を回避できる
 * ようになる。
 *
 * `skillsManager.initialize()` と TaskHistoryStore の初期化/マイグレーションは
 * 既存挙動どおり fire-and-forget で開始する（collaborator を注入したテストでは
 * これらが走らないのが狙い）。
 */
export function buildProviderCollaborators(
	host: ProviderCollaboratorHost,
	internals: ProviderCollaboratorHostInternals,
): ProviderCollaborators {
	const emit = makeLooseEmit(host)
	const log = (message: string) => host.log(message)
	const globalStoragePath = host.contextProxy.globalStorageUri.fsPath
	const getTaskHistory = (): HistoryItem[] => internals.getGlobalState("taskHistory") ?? []

	// globalState への write-through はミューテーション毎ではなくデバウンスで行う
	// （per-task ファイルが正、globalState はダウングレード互換のためだけ）。
	const historyWriteThrough = new GlobalStateHistoryWriteThrough({
		getItems: () => host.taskHistoryStore.getAll(),
		write: (items) => internals.updateGlobalState("taskHistory", items),
		log,
	})

	const taskHistoryStore = new TaskHistoryStore(globalStoragePath, {
		onWrite: async () => {
			historyWriteThrough.schedule()
		},
	})

	const recentTasks = new RecentTasksCache({
		getHistory: () => host.taskHistoryStore.getAll(),
		getWorkspaceDir: () => host.cwd,
	})

	const taskHistoryReader = new TaskHistoryReader(taskHistoryStore, host.contextProxy, () => getTaskHistory())

	const taskStack = new TaskStackController({
		log,
		getState: () => host.getState(),
		getTaskWithId: (id) => host.getTaskWithId(id),
		updateTaskHistory: (item) => host.updateTaskHistory(item),
	})

	const taskDelegation = new TaskDelegationController({
		log,
		emit,
		getCurrentTask: () => host.getCurrentTask(),
		removeClineFromStack: (options) => host.removeClineFromStack(options),
		handleModeSwitch: (mode) => host.handleModeSwitch(mode),
		createTask: (text, images, parentTask, options) => host.createTask(text, images, parentTask as Task, options),
		createTaskWithHistoryItem: (historyItem, options) => host.createTaskWithHistoryItem(historyItem, options),
		getTaskWithId: (id) => host.getTaskWithId(id),
		updateTaskHistory: (item) => host.updateTaskHistory(item),
		globalStoragePath,
	})

	const taskDeletion = new TaskDeletionController({
		getTaskWithId: (id) => host.getTaskWithId(id),
		getCurrentTaskId: () => host.getCurrentTask()?.taskId,
		removeClineFromStack: () => host.removeClineFromStack(),
		deleteManyFromStore: (ids) => host.taskHistoryStore.deleteMany(ids),
		invalidateRecentTasksCache: () => recentTasks.invalidate(),
		deleteFromState: (id) => host.deleteTaskFromState(id),
		getGlobalStorageDir: () => globalStoragePath,
		getWorkspaceDir: () => host.cwd,
		postStateToWebview: () => host.postStateToWebview(),
	})

	const taskCancellation = new TaskCancellationController<Task>({
		getCurrentTask: () => host.getCurrentTask(),
		getTaskWithId: (id) => host.getTaskWithId(id),
		createTaskWithHistoryItem: (item) => host.createTaskWithHistoryItem(item),
		log,
	})

	const codeIndexStatus = new CodeIndexStatusSubscriber({
		getCurrentManager: () => host.getCurrentWorkspaceCodeIndexManager(),
		postIndexingStatus: (values) => {
			void host.postMessageToWebview({ type: "indexingStatusUpdate", values })
		},
		hasView: () => !!host.view,
		registerDisposable: (disposable) => host.webviewDisposables.push(disposable),
	})

	const providerSettingsManager = new ProviderSettingsManager(host.context)

	const providerProfile = new ProviderProfileController({
		// 構築後に spec が差し替えるので host 経由で遅延参照する
		get providerSettingsManager() {
			return host.providerSettingsManager
		},
		get contextProxy() {
			return host.contextProxy
		},
		getState: () => host.getState(),
		updateGlobalState: (key, value) => internals.updateGlobalState(key, value as never),
		getTaskHistory,
		getTaskHistoryItem: (id) => host.taskHistoryStore.get(id),
		updateTaskApiHandlerIfNeeded: (settings: ProviderSettings, options) =>
			updateTaskApiHandlerIfNeeded(host.getCurrentTask(), settings, options),
		postStateToWebview: () => host.postStateToWebview(),
		emit,
		log,
		getCurrentTask: () => host.getCurrentTask(),
		updateTaskHistory: (item) => host.updateTaskHistory(item),
	})

	const modeController = new ModeController({
		get providerSettingsManager() {
			return host.providerSettingsManager
		},
		getCurrentTask: () => host.getCurrentTask(),
		getTaskHistoryItem: (id) => host.taskHistoryStore.get(id),
		getTaskHistory,
		updateTaskHistory: (item) => host.updateTaskHistory(item),
		setCurrentTaskInternalMode: (task, mode) => {
			task.modeState.mode = mode
		},
		updateGlobalState: (key, value) => internals.updateGlobalState(key, value as never),
		getCurrentApiConfigName: () => internals.getGlobalState("currentApiConfigName"),
		isLockApiConfigAcrossModes: () => isLockApiConfigAcrossModes(host),
		activateProviderProfile: (args) => host.activateProviderProfile(args),
		postStateToWebview: () => host.postStateToWebview(),
		emit,
		log,
	})

	const historyProfileRestorer = new HistoryProfileRestorer({
		updateGlobalState: (key, value) => internals.updateGlobalState(key, value as never),
		isLockApiConfigAcrossModes: () => isLockApiConfigAcrossModes(host),
		get providerSettingsManager() {
			return host.providerSettingsManager
		},
		activateProviderProfile: (args, options) => host.activateProviderProfile(args, options),
		log,
	})

	const skillsManager = new SkillsManager(host)

	// Forward <most> task events to the provider.
	// We do something fairly similar for the IPC-based API.
	const taskCreationCallback = makeTaskCreationCallback(host, {
		emit,
		setCleanup: (instance, cleanupFns) => taskStack.setCleanup(instance, cleanupFns),
	})

	return {
		taskHistoryStore,
		historyWriteThrough,
		recentTasks,
		taskHistoryReader,
		taskStack,
		taskDelegation,
		taskDeletion,
		taskCancellation,
		codeIndexStatus,
		workspaceTracker: new WorkspaceTracker(host),
		webviewContent: new WebviewContentGenerator(host.contextProxy.extensionUri),
		pendingEditOperations: new PendingEditOperationManager(log),
		providerSettingsManager,
		providerProfile,
		modeController,
		historyProfileRestorer,
		skillsManager,
		taskCreationCallback,
		startBackgroundInitialization: () => {
			runTaskHistoryStoreInitialization({
				store: taskHistoryStore,
				getMigratedFlag: (key) => host.context.globalState.get<boolean>(key),
				getLegacyHistory: () => host.context.globalState.get<HistoryItem[]>("taskHistory") ?? [],
				setMigratedFlag: (key) => Promise.resolve(host.context.globalState.update(key, true)),
				log,
			}).catch((error) => log(`Failed to initialize TaskHistoryStore: ${error}`))

			skillsManager.initialize().catch((error) => log(`Failed to initialize Skills Manager: ${error}`))

			// Initialize MCP Hub through the singleton manager
			return McpServerManager.getInstance(host.context, host)
		},
	}
}

function isLockApiConfigAcrossModes(host: ProviderCollaboratorHost): boolean {
	return host.context.workspaceState.get("lockApiConfigAcrossModes", false)
}
