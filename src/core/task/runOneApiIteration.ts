import type { ContentBlockParam, MessageParam, ToolResultBlockParam } from "@openai-agent/types"
import type { ClineAsk, ClineApiReqCancelReason, ClineMessage, ClineSay } from "@openai-agent/types"

import type { ApiStream } from "../../api/transform/stream"
import { ClineAskResponse } from "../../shared/WebviewMessage"

import type { UsageAccumulatorState } from "./drainStreamInBackgroundToFindAllUsage"
import { finalizeStreamCompletion, type FinalizeStreamCompletionStateHost } from "./finalizeStreamCompletion"
import {
	handleMidStreamError as runHandleMidStreamError,
	type HandleMidStreamErrorStateHost,
	type MidStreamRetryStackItem,
} from "./handleMidStreamError"
import {
	processAssistantContentBranch,
	type ProcessAssistantContentBranchHost,
	type ProcessAssistantContentBranchResult,
} from "./processAssistantContentBranch"
import { runStreamingLoop, type RunStreamingLoopHost } from "./runStreamingLoop"
import type { EmptyResponseRetryStackItem } from "./handleEmptyAssistantResponse"
import type { FinalizeIterationStackItem } from "./finalizeAssistantIterationForStack"

/**
 * 1 request 分の streaming / catch (mid-stream error) / finally / abort check /
 * finalize / content branch を集約したモジュール。
 *
 * 呼び出し側の while ループが握るべき「stack push / break / continue」の判断だけを
 * 返り値の action で通知する（handleMidStreamError / handleEmptyAssistantResponse /
 * processAssistantContentBranch と同じ設計）。
 */
export type RunOneApiIterationHost = RunStreamingLoopHost &
	HandleMidStreamErrorStateHost &
	FinalizeStreamCompletionStateHost &
	ProcessAssistantContentBranchHost & {
		stream: {
			isStreaming: boolean
			currentRequestAbortController?: AbortController
			didCompleteReadingStream: boolean
		}
		instanceId: string | number
	}

export interface RunOneApiIterationDeps {
	host: RunOneApiIterationHost
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
	sayForReasoning: (type: ClineSay, text: string, images: undefined, partial: true) => Promise<unknown>
	ask: (type: ClineAsk, text?: string) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
	abortStream: (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => Promise<void>
	updateApiReqMsg: () => void
	updateClineMessage: (m: ClineMessage) => Promise<unknown>
	saveClineMessages: () => Promise<unknown>
	postStateToWebviewWithoutTaskHistory: () => Promise<unknown> | undefined
	addToApiConversationHistory: (message: MessageParam, reasoning?: string) => Promise<unknown>
	pushToolResultToUserContent: (toolResult: ToolResultBlockParam) => boolean
	getProviderState: () => Promise<{ autoApprovalEnabled?: boolean } | undefined>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
	abortTask: () => Promise<unknown>
}

export interface RunOneApiIterationInput {
	stream: ApiStream
	tokens: UsageAccumulatorState
	lastApiReqIndex: number
	currentUserContent: ContentBlockParam[]
	currentRetryAttempt: number
}

export type RunOneApiIterationResult =
	| {
			action: "continue"
			nextStackItem?: FinalizeIterationStackItem | EmptyResponseRetryStackItem | MidStreamRetryStackItem
	  }
	| { action: "break" }
	| { action: "abandoned" }

export async function runOneApiIteration(
	deps: RunOneApiIterationDeps,
	input: RunOneApiIterationInput,
): Promise<RunOneApiIterationResult> {
	const { host } = deps

	host.stream.isStreaming = true

	let assistantMessage = ""
	let reasoningMessage = ""

	try {
		;({ assistantMessage, reasoningMessage } = await runStreamingLoop(
			{
				host,
				presentAssistantMessage: deps.presentAssistantMessage,
				say: deps.sayForReasoning,
				abortStream: deps.abortStream,
				updateApiReqMsg: deps.updateApiReqMsg,
				updateClineMessage: deps.updateClineMessage,
			},
			input.stream,
			input.tokens,
			input.lastApiReqIndex,
		))
	} catch (error) {
		const midStreamResult = await runHandleMidStreamError(
			{
				host,
				abortStream: deps.abortStream,
				abortTask: deps.abortTask,
				getProviderState: deps.getProviderState,
				backoffAndAnnounce: deps.backoffAndAnnounce,
			},
			error,
			input.currentUserContent,
			input.currentRetryAttempt,
		)

		if (midStreamResult.action === "break") {
			// finally: reset streaming state before returning
			host.stream.isStreaming = false
			host.stream.currentRequestAbortController = undefined
			return { action: "break" }
		}
		if (midStreamResult.action === "continue" && midStreamResult.retryStackItem) {
			host.stream.isStreaming = false
			host.stream.currentRequestAbortController = undefined
			return { action: "continue", nextStackItem: midStreamResult.retryStackItem }
		}
		// noop: abandoned / user cancelled 経路。fall through to finally.
		host.stream.isStreaming = false
		host.stream.currentRequestAbortController = undefined
		return { action: "abandoned" }
	}

	// finally: reset streaming state (equivalent to the original try/finally)
	host.stream.isStreaming = false
	host.stream.currentRequestAbortController = undefined

	// Need to call here in case the stream was aborted.
	if (host.abort || host.abandoned) {
		throw new Error(`[Agent#recursivelyMakeAgentRequests] task ${host.taskId}.${host.instanceId} aborted`)
	}

	host.stream.didCompleteReadingStream = true

	const { partialBlocks } = await finalizeStreamCompletion(
		{
			host,
			presentAssistantMessage: deps.presentAssistantMessage,
			updateClineMessage: deps.updateClineMessage,
			saveClineMessages: deps.saveClineMessages,
			postStateToWebviewWithoutTaskHistory: deps.postStateToWebviewWithoutTaskHistory,
		},
		reasoningMessage,
	)

	const branchResult: ProcessAssistantContentBranchResult = await processAssistantContentBranch(
		{
			host,
			presentAssistantMessage: deps.presentAssistantMessage,
			say: deps.say,
			ask: deps.ask,
			addToApiConversationHistory: deps.addToApiConversationHistory,
			pushToolResultToUserContent: deps.pushToolResultToUserContent,
			getProviderState: deps.getProviderState,
			backoffAndAnnounce: deps.backoffAndAnnounce,
		},
		{
			assistantMessage,
			reasoningMessage,
			partialBlocks,
			currentUserContent: input.currentUserContent,
			currentRetryAttempt: input.currentRetryAttempt,
		},
	)

	if (branchResult.action === "break") return { action: "break" }
	return { action: "continue", nextStackItem: branchResult.nextStackItem }
}
