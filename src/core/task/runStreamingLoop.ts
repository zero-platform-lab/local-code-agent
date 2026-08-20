import type { ClineApiReqCancelReason, ClineMessage, ClineSay } from "@openai-agent/types"

import type { ApiStream } from "../../api/transform/stream"

import { checkAbortOrInterruption, type CheckAbortOrInterruptionHost } from "./checkAbortOrInterruption"
import type { UsageAccumulatorState } from "./drainStreamInBackgroundToFindAllUsage"
import { makeDrainStreamInBackground } from "./makeDrainStreamInBackground"
import { makeNextChunkWithAbort } from "./makeNextChunkWithAbort"
import { processStreamChunk, type ProcessStreamChunkStateHost } from "./processStreamChunk"

/**
 * `recursivelyMakeClineRequests` の try streaming ブロック本体。
 *
 * responsibility:
 *  - iterator を race-abort ラッパーで包み、while ループで chunk を消化
 *  - `processStreamChunk` で chunk 種別ごとに dispatch（reasoning/text/usage/tool_call 等）
 *  - 1 chunk 処理後に `checkAbortOrInterruption` で abort/中断判定 → break
 *  - ループ後に `drainStreamInBackground` を fire-and-forget で起動
 *    （残 chunk の usage を回収）
 *
 * catch (mid-stream error) と finally (isStreaming reset) は呼び出し側の Task
 * 直下に残す：midStreamResult による stack push / break は while ループ制御の
 * 責務のため。
 */
export type RunStreamingLoopHost = CheckAbortOrInterruptionHost &
	ProcessStreamChunkStateHost & {
		taskId: string
		apiConfiguration: import("@openai-agent/types").ProviderSettings
		messageStore: { clineMessages: ClineMessage[] }
		saveClineMessages: () => Promise<unknown>
		stream: {
			currentRequestAbortController?: AbortController
		}
	}

export interface RunStreamingLoopDeps {
	host: RunStreamingLoopHost
	presentAssistantMessage: () => void
	say: (type: ClineSay, text: string, images: undefined, partial: true) => Promise<unknown>
	abortStream: (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => Promise<void>
	updateApiReqMsg: () => void
	updateClineMessage: (m: ClineMessage) => Promise<unknown>
}

export interface RunStreamingLoopResult {
	assistantMessage: string
	reasoningMessage: string
}

export async function runStreamingLoop(
	deps: RunStreamingLoopDeps,
	stream: ApiStream,
	tokens: UsageAccumulatorState,
	lastApiReqIndex: number,
): Promise<RunStreamingLoopResult> {
	const { host } = deps

	let assistantMessage = ""
	let reasoningMessage = ""

	const iterator = stream[Symbol.asyncIterator]()
	const nextChunkWithAbort = makeNextChunkWithAbort(iterator, () => host.stream.currentRequestAbortController)

	let item = await nextChunkWithAbort()
	while (!item.done) {
		const chunk = item.value
		item = await nextChunkWithAbort()
		if (!chunk) {
			// Sometimes chunk is undefined, no idea that can cause it, but this
			// workaround seems to fix it.
			continue
		}

		;({ reasoningMessage, assistantMessage } = await processStreamChunk(
			{ host, presentAssistantMessage: deps.presentAssistantMessage, say: deps.say },
			chunk,
			{ reasoningMessage, assistantMessage },
			tokens,
		))

		const loopStep = await checkAbortOrInterruption(host, deps.abortStream)
		if (loopStep.stop) {
			if (loopStep.assistantMessageSuffix) {
				assistantMessage += loopStep.assistantMessageSuffix
			}
			break
		}
	}

	// Note: usage 反映は factory 内の onCapturedUsage に集約。
	const drainStream = makeDrainStreamInBackground(host, tokens, {
		updateApiReqMsg: deps.updateApiReqMsg,
		updateClineMessage: deps.updateClineMessage,
	})

	// Start the background task and handle any errors
	drainStream(lastApiReqIndex, iterator, item, lastApiReqIndex).catch((error) => {
		console.error("Background usage collection failed:", error)
	})

	return { assistantMessage, reasoningMessage }
}
