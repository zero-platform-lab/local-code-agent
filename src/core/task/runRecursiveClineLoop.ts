import type { ContentBlockParam } from "@openai-agent/types"
import { checkMistakeLimit } from "./checkMistakeLimit"
import { prepareRequestCycle, type PrepareRequestCycleDeps, type PrepareRequestCycleHost } from "./prepareRequestCycle"
import { runOneRequest, type RunOneRequestDeps, type RunOneRequestHost } from "./runOneRequest"

/**
 * `Task.recursivelyMakeClineRequests` の while ループ全体。
 *
 * stack を pop しつつ以下 4 phase を回す:
 *  1. abort check → throw（Task 側でも `[Agent#recursivelyMakeAgentRequests] task aborted`
 *     を投げる同じフォーマット）
 *  2. checkMistakeLimit + counter リセット
 *  3. prepareRequestCycle（rate limit → api_req_started → mention 展開 → mode 切替 →
 *     env_details → user message 登録 + placeholder 更新）
 *  4. runOneRequest（tokens → reset streaming state → closures → attemptApiRequest →
 *     runOneApiIteration = streaming loop + finalize + branch）
 *
 * runOneRequest の返り値 action に応じて break / continue / stack push を判断する。
 * catch 節に落ちたら true を返す（`startTask` 側でタスク終了）。
 */
export interface StackItem {
	userContent: ContentBlockParam[]
	includeFileDetails: boolean
	retryAttempt?: number
	/** Track if user message was removed due to empty response */
	userMessageWasRemoved?: boolean
}

export type RunRecursiveClineLoopHost = PrepareRequestCycleHost &
	RunOneRequestHost & {
		abort: boolean
		taskId: string
		instanceId: string | number
		mistakeTracker: { count: number; limit: number }
	}

/**
 * `RunRecursiveClineLoopDeps` は prepare/runOne の deps を平坦化して受ける。
 * Task.ts wrapper の入れ子を減らし、内部で `{ host, ...deps }` として渡す。
 */
export type RunRecursiveClineLoopDeps = { host: RunRecursiveClineLoopHost } & Omit<PrepareRequestCycleDeps, "host"> &
	Omit<RunOneRequestDeps, "host">

export async function runRecursiveClineLoop(
	deps: RunRecursiveClineLoopDeps,
	initialUserContent: ContentBlockParam[],
	initialIncludeFileDetails: boolean,
): Promise<boolean> {
	const { host } = deps
	const stack: StackItem[] = [
		{ userContent: initialUserContent, includeFileDetails: initialIncludeFileDetails, retryAttempt: 0 },
	]

	while (stack.length > 0) {
		const currentItem = stack.pop()!
		const currentUserContent = currentItem.userContent
		const currentIncludeFileDetails = currentItem.includeFileDetails

		if (host.abort) {
			throw new Error(`[Agent#recursivelyMakeAgentRequests] task ${host.taskId}.${host.instanceId} aborted`)
		}

		const mistakeCheck = await checkMistakeLimit({
			host,
			ask: host.ask.bind(host),
			say: host.say.bind(host),
		})
		if (mistakeCheck.additionalContent.length > 0) {
			currentUserContent.push(...mistakeCheck.additionalContent)
		}
		if (mistakeCheck.fired) {
			host.mistakeTracker.count = 0
		}

		// This build only ships the OpenAI Compatible provider (OpenAI protocol).
		const apiProtocol = "openai" as const

		const { lastApiReqIndex } = await prepareRequestCycle(
			{ host, provider: deps.provider, stampLastGlobalApiRequestTime: deps.stampLastGlobalApiRequestTime },
			{
				currentUserContent,
				retryAttempt: currentItem.retryAttempt ?? 0,
				userMessageWasRemoved: !!currentItem.userMessageWasRemoved,
				isEmptyOriginalUserContent: currentUserContent.length === 0,
				includeFileDetails: currentIncludeFileDetails,
				apiProtocol,
			},
		)

		try {
			const iterationResult = await runOneRequest(
				{ host, presentAssistantMessage: deps.presentAssistantMessage },
				{ lastApiReqIndex, currentUserContent, currentRetryAttempt: currentItem.retryAttempt ?? 0 },
			)
			if (iterationResult.action === "break") break
			if (iterationResult.action === "abandoned") continue
			if (iterationResult.nextStackItem) stack.push(iterationResult.nextStackItem)
			continue
		} catch (_error) {
			// This should never happen since the only thing that can throw an
			// error is the attemptApiRequest, which is wrapped in a try catch
			// that sends an ask where if noButtonClicked, will clear current
			// task and destroy this instance. However to avoid unhandled
			// promise rejection, we will end this loop which will end execution
			// of this instance (see `startTask`).
			return true // Needs to be true so parent loop knows to end task.
		}
	}

	// If we exit the while loop normally (stack is empty), return false
	return false
}
