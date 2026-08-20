import type {
	ClineAsk,
	ClineMessage,
	ClineSay,
	ContextCondense,
	ContextTruncation,
	ToolProgressStatus,
} from "@openai-agent/types"

import type { ApiMessage } from "../task-persistence"
import type { ClineAskResponse } from "../../shared/WebviewMessage"

import { buildNativeToolsArrayWithRestrictions, type BuildToolsProvider } from "./build-tools"
import { getEnvironmentDetails, type EnvironmentDetailsHost } from "../environment/getEnvironmentDetails"
import {
	type ApiRequestOrchestratorDeps,
	type ApiRequestOrchestratorStateHost,
	type ApiRequestProviderState,
} from "./apiRequestOrchestrator"

/**
 * `Task.buildApiRequestDeps()` の中身を切り出したファクトリ。
 *
 * apiRequestOrchestrator の 3 メソッド（attemptApiRequest / condenseContext /
 * handleContextWindowExceededError）で使う fat deps を Task 側から組み立てる
 * ロジックを Task.ts の外側に集約する。
 *
 * host は Task 自身を渡す形（narrow host pattern）。deps の大部分は host の
 * method / field を直接引き回すだけなのでここに閉じ込め、残る callback は
 * provider ref 経由の 3 個と `Task.lastGlobalApiRequestTime` の static setter
 * のみとなる。
 */
export type BuildApiRequestDepsHost = ApiRequestOrchestratorStateHost &
	EnvironmentDetailsHost & {
		taskId: string

		overwriteApiConversationHistory: (messages: ApiMessage[]) => Promise<unknown>
		combineMessages: (messages: ClineMessage[]) => ClineMessage[]
		tokenUsageTracker: { getTokenUsage: () => { contextTokens?: number } }
		getFilesReadByAgentSafely: (source: string) => Promise<string[] | undefined>
		flushPendingToolResultsToHistory: () => Promise<boolean>
		getSystemPrompt: () => Promise<string>
		getCurrentProfileId: (state: ApiRequestProviderState | undefined) => string
		say: (
			type: ClineSay,
			text?: string,
			images?: string[],
			partial?: boolean,
			checkpoint?: Record<string, unknown>,
			progressStatus?: ToolProgressStatus,
			options?: { isNonInteractive?: boolean },
			contextCondense?: ContextCondense,
			contextTruncation?: ContextTruncation,
		) => Promise<unknown>
		ask: (
			type: ClineAsk,
			text?: string,
		) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
		processQueuedMessages: () => void
		maybeWaitForProviderRateLimit: (retryAttempt: number) => Promise<void>
		backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
	}

/**
 * `getProvider` は 3 用途（buildTools 用 provider 取得 / provider state 取得 /
 * webview post）を 1 callback にまとめたもの。全て providerRef.deref() を返せば済む。
 */
export type BuildApiRequestProvider = BuildToolsProvider & {
	getState(): Promise<ApiRequestProviderState | undefined>
	postMessageToWebview: (message: { type: string; text: string }) => Promise<unknown> | undefined
	/** 拡張の Output チャンネルへ 1 行ログ（ClineProvider.log）。段階表示に使う。 */
	log?: (message: string) => void
}

export interface BuildApiRequestDepsClosures {
	getProvider: () => BuildApiRequestProvider | undefined
	stampLastGlobalApiRequestTime: () => void
}

export function buildApiRequestDeps(
	host: BuildApiRequestDepsHost,
	closures: BuildApiRequestDepsClosures,
): ApiRequestOrchestratorDeps {
	return {
		host,
		overwriteApiConversationHistory: host.overwriteApiConversationHistory.bind(host),
		combineMessages: host.combineMessages.bind(host),
		getTokenUsage: () => host.tokenUsageTracker.getTokenUsage(),
		getCurrentProfileId: host.getCurrentProfileId.bind(host),
		getFilesReadByAgentSafely: host.getFilesReadByAgentSafely.bind(host),
		flushPendingToolResultsToHistory: host.flushPendingToolResultsToHistory.bind(host),
		getSystemPrompt: host.getSystemPrompt.bind(host),
		say: host.say.bind(host),
		ask: host.ask.bind(host),
		processQueuedMessages: host.processQueuedMessages.bind(host),
		maybeWaitForProviderRateLimit: host.maybeWaitForProviderRateLimit.bind(host),
		backoffAndAnnounce: host.backoffAndAnnounce.bind(host),
		stampLastGlobalApiRequestTime: closures.stampLastGlobalApiRequestTime,
		log: (message: string) => closures.getProvider()?.log?.(message),
		getProviderState: async () => closures.getProvider()?.getState(),
		buildTools: async (options) => {
			const provider = closures.getProvider()
			if (!provider) {
				// tools 無しで続行できるので空配列を返す（呼び出し側の元コードも
				// provider 不在時は allTools を空のまま扱っていた）。
				return { tools: [] }
			}
			return buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: host.cwd,
				mode: options.mode,
				customModes: options.customModes,
				experiments: options.experiments,
				apiConfiguration: options.apiConfiguration,
				disabledTools: options.disabledTools,
				modelInfo: options.modelInfo as never,
			})
		},
		getEnvironmentDetails: (includeFileDetails) => getEnvironmentDetails(host, includeFileDetails),
		postCondenseTaskContext: async (started) => {
			await closures.getProvider()?.postMessageToWebview({
				type: started ? "condenseTaskContextStarted" : "condenseTaskContextResponse",
				text: host.taskId,
			})
		},
	}
}
