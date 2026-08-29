import type * as vscode from "vscode"

import type {
	AgentSettings,
	AutonomyMode,
	CreateTaskOptions,
	ExtensionMessage,
	ExtensionState,
	HistoryItem,
	ProviderSettings,
} from "@openai-agent/types"

import type { Mode } from "../../shared/modes"

import type { AggregatedCosts } from "./aggregateTaskCosts"
import type { ContextProxy } from "../config/ContextProxy"
import type { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import type { CodeIndexManager } from "../../services/code-index/manager"
import type { McpHub } from "../../services/mcp/McpHub"
import type { SkillsManager } from "../../services/skills/SkillsManager"
import type { Task } from "../task/Task"
import type WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

// Narrow surface of ClineProvider that webviewMessageHandler consumes.
// Defined here (instead of importing ClineProvider) so this file — and the
// handler that imports it — do not depend on the concrete class, breaking the
// ClineProvider ↔ webviewMessageHandler cycle. ClineProvider structurally
// satisfies the shape; no change needed on the ClineProvider side.
//
// This interface additionally has to cover CheckpointRestoreProvider (from
// ./checkpointRestoreHandler) because the handler passes `provider` and
// `currentCline` into `handleCheckpointRestoreOperation`.

/**
 * The handler uses many Task members; alias the concrete Task class here.
 * This creates a `webviewMessageHost → task/Task` type edge, but Task no
 * longer depends on the webview layer (fixed in PR #88), so no cycle forms.
 */
export type HandlerTaskView = Task

// Matches the real ClineProvider.getState() shape.
type WebviewMessageHostState = Omit<
	ExtensionState,
	"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version"
>

export interface WebviewMessageHost {
	// ---- Properties ----
	readonly context: vscode.ExtensionContext
	readonly contextProxy: ContextProxy
	readonly cwd: string
	readonly providerSettingsManager: ProviderSettingsManager
	readonly workspaceTracker: WorkspaceTracker | undefined
	isViewLaunched: boolean
	readonly pendingEditOperations: {
		set(
			operationId: string,
			value: {
				messageTs: number
				editedContent: string
				images?: string[]
				messageIndex: number
				apiConversationHistoryIndex: number
			},
		): unknown
	}

	// ---- Logging ----
	log(message: string): void

	// ---- Webview messaging ----
	postMessageToWebview(message: ExtensionMessage): Promise<unknown>
	postStateToWebview(): Promise<void>
	getState(): Promise<WebviewMessageHostState>
	getStateToPostToWebview(): Promise<ExtensionState>
	resetState(): Promise<void>

	// ---- Task lifecycle ----
	createTask(
		text?: string,
		images?: string[],
		parentTask?: unknown,
		options?: CreateTaskOptions,
		configuration?: AgentSettings,
	): Promise<HandlerTaskView>
	createTaskWithHistoryItem(historyItem: HistoryItem): Promise<unknown>
	cancelTask(): Promise<void>
	clearTask(): Promise<void>
	getCurrentTask(): HandlerTaskView | undefined
	getTaskWithId(taskId: string): Promise<{ historyItem: HistoryItem }>
	showTaskWithId(id: string): Promise<unknown>
	exportTaskWithId(id: string): Promise<unknown>
	deleteTaskWithId(id: string, cascadeSubtasks?: boolean): Promise<unknown>
	getTaskWithAggregatedCosts(taskId: string): Promise<{
		historyItem: HistoryItem
		aggregatedCosts: AggregatedCosts
	}>
	condenseTaskContext(taskId: string): Promise<unknown>

	// ---- Mode / profile ----
	handleModeSwitch(newMode: Mode): Promise<unknown>
	getModes(): Promise<{ slug: string; name: string }[]>
	updateCustomInstructions(instructions?: string): Promise<unknown>
	setAutonomyMode(mode: AutonomyMode): Promise<unknown>
	activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	): Promise<unknown>
	upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate?: boolean,
	): Promise<string | undefined>

	// ---- Sub-controllers ----
	getMcpHub(): McpHub | undefined
	getSkillsManager(): SkillsManager | undefined
	getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined
}
