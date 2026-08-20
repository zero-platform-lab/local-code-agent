import type { ContentBlockParam, MessageParam, ToolResultBlockParam } from "@openai-agent/types"
import type { ClineAsk, ClineMessage, ClineSay, ModelInfo } from "@openai-agent/types"

import type { ApiHandler } from "../../api"
import type { ApiStream } from "../../api/transform/stream"
import { ClineAskResponse } from "../../shared/WebviewMessage"

import { makeStreamClosures, type MakeStreamClosuresHost } from "./makeStreamClosures"
import { resetStreamingStateForNewApiRequest, type TaskStreamingStateHost } from "./resetStreamingStateForNewApiRequest"
import { runOneApiIteration, type RunOneApiIterationHost, type RunOneApiIterationResult } from "./runOneApiIteration"

/**
 * 1 request 分の実行に必要な準備（token accumulator、reset state、model info
 * cache、closure factory）と `runOneApiIteration` 呼び出しを統合したモジュール。
 *
 * 呼び出し側 while ループは `runOneRequest` を呼んで返り値に応じて
 * stack push / break / continue するだけで良い。
 */
export type RunOneRequestHost = MakeStreamClosuresHost &
	RunOneApiIterationHost &
	TaskStreamingStateHost & {
		api: ApiHandler
		stream: {
			cachedStreamingModel?: { info: ModelInfo; id: string }
		}
		/** deps callback を減らすため host の method を直接呼び出す（narrow host pattern）。 */
		say: (
			type: ClineSay,
			text?: string,
			images?: string[],
			partial?: boolean,
			checkpoint?: Record<string, unknown>,
			progressStatus?: undefined,
			options?: { isNonInteractive?: boolean },
		) => Promise<unknown>
		ask: (
			type: ClineAsk,
			text?: string,
		) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
		updateClineMessage: (m: ClineMessage) => Promise<unknown>
		saveClineMessages: () => Promise<unknown>
		addToApiConversationHistory: (message: MessageParam, reasoning?: string) => Promise<unknown>
		pushToolResultToUserContent: (toolResult: ToolResultBlockParam) => boolean
		backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
		abortTask: () => Promise<unknown>
		postStateToWebviewWithoutTaskHistory: () => Promise<unknown> | undefined
		providerRef: WeakRef<{ getState(): Promise<{ autoApprovalEnabled?: boolean } | undefined> }>
		attemptApiRequest: (retryAttempt: number, options: { skipProviderRateLimit?: boolean }) => ApiStream
	}

export interface RunOneRequestDeps {
	host: RunOneRequestHost
	presentAssistantMessage: () => void
}

export interface RunOneRequestInput {
	lastApiReqIndex: number
	currentUserContent: ContentBlockParam[]
	currentRetryAttempt: number
}

export async function runOneRequest(
	deps: RunOneRequestDeps,
	input: RunOneRequestInput,
): Promise<RunOneApiIterationResult> {
	const { host } = deps

	const tokens = {
		input: 0,
		output: 0,
		cacheWrite: 0,
		cacheRead: 0,
		total: undefined as number | undefined,
	}

	// We can't use `api_req_finished` anymore since it's a unique case where it
	// could come after a streaming message (i.e. in the middle of being updated
	// or executed).
	// Fortunately `api_req_finished` was always parsed out for the GUI anyways,
	// so it remains solely for legacy purposes to keep track of prices in tasks
	// from history (it's worth removing a few months from now).
	await resetStreamingStateForNewApiRequest(host)

	// Cache model info once per API request to avoid repeated calls during
	// streaming. This is especially important for tools and background usage
	// collection.
	host.stream.cachedStreamingModel = host.api.getModel()
	const streamModelInfo = host.stream.cachedStreamingModel.info

	const { updateApiReqMsg, abortStream } = makeStreamClosures(host, {
		lastApiReqIndex: input.lastApiReqIndex,
		streamModelInfo,
		getTokens: () => tokens,
	})

	// Yields only if the first chunk is successful, otherwise will allow the
	// user to retry the request (most likely due to rate limit error, which
	// gets thrown on the first chunk).
	const stream = host.attemptApiRequest(input.currentRetryAttempt, { skipProviderRateLimit: true })

	return runOneApiIteration(
		{
			host,
			presentAssistantMessage: deps.presentAssistantMessage,
			say: host.say.bind(host),
			sayForReasoning: host.say.bind(host) as never,
			ask: host.ask.bind(host),
			abortStream,
			updateApiReqMsg,
			updateClineMessage: host.updateClineMessage.bind(host),
			saveClineMessages: host.saveClineMessages.bind(host),
			postStateToWebviewWithoutTaskHistory: host.postStateToWebviewWithoutTaskHistory.bind(host),
			addToApiConversationHistory: host.addToApiConversationHistory.bind(host),
			pushToolResultToUserContent: host.pushToolResultToUserContent.bind(host),
			getProviderState: async () => host.providerRef.deref()?.getState(),
			backoffAndAnnounce: host.backoffAndAnnounce.bind(host),
			abortTask: host.abortTask.bind(host),
		},
		{
			stream,
			tokens,
			lastApiReqIndex: input.lastApiReqIndex,
			currentUserContent: input.currentUserContent,
			currentRetryAttempt: input.currentRetryAttempt,
		},
	)
}
