import {
	type ClineApiReqCancelReason,
	type ClineApiReqInfo,
	type ClineMessage,
	type ModelInfo,
} from "@openai-agent/types"

import { calculateApiCostOpenAI } from "../../shared/cost"

/**
 * `recursivelyMakeClineRequests` の while ループ内で使われていた2つのクロージャ
 * `updateApiReqMsg` と `abortStream` を切り出したもの。両者は「api_req_started
 * メッセージのメタ情報更新」を共有するため1モジュールに置く。
 *
 * どちらも closure で外側の mutable 変数（トークン集計 5つ）を参照していたが、
 * ここでは呼び出し側から現在値を getter で渡してもらう形にする。
 */

/** api_req_started メッセージのメタデータを最新のトークン値で書き換える。 */
export interface UpdateApiReqMsgDeps {
	getClineMessages: () => ClineMessage[]
	lastApiReqIndex: number
	streamModelInfo: ModelInfo
	/** 現在の累積トークン値（呼び出し時点のスナップショットを返す）。 */
	getTokens: () => {
		input: number
		output: number
		cacheWrite: number
		cacheRead: number
		total?: number
	}
}

export function updateApiReqMsg(
	deps: UpdateApiReqMsgDeps,
	cancelReason?: ClineApiReqCancelReason,
	streamingFailedMessage?: string,
): void {
	const clineMessages = deps.getClineMessages()
	if (deps.lastApiReqIndex < 0 || !clineMessages[deps.lastApiReqIndex]) {
		return
	}

	const tokens = deps.getTokens()
	// text が壊れた JSON でも drain / abortStream 経路で throw させない。壊れていれば空から組み立て直す。
	let existingData: Record<string, unknown> = {}
	try {
		existingData = JSON.parse(clineMessages[deps.lastApiReqIndex].text || "{}")
	} catch {
		existingData = {}
	}

	// This build only ships the OpenAI Compatible provider (OpenAI protocol).
	const costResult = calculateApiCostOpenAI(deps.streamModelInfo, tokens.input, tokens.output, tokens.cacheRead)

	clineMessages[deps.lastApiReqIndex].text = JSON.stringify({
		...existingData,
		tokensIn: costResult.totalInputTokens,
		tokensOut: costResult.totalOutputTokens,
		cacheWrites: tokens.cacheWrite,
		cacheReads: tokens.cacheRead,
		cost: tokens.total ?? costResult.totalCost,
		cancelReason,
		streamingFailedMessage,
	} satisfies ClineApiReqInfo)
}

/** ストリーム中断時のクリーンアップ（差分ビュー revert、partial の確定、cost 反映、fs 保存）。 */
export interface AbortStreamDeps {
	diffViewProvider: { readonly isEditing: boolean; revertChanges: () => Promise<unknown> }
	getClineMessages: () => ClineMessage[]
	updateApiReqMsg: (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => void
	saveClineMessages: () => Promise<unknown>
	setDidFinishAbortingStream: (v: boolean) => void
}

export async function abortStream(
	deps: AbortStreamDeps,
	cancelReason: ClineApiReqCancelReason,
	streamingFailedMessage?: string,
): Promise<void> {
	if (deps.diffViewProvider.isEditing) {
		await deps.diffViewProvider.revertChanges() // closes diff view
	}

	// if last message is a partial we need to update and save it
	const clineMessages = deps.getClineMessages()
	const lastMessage = clineMessages.at(-1)

	if (lastMessage && lastMessage.partial) {
		// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
		lastMessage.partial = false
		// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
	}

	// Update `api_req_started` to have cancelled and cost, so that
	// we can display the cost of the partial stream and the cancellation reason
	deps.updateApiReqMsg(cancelReason, streamingFailedMessage)
	await deps.saveClineMessages()

	// Signals to provider that it can retrieve the saved messages
	// from disk, as abortTask can not be awaited on in nature.
	deps.setDidFinishAbortingStream(true)
}
