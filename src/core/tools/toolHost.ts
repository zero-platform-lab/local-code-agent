import type {
	ClineAsk,
	ClineAskResponse,
	ClineSay,
	Experiments,
	ToolName,
	ToolProgressStatus,
} from "@openai-agent/types"

import type { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import type { AgentIgnoreController } from "../ignore/AgentIgnoreController"
import type { AgentProtectedController } from "../protect/AgentProtectedController"

/**
 * Narrow structural views of the `Task` members used by tool implementations.
 *
 * These interfaces intentionally avoid importing the concrete `Task` so that
 * tool modules do not depend on the task layer (which would otherwise create
 * module cycles). `Task` satisfies them structurally, and because method
 * parameters are bivariant, a tool may override `BaseTool`'s `task: Task`
 * parameter with one of these wider interfaces without changing `BaseTool`.
 */

/** Members shared by every tool host in this batch. */
export interface ToolTaskContext {
	mistakeTracker: { count: number }
	/** ツール使用量の記録は Task ではなく TokenUsageTracker が所有する。 */
	tokenUsageTracker: {
		recordToolUsage(toolName: ToolName): void
		recordToolError(toolName: ToolName, error?: string): void
	}
	sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string): Promise<string>
	ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
}

/** `Task.say`, mixed into hosts for tools that emit chat messages. */
export interface ToolTaskSay {
	say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options?: { isNonInteractive?: boolean },
	): Promise<undefined>
}

/** `Task.fileContextTracker` narrowed to the single method file tools use. */
export interface ToolFileContextTracker {
	readonly fileContextTracker: {
		trackFileContext(filePath: string, operation: RecordSource): Promise<unknown>
	}
}

/** `Task.diffViewProvider` narrowed to the members the diff-based edit tools use. */
export interface ToolDiffViewProvider {
	readonly diffViewProvider: {
		editType?: "create" | "modify"
		originalContent: string | undefined
		readonly isEditing: boolean
		open(relPath: string): Promise<unknown>
		update(accumulatedContent: string, isFinal: boolean): Promise<unknown>
		reset(): Promise<unknown>
		revertChanges(): Promise<unknown>
		scrollToFirstDiff(): void
		saveChanges(
			diagnosticsEnabled?: boolean,
			writeDelayMs?: number,
		): Promise<{
			newProblemsMessage: string | undefined
			userEdits: string | undefined
			finalContent: string | undefined
		}>
		saveDirectly(
			relPath: string,
			content: string,
			openFile?: boolean,
			diagnosticsEnabled?: boolean,
			writeDelayMs?: number,
		): Promise<{
			newProblemsMessage: string | undefined
			userEdits: string | undefined
			finalContent: string | undefined
		}>
		pushToolWriteResult(task: unknown, cwd: string, isNewFile: boolean): Promise<string>
	}
}

/** State fields read by the diff-based edit tools via `provider.getState()`. */
export interface ToolEditProviderState {
	diagnosticsEnabled?: boolean
	experiments?: Experiments
	writeDelayMs?: number
}

/**
 * Shared host for diff-based file-edit tools (SearchReplace / WriteToFile / Edit / ApplyDiff).
 * Bundles the common `Task` surface those tools use so each tool's host is just
 * `ToolEditContext` (plus a couple of tool-specific extras).
 */
export interface ToolEditContext extends ToolTaskContext, ToolTaskSay, ToolFileContextTracker, ToolDiffViewProvider {
	readonly cwd: string
	didEditFile: boolean
	processQueuedMessages(): void
	readonly rooIgnoreController?: AgentIgnoreController
	readonly rooProtectedController?: AgentProtectedController
	readonly providerRef: WeakRef<{ getState(): Promise<ToolEditProviderState> }>
}
