import { type ProviderSettings, getModelId } from "@openai-agent/types"

import type { ApiStream } from "../../api/transform/stream"

/**
 * ストリーム末尾を非同期に消化して usage チャンクを回収する処理。
 *
 * `attemptApiRequest` の generator が「first chunk 以降を全消費する」経路を持たない
 * ケースがあり、そこで usage 情報が拾い漏れる（コスト計算が 0 になる）ため、
 * fire-and-forget で残り chunk を消費して usage を集めるバックグラウンドタスクを回す。
 *
 * 元は Task の中核 while ループのクロージャだったが、外側 mutable 変数
 * （`inputTokens` などの `let`、および `updateApiReqMsg` クロージャ）への依存を
 * `onCapturedUsage` コールバック1本に集約することで切り出した。呼び出し側は
 * コールバック内で外側変数の更新と updateApiReqMsg 呼び出しを行う。
 *
 * 5秒タイムアウトで打ち切り（拾えたぶんだけ反映）。エラーで落ちた場合も
 * 既に累積したぶんは反映する。
 */
export interface UsageAccumulatorState {
	input: number
	output: number
	cacheWrite: number
	cacheRead: number
	total?: number
}

export interface DrainStreamDeps {
	taskId: string
	apiConfiguration: ProviderSettings
	/**
	 * 反映処理をまとめて呼ぶコールバック。呼び出し側で外側変数の更新と
	 * updateApiReqMsg / saveClineMessages / updateClineMessage を実行する。
	 * usage の全項目が 0 の場合は呼ばれない。
	 */
	onCapturedUsage: (usage: UsageAccumulatorState, messageIndex: number) => Promise<void>
}

const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds

export async function drainStreamInBackgroundToFindAllUsage(
	deps: DrainStreamDeps,
	iterator: AsyncIterator<Awaited<ReturnType<ApiStream["next"]>>["value"]>,
	initialItem: IteratorResult<Awaited<ReturnType<ApiStream["next"]>>["value"]>,
	apiReqIndex: number,
	lastApiReqIndex: number,
	currentTokens: UsageAccumulatorState,
): Promise<void> {
	const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
	const startTime = performance.now()
	const modelId = getModelId(deps.apiConfiguration)

	// Local variables to accumulate usage data without affecting the main flow
	let bgInputTokens = currentTokens.input
	let bgOutputTokens = currentTokens.output
	const bgCacheWriteTokens = currentTokens.cacheWrite
	let bgCacheReadTokens = currentTokens.cacheRead
	let bgTotalCost = currentTokens.total

	// スナップショットから内部の可変 item を作る（外側スコープには漏らさない）
	let item = initialItem

	const capture = async () => {
		if (bgInputTokens > 0 || bgOutputTokens > 0 || bgCacheWriteTokens > 0 || bgCacheReadTokens > 0) {
			await deps.onCapturedUsage(
				{
					input: bgInputTokens,
					output: bgOutputTokens,
					cacheWrite: bgCacheWriteTokens,
					cacheRead: bgCacheReadTokens,
					total: bgTotalCost,
				},
				lastApiReqIndex,
			)
		}
	}

	try {
		// Continue processing the original stream from where the main loop left off
		let usageFound = false
		let chunkCount = 0

		// Use the same iterator that the main loop was using
		while (!item.done) {
			// Check for timeout
			if (performance.now() - startTime > timeoutMs) {
				console.warn(
					`[Background Usage Collection] Timed out after ${timeoutMs}ms for model: ${modelId}, processed ${chunkCount} chunks`,
				)
				// Clean up the iterator before breaking
				if (iterator.return) {
					await iterator.return(undefined)
				}
				break
			}

			const chunk = item.value
			item = await iterator.next()
			chunkCount++

			if (chunk && chunk.type === "usage") {
				usageFound = true
				bgInputTokens += chunk.inputTokens
				bgOutputTokens += chunk.outputTokens
				bgCacheReadTokens += chunk.cacheReadTokens ?? 0
				bgTotalCost = chunk.totalCost
			}
		}

		if (usageFound || bgInputTokens > 0 || bgOutputTokens > 0 || bgCacheWriteTokens > 0 || bgCacheReadTokens > 0) {
			// We have usage data either from a usage chunk or accumulated tokens
			await capture()
		} else {
			console.warn(
				`[Background Usage Collection] Suspicious: request ${apiReqIndex} is complete, but no usage info was found. Model: ${modelId}`,
			)
		}
	} catch (error) {
		console.error("Error draining stream for usage data:", error)
		// Still try to capture whatever usage data we have collected so far
		await capture()
	}
}
