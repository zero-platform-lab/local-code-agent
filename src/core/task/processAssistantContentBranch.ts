import type { ContentBlockParam, MessageParam, ToolResultBlockParam } from "@openai-agent/types"
import type { ClineAsk, ClineSay } from "@openai-agent/types"

import type { AssistantMessageContent } from "../assistant-message/types"
import { ClineAskResponse } from "../../shared/WebviewMessage"

import { persistAssistantContentIfAny, type PersistAssistantContentStateHost } from "./persistAssistantContentIfAny"
import {
	finalizeAssistantIterationForStack,
	type FinalizeIterationHost,
	type FinalizeIterationStackItem,
} from "./finalizeAssistantIterationForStack"
import {
	handleEmptyAssistantResponse as runHandleEmptyAssistantResponse,
	type EmptyResponseAction,
	type EmptyResponseRetryStackItem,
	type HandleEmptyAssistantResponseStateHost,
} from "./handleEmptyAssistantResponse"

/**
 * stream 完了直後の「アシスタントに何かしらの content があったか」で分岐する
 * ロジックをまとめた module。
 *
 * hasContent の場合:
 *  1. persistAssistantContentIfAny で assistant message を API 履歴に保存
 *  2. partial blocks があれば presentAssistantMessage を1回呼ぶ
 *  3. finalizeAssistantIterationForStack で次の StackItem を組む
 *  → `{ action: "continue", nextStackItem? }`
 *
 * hasContent が false の場合:
 *  - handleEmptyAssistantResponse に処理を委ねる（retry / break / continue）
 */
export type ProcessAssistantContentBranchHost = FinalizeIterationHost &
	HandleEmptyAssistantResponseStateHost &
	PersistAssistantContentStateHost & {
		stream: {
			assistantMessageContent: AssistantMessageContent[]
		}
	}

export interface ProcessAssistantContentBranchDeps {
	host: ProcessAssistantContentBranchHost
	presentAssistantMessage: () => void
	say: (
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: undefined,
		options?: { isNonInteractive?: boolean },
	) => Promise<unknown>
	ask: (type: ClineAsk, text?: string) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
	addToApiConversationHistory: (message: MessageParam, reasoning?: string) => Promise<unknown>
	pushToolResultToUserContent: (toolResult: ToolResultBlockParam) => boolean
	getProviderState: () => Promise<{ autoApprovalEnabled?: boolean } | undefined>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
}

export interface ProcessAssistantContentBranchInput {
	assistantMessage: string
	reasoningMessage: string
	partialBlocks: AssistantMessageContent[]
	currentUserContent: ContentBlockParam[]
	currentRetryAttempt: number
}

export type ProcessAssistantContentBranchResult =
	| { action: "continue"; nextStackItem?: FinalizeIterationStackItem | EmptyResponseRetryStackItem }
	| { action: "break" }

export async function processAssistantContentBranch(
	deps: ProcessAssistantContentBranchDeps,
	input: ProcessAssistantContentBranchInput,
): Promise<ProcessAssistantContentBranchResult> {
	const { host } = deps

	const hasTextContent = input.assistantMessage.length > 0
	const hasToolUses = host.stream.assistantMessageContent.some(
		(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
	)

	if (hasTextContent || hasToolUses) {
		// Save the assistant message to API history BEFORE presenting the final partial blocks.
		// When new_task is in the batch, it triggers delegation which calls flushPendingToolResultsToHistory();
		// tool_results appear before tool_use blocks if the assistant message isn't saved yet.
		await persistAssistantContentIfAny(
			{
				host,
				say: deps.say as never,
				addToApiConversationHistory: deps.addToApiConversationHistory,
				pushToolResultToUserContent: deps.pushToolResultToUserContent,
			},
			input.assistantMessage,
			input.reasoningMessage,
		)

		// Present any partial blocks that were just completed.
		// Tool calls are typically presented during streaming via tool_call_partial events,
		// but we still present here if any partial blocks remain (e.g., malformed streams).
		if (input.partialBlocks.length > 0) {
			deps.presentAssistantMessage()
		}

		const nextStackItem = await finalizeAssistantIterationForStack(host)
		return { action: "continue", nextStackItem }
	}

	// Also present any partial blocks that may exist even without content (defensive).
	if (input.partialBlocks.length > 0) {
		deps.presentAssistantMessage()
	}

	const emptyResult: EmptyResponseAction = await runHandleEmptyAssistantResponse(
		{
			host,
			say: deps.say,
			ask: deps.ask,
			getProviderState: deps.getProviderState,
			addToApiConversationHistory: (m) => deps.addToApiConversationHistory(m),
			backoffAndAnnounce: deps.backoffAndAnnounce,
		},
		input.currentUserContent,
		input.currentRetryAttempt,
	)

	if (emptyResult.action === "break") {
		return { action: "break" }
	}
	return { action: "continue", nextStackItem: emptyResult.retryStackItem }
}
