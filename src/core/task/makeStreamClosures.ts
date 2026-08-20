import type { ClineApiReqCancelReason, ClineMessage, ModelInfo } from "@openai-agent/types"

import { updateApiReqMsg as runUpdateApiReqMsg, abortStream as runAbortStream } from "./apiReqMessageUpdater"

/**
 * `recursivelyMakeClineRequests` の try ブロック冒頭で組み立てていた
 * `updateApiReqMsg` / `abortStream` の 2 closure を factory 化。
 *
 * トークン集計 5 変数（inputTokens / outputTokens / ...）と
 * `lastApiReqIndex` / `streamModelInfo` を毎回 closure に閉じ込めていた
 * ボイラープレートを 1 呼び出しにまとめる。
 *
 * `getTokens` は「呼び出し時点のスナップショット」を返す getter を呼び出し側で
 * 提供する（トークン変数の += 更新は while ループ内で行う）。
 */
export interface MakeStreamClosuresHost {
	diffViewProvider: { readonly isEditing: boolean; revertChanges: () => Promise<unknown> }
	messageStore: { clineMessages: ClineMessage[] }
	didFinishAbortingStream: boolean
	saveClineMessages: () => Promise<unknown>
}

export interface MakeStreamClosuresInput {
	lastApiReqIndex: number
	streamModelInfo: ModelInfo
	getTokens: () => {
		input: number
		output: number
		cacheWrite: number
		cacheRead: number
		total?: number
	}
}

export interface StreamClosures {
	updateApiReqMsg: (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => void
	abortStream: (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => Promise<void>
}

export function makeStreamClosures(host: MakeStreamClosuresHost, input: MakeStreamClosuresInput): StreamClosures {
	const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) =>
		runUpdateApiReqMsg(
			{
				getClineMessages: () => host.messageStore.clineMessages,
				lastApiReqIndex: input.lastApiReqIndex,
				streamModelInfo: input.streamModelInfo,
				getTokens: input.getTokens,
			},
			cancelReason,
			streamingFailedMessage,
		)

	const abortStream = (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) =>
		runAbortStream(
			{
				diffViewProvider: host.diffViewProvider,
				getClineMessages: () => host.messageStore.clineMessages,
				updateApiReqMsg,
				saveClineMessages: host.saveClineMessages,
				setDidFinishAbortingStream: (v) => {
					host.didFinishAbortingStream = v
				},
			},
			cancelReason,
			streamingFailedMessage,
		)

	return { updateApiReqMsg, abortStream }
}
