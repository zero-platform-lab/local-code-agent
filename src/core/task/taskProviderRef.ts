import type * as vscode from "vscode"

import type { AgentEventName, ExtensionState, HistoryItem } from "@openai-agent/types"

import type { ContextProxy } from "../config/ContextProxy"
import type { McpHub } from "../../services/mcp/McpHub"
import type { McpProviderRef } from "../../services/mcp/mcpProviderRef"
import type { SkillsManager } from "../../services/skills/SkillsManager"

// Narrow surface that Task consumes from its hosting ClineProvider. Defining
// this here (instead of importing ClineProvider) breaks the task ↔ webview
// cycle: ClineProvider structurally satisfies the shape, no nominal dependency
// is needed either direction.
//
// Extends McpProviderRef because Task passes this same provider through to
// `McpServerManager.getInstance(provider.context, provider)`; that call site
// expects an McpProviderRef.
//
// Additionally, several downstream helpers Task hands `this` to require their
// own narrow views of the provider, so this interface has to cover them all
// (else `this` won't satisfy their host types):
//   • FileContextProvider (from FileContextTracker) needs `contextProxy`.
//   • CheckpointProviderLike (from core/checkpoints) needs `cancelTask`,
//     `log`, `postMessageToWebview`, `context.globalStorageUri.fsPath`.
//   • BuildToolsProvider (from core/task/build-tools) needs `context` and
//     `getMcpHub` — already covered.

// Matches the real ClineProvider.getState() shape.
type TaskProviderState = Omit<ExtensionState, "clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version">

export interface TaskProviderRef extends McpProviderRef {
	readonly context: vscode.ExtensionContext
	readonly contextProxy: ContextProxy

	log(message: string): void
	cancelTask(): Promise<void>

	getSkillsManager(): SkillsManager | undefined
	getMcpHub(): McpHub | undefined

	getState(): Promise<TaskProviderState>

	handleModeSwitch(mode: string): Promise<unknown>
	setMode(mode: string): Promise<void>
	setProviderProfile(name: string): Promise<void>

	postStateToWebviewWithoutTaskHistory(): Promise<void>
	updateTaskHistory(item: HistoryItem, options?: { broadcast?: boolean }): Promise<HistoryItem[]>

	// EventEmitter surface. Loose signature — Task only listens for
	// AgentEventName.ProviderProfileChanged; the concrete listener type lives
	// with the emitter and doesn't need to be re-declared here.
	on(event: AgentEventName, listener: (...args: any[]) => void): unknown
	off(event: AgentEventName, listener: (...args: any[]) => void): unknown
}
