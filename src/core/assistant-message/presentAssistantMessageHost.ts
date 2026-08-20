import type { ToolResultBlockParam, TextBlockParam, ImageBlockParam } from "@openai-agent/types"
import type {
	ClineAsk,
	ClineAskResponse,
	ClineSay,
	ContextCondense,
	ContextTruncation,
	ToolName,
	ToolProgressStatus,
} from "@openai-agent/types"

import type { ApiHandler } from "../../api/types"
import type { TaskProviderRef } from "../task/taskProviderRef"
import type { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"

import type { AssistantMessageContent } from "./types"

// Narrow structural surface of Task that presentAssistantMessage() and
// checkpointSaveAndMark() consume. Defined here (instead of importing Task)
// so this module — and presentAssistantMessage.ts that imports it — do not
// depend on core/task/Task.ts, breaking the last remaining
// Task ↔ presentAssistantMessage cycle.
//
// Task satisfies this shape structurally; no change needed on Task.

export interface PresentAssistantMessageCline {
	readonly taskId: string
	readonly instanceId: string

	// Streaming / assistant message state（StreamingSession 集約）
	abort: boolean
	stream: {
		assistantMessageContent: AssistantMessageContent[]
		currentStreamingContentIndex: number
		currentStreamingDidCheckpoint: boolean
		didCompleteReadingStream: boolean
		didAlreadyUseTool: boolean
		didRejectTool: boolean
		presentAssistantMessageLocked: boolean
		presentAssistantMessageHasPendingUpdates: boolean
		userMessageContent: (TextBlockParam | ImageBlockParam | ToolResultBlockParam)[]
		userMessageContentReady: boolean
	}

	// Tool bookkeeping
	mistakeTracker: { count: number }
	toolRepetitionDetector: ToolRepetitionDetector
	tokenUsageTracker: {
		recordToolUsage(toolName: ToolName): void
		recordToolError(toolName: ToolName, error?: string): void
	}
	pushToolResultToUserContent(toolResult: ToolResultBlockParam): boolean

	// Interaction with host / api / webview
	readonly api: ApiHandler
	readonly providerRef: WeakRef<TaskProviderRef>
	ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
	say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options?: { isNonInteractive?: boolean },
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined>

	// Members touched by checkpointSaveAndMark (private helper in
	// presentAssistantMessage.ts, still receives a Task-shaped instance).
	// currentStreamingDidCheckpoint は上の stream {...} に含む。
	checkpointSave(force?: boolean, suppressMessage?: boolean): Promise<unknown>
}
