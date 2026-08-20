import type { ProviderSettings, ClineMessage } from "@openai-agent/types"

import type { ApiStream } from "../../api/transform/stream"

import {
	drainStreamInBackgroundToFindAllUsage as runDrainStreamInBackgroundToFindAllUsage,
	type UsageAccumulatorState,
} from "./drainStreamInBackgroundToFindAllUsage"

/**
 * `recursivelyMakeClineRequests` の try ブロック中盤で組み立てていた
 * `drainStreamInBackgroundToFindAllUsage` closure を factory 化。
 *
 * onCapturedUsage 内での「tokens 反映 → updateApiReqMsg → saveClineMessages →
 * updateClineMessage」の順序は既存動作を維持する。tokens は参照渡しで module
 * 側から直接 in-place 更新する。
 */
export interface MakeDrainStreamHost {
	taskId: string
	apiConfiguration: ProviderSettings
	messageStore: { clineMessages: ClineMessage[] }
	saveClineMessages: () => Promise<unknown>
}

export interface MakeDrainStreamDeps {
	updateApiReqMsg: () => void
	updateClineMessage: (m: ClineMessage) => Promise<unknown>
}

export function makeDrainStreamInBackground(
	host: MakeDrainStreamHost,
	tokens: UsageAccumulatorState,
	deps: MakeDrainStreamDeps,
): (
	apiReqIndex: number,
	iterator: AsyncIterator<Awaited<ReturnType<ApiStream["next"]>>["value"]>,
	initialItem: IteratorResult<Awaited<ReturnType<ApiStream["next"]>>["value"]>,
	lastApiReqIndex: number,
) => Promise<void> {
	return (apiReqIndex, iterator, initialItem, lastApiReqIndex) =>
		runDrainStreamInBackgroundToFindAllUsage(
			{
				taskId: host.taskId,
				apiConfiguration: host.apiConfiguration,
				onCapturedUsage: async (usage, messageIndex) => {
					tokens.input = usage.input
					tokens.output = usage.output
					tokens.cacheWrite = usage.cacheWrite
					tokens.cacheRead = usage.cacheRead
					tokens.total = usage.total
					deps.updateApiReqMsg()
					await host.saveClineMessages()
					const apiReqMessage = host.messageStore.clineMessages[messageIndex]
					if (apiReqMessage) {
						await deps.updateClineMessage(apiReqMessage)
					}
				},
			},
			iterator,
			initialItem,
			apiReqIndex,
			lastApiReqIndex,
			{ ...tokens },
		)
}
