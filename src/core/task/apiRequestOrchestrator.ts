import { itemText } from "../task-persistence/agentMessageUtils"
import OpenAI from "openai"
import { serializeError } from "serialize-error"

import {
	type ClineAsk,
	type ClineMessage,
	type ClineSay,
	type ContextCondense,
	type ContextTruncation,
	type ExtensionState,
	type ProviderSettings,
	type ToolProgressStatus,
} from "@openai-agent/types"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { ApiStream } from "../../api/transform/stream"
import { getModelMaxOutputTokens } from "../../shared/api"
import { ClineAskResponse } from "../../shared/WebviewMessage"

import { summarizeConversation } from "../condense"
import { manageContext, willManageContext } from "../context-management"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import { AutoApprovalHandler } from "../auto-approval"
import { AgentIgnoreController } from "../ignore/AgentIgnoreController"
import { type ApiMessage } from "../task-persistence"

import { buildRequestHistory } from "./buildRequestHistory"

/**
 * 「API リクエストサイクル」を担う3メソッド（attemptApiRequest / condenseContext /
 * handleContextWindowExceededError）を Task から切り出したもの。
 *
 * 3つとも「provider の設定を読み → コンテキスト管理（要約 / 切り詰め）を挟み →
 * ツール定義付きで API を呼び → 結果を webview に流す」という同一の骨格を持ち、
 * 共通の deps interface で表現できる。
 *
 * getEnvironmentDetails / buildNativeToolsArrayWithRestrictions は fat な受け口
 * （それぞれ 10メンバの host / 8フィールドの options）を要求するため、この
 * モジュールからは**直接呼ばず** deps 経由の関数で受ける。これで
 * `EnvironmentDetailsHost` / `BuildToolsProvider` の型伝播を避け、Task 側の
 * `this` に閉じ込められる。
 */

export const FORCED_CONTEXT_REDUCTION_PERCENT = 75
export const MAX_CONTEXT_WINDOW_RETRIES = 3

/**
 * ClineProvider.getState() の戻り値型。既に他の抽出で確立された
 * EnvironmentDetailsProviderState と同じ形（ExtensionState の一部を除外）。
 */
export type ApiRequestProviderState = Omit<
	ExtensionState,
	"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version"
>

/**
 * ツール定義の構築を Task 側に任せるための関数型。
 *
 * 実装は `buildNativeToolsArrayWithRestrictions({provider, cwd, mode, ...})` を呼ぶが、
 * `provider` の narrow 型（BuildToolsProvider）をこのモジュールに露出させないため、
 * options だけを受けて Task 側で provider を注入する形にしている。
 */
export type BuildToolsFn = (options: {
	mode?: string
	experiments?: Record<string, boolean>
	apiConfiguration?: ProviderSettings
	disabledTools?: string[]
	modelInfo: unknown
}) => Promise<{ tools: OpenAI.Chat.ChatCompletionTool[] }>

export interface ApiRequestOrchestratorStateHost {
	// 識別子・設定
	taskId: string
	instanceId: string | number
	cwd: string
	api: ApiHandler
	apiConfiguration: ProviderSettings
	rooIgnoreController?: AgentIgnoreController

	// 会話履歴（Task 側で TaskMessageStore へ getter/setter プロキシされる public field）
	messageStore: { apiConversationHistory: ApiMessage[]; clineMessages: ClineMessage[] }

	// abort / streaming state（Task の可変フィールドを直接読み書き）
	abort: boolean

	/** streaming 系フィールドは StreamingSession collaborator にまとまっている。 */
	stream: {
		currentRequestAbortController?: AbortController
		isWaitingForFirstChunk: boolean
	}

	// auto-approval
	autoApprovalHandler: AutoApprovalHandler
}

export interface ApiRequestOrchestratorDeps {
	host: ApiRequestOrchestratorStateHost

	// 会話履歴の書き換え（TaskMessageStore へ委譲する async 操作）
	overwriteApiConversationHistory: (messages: ApiMessage[]) => Promise<unknown>
	combineMessages: (messages: ClineMessage[]) => ClineMessage[]

	// トークン集計 / プロファイル
	getTokenUsage: () => { contextTokens?: number }
	getCurrentProfileId: (state: ApiRequestProviderState | undefined) => string
	getFilesReadByAgentSafely: (source: string) => Promise<string[] | undefined>
	flushPendingToolResultsToHistory: () => Promise<boolean>

	/** 拡張の Output チャンネルへ 1 行ログ（段階表示用）。未配線でも安全なよう optional。 */
	log?: (message: string) => void

	// provider 経由の副作用
	getProviderState: () => Promise<ApiRequestProviderState | undefined>
	getSystemPrompt: () => Promise<string>
	buildTools: BuildToolsFn
	/** getEnvironmentDetails(this, includeFileDetails) を Task 側で呼ぶための関数。 */
	getEnvironmentDetails: (includeFileDetails: boolean) => Promise<string>
	/** context 管理のスピナー表示を webview に伝える（開始 / 終了）。 */
	postCondenseTaskContext: (started: boolean) => Promise<void>

	// UI
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
	ask: (type: ClineAsk, text?: string) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
	processQueuedMessages: () => void

	// レート制限・バックオフ（既存 ApiRequestTimingController への委譲）
	maybeWaitForProviderRateLimit: (retryAttempt: number) => Promise<void>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>

	/** performance.now() を Task の static フィールドに書き戻すためのフック。 */
	stampLastGlobalApiRequestTime: () => void
}

/**
 * ツール定義を組み立てて condense 用 metadata を返す共通ヘルパー。
 * condenseContext / handleContextWindowExceededError / attemptApiRequest の
 * 3箇所で同じ構造を組み立てるため関数化している。
 */
async function buildCondenseMetadata(
	deps: ApiRequestOrchestratorDeps,
	state: ApiRequestProviderState | undefined,
	modelInfo: unknown,
): Promise<ApiHandlerCreateMessageMetadata> {
	const toolsResult = await deps.buildTools({
		mode: state?.mode,
		experiments: state?.experiments,
		apiConfiguration: state?.apiConfiguration,
		disabledTools: state?.disabledTools,
		modelInfo,
	})
	const tools = toolsResult.tools

	return {
		taskId: deps.host.taskId,
		...(tools.length > 0
			? {
					tools,
					tool_choice: "auto",
					parallelToolCalls: true,
				}
			: {}),
	}
}

/**
 * ユーザー起点の context 圧縮。
 *
 * 現在の会話履歴を要約して置き換え、要約結果を UI に反映する。エラー時は
 * `condense_context_error` を投げるだけで元履歴は保持する（要約は失敗しても
 * タスクは続行できる）。
 */
export async function condenseContext(deps: ApiRequestOrchestratorDeps): Promise<void> {
	// CRITICAL: Flush any pending tool results before condensing
	// to ensure tool_use/tool_result pairs are complete in history
	await deps.flushPendingToolResultsToHistory()

	const systemPrompt = await deps.getSystemPrompt()

	// Get condensing configuration
	const state = await deps.getProviderState()
	const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

	const { contextTokens: prevContextTokens } = deps.getTokenUsage()

	const api = deps.host.api
	const modelInfo = api.getModel().info

	// Build tools for condensing metadata (same tools used for normal API calls)
	const metadata = await buildCondenseMetadata(deps, state, modelInfo)

	// Generate environment details to include in the condensed summary
	const environmentDetails = await deps.getEnvironmentDetails(true)

	const filesReadByAgent = await deps.getFilesReadByAgentSafely("condenseContext")

	const {
		messages,
		summary,
		cost,
		newContextTokens = 0,
		error,
		condenseId,
	} = await summarizeConversation({
		messages: deps.host.messageStore.apiConversationHistory,
		apiHandler: api,
		systemPrompt,
		taskId: deps.host.taskId,
		isAutomaticTrigger: false,
		customCondensingPrompt,
		metadata,
		environmentDetails,
		filesReadByAgent,
		cwd: deps.host.cwd,
		rooIgnoreController: deps.host.rooIgnoreController,
	})
	if (error) {
		await deps.say(
			"condense_context_error",
			error,
			undefined /* images */,
			false /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
		)
		return
	}
	await deps.overwriteApiConversationHistory(messages)

	const contextCondense: ContextCondense = {
		summary,
		cost,
		newContextTokens,
		prevContextTokens: prevContextTokens ?? 0,
		condenseId: condenseId!,
	}
	await deps.say(
		"condense_context",
		undefined /* text */,
		undefined /* images */,
		false /* partial */,
		undefined /* checkpoint */,
		undefined /* progressStatus */,
		{ isNonInteractive: true } /* options */,
		contextCondense,
	)

	// Process any queued messages after condensing completes
	deps.processQueuedMessages()
}

/**
 * API がコンテキストウィンドウ超過を返したときの緊急切り詰め。
 *
 * attemptApiRequest の catch で呼ばれる。強制的に `FORCED_CONTEXT_REDUCTION_PERCENT`
 * まで履歴を絞り、成功したら攻撃的な要約 or スライディングウィンドウ切り詰めのどちらが
 * 効いたかを UI に反映する。finally でスピナー解除を必ず送る（送らないと webview 側が
 * 待ちっぱなしになる）。
 */
export async function handleContextWindowExceededError(deps: ApiRequestOrchestratorDeps): Promise<void> {
	const state = await deps.getProviderState()
	const { profileThresholds = {} } = state ?? {}

	const { contextTokens } = deps.getTokenUsage()
	const api = deps.host.api
	const modelInfo = api.getModel().info

	const maxTokens = getModelMaxOutputTokens({
		modelId: api.getModel().id,
		model: modelInfo,
		settings: deps.host.apiConfiguration,
	})

	const contextWindow = modelInfo.contextWindow

	// Get the current profile ID using the helper method
	const currentProfileId = deps.getCurrentProfileId(state)

	// Log the context window error for debugging
	console.warn(
		`[Task#${deps.host.taskId}] Context window exceeded for model ${api.getModel().id}. ` +
			`Current tokens: ${contextTokens}, Context window: ${contextWindow}. ` +
			`Forcing truncation to ${FORCED_CONTEXT_REDUCTION_PERCENT}% of current context.`,
	)
	// Send condenseTaskContextStarted to show in-progress indicator
	await deps.postCondenseTaskContext(true)

	// Build tools for condensing metadata (same tools used for normal API calls)
	const metadata = await buildCondenseMetadata(deps, state, modelInfo)

	try {
		// Generate environment details to include in the condensed summary
		const environmentDetails = await deps.getEnvironmentDetails(true)

		// Force aggressive truncation by keeping only 75% of the conversation history
		const truncateResult = await manageContext({
			messages: deps.host.messageStore.apiConversationHistory,
			totalTokens: contextTokens || 0,
			maxTokens,
			contextWindow,
			apiHandler: api,
			autoCondenseContext: true,
			autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT,
			systemPrompt: await deps.getSystemPrompt(),
			taskId: deps.host.taskId,
			profileThresholds,
			currentProfileId,
			metadata,
			environmentDetails,
		})

		if (truncateResult.messages !== deps.host.messageStore.apiConversationHistory) {
			await deps.overwriteApiConversationHistory(truncateResult.messages)
		}

		if (truncateResult.summary) {
			const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
			const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
			await deps.say(
				"condense_context",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				contextCondense,
			)
		} else if (truncateResult.truncationId) {
			// Sliding window truncation occurred (fallback when condensing fails or is disabled)
			const contextTruncation: ContextTruncation = {
				truncationId: truncateResult.truncationId,
				messagesRemoved: truncateResult.messagesRemoved ?? 0,
				prevContextTokens: truncateResult.prevContextTokens,
				newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
			}
			await deps.say(
				"sliding_window_truncation",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				undefined /* contextCondense */,
				contextTruncation,
			)
		}
	} finally {
		// Notify webview that context management is complete (removes in-progress spinner)
		// IMPORTANT: Must always be sent to dismiss the spinner, even on error
		await deps.postCondenseTaskContext(false)
	}
}

/**
 * 1回の API リクエストを試行する generator。first-chunk エラー時のみリトライ判定を行い、
 * mid-stream エラーは呼び出し元に任せる（tool 実行の途中状態を絡めた復旧が必要になるため）。
 *
 * リトライは2種類:
 * - context-window 超過 → handleContextWindowExceededError で切り詰めてから再帰
 * - それ以外 → autoApproval 有効なら backoffAndAnnounce で待って再帰、無効ならユーザーに ask
 */
/**
 * API リクエスト直前の in-request コンテキスト管理（要約 / 切り詰め）。
 *
 * threshold を跨ぐ見込みなら in-progress インジケータを出し、manageContext で
 * 要約 / 切り詰めを行い、結果（condense_context / sliding_window_truncation / error）を
 * webview に流す。finally で必ず in-progress を畳む。attemptApiRequest generator から
 * 切り出したが yield を含まないため挙動は変わらない。単体で orchestration を検証できる。
 */
export async function applyInRequestContextManagement(
	deps: ApiRequestOrchestratorDeps,
	state: ApiRequestProviderState | undefined,
	api: ApiHandler,
	contextTokens: number,
	systemPrompt: string,
): Promise<void> {
	const { autoCondenseContext = true, autoCondenseContextPercent = 100, profileThresholds = {} } = state ?? {}
	const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

	const modelInfo = api.getModel().info

	const maxTokens = getModelMaxOutputTokens({
		modelId: api.getModel().id,
		model: modelInfo,
		settings: deps.host.apiConfiguration,
	})

	const contextWindow = modelInfo.contextWindow

	// Get the current profile ID using the helper method
	const currentProfileId = deps.getCurrentProfileId(state)
	// Check if context management will likely run (threshold check)
	// This allows us to show an in-progress indicator to the user
	// We use the centralized willManageContext helper to avoid duplicating threshold logic
	const history = deps.host.messageStore.apiConversationHistory
	const lastMessageText = itemText(history[history.length - 1])
	let lastMessageTokens = 0
	if (lastMessageText) {
		lastMessageTokens = await api.countTokens([{ type: "text", text: lastMessageText }])
	}

	const contextManagementWillRun = willManageContext({
		totalTokens: contextTokens,
		contextWindow,
		maxTokens,
		autoCondenseContext,
		autoCondenseContextPercent,
		profileThresholds,
		currentProfileId,
		lastMessageTokens,
	})

	// Send condenseTaskContextStarted BEFORE manageContext to show in-progress indicator
	// This notification must be sent here (not earlier) because the early check uses stale token count
	// (before user message is added to history), which could incorrectly skip showing the indicator
	if (contextManagementWillRun && autoCondenseContext) {
		await deps.postCondenseTaskContext(true)
	}

	// Build tools for condensing metadata (same tools used for normal API calls)
	// This ensures the condensing API call includes tool definitions for providers that need them
	const contextMgmtMetadata = await buildCondenseMetadata(deps, state, modelInfo)

	// Only generate environment details when context management will actually run.
	// getEnvironmentDetails(this, true) triggers a recursive workspace listing which
	// adds overhead - avoid this for the common case where context is below threshold.
	const contextMgmtEnvironmentDetails = contextManagementWillRun ? await deps.getEnvironmentDetails(true) : undefined

	// Get files read by Agent for code folding - only when context management will run
	const contextMgmtFilesReadByAgent =
		contextManagementWillRun && autoCondenseContext
			? await deps.getFilesReadByAgentSafely("attemptApiRequest")
			: undefined

	try {
		const truncateResult = await manageContext({
			messages: deps.host.messageStore.apiConversationHistory,
			totalTokens: contextTokens,
			maxTokens,
			contextWindow,
			apiHandler: api,
			autoCondenseContext,
			autoCondenseContextPercent,
			systemPrompt,
			taskId: deps.host.taskId,
			customCondensingPrompt,
			profileThresholds,
			currentProfileId,
			metadata: contextMgmtMetadata,
			environmentDetails: contextMgmtEnvironmentDetails,
			filesReadByAgent: contextMgmtFilesReadByAgent,
			cwd: deps.host.cwd,
			rooIgnoreController: deps.host.rooIgnoreController,
		})
		if (truncateResult.messages !== deps.host.messageStore.apiConversationHistory) {
			await deps.overwriteApiConversationHistory(truncateResult.messages)
		}
		if (truncateResult.error) {
			await deps.say("condense_context_error", truncateResult.error)
		}
		if (truncateResult.summary) {
			const { summary, cost, prevContextTokens, newContextTokens = 0, condenseId } = truncateResult
			const contextCondense: ContextCondense = {
				summary,
				cost,
				newContextTokens,
				prevContextTokens,
				condenseId,
			}
			await deps.say(
				"condense_context",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				contextCondense,
			)
		} else if (truncateResult.truncationId) {
			// Sliding window truncation occurred (fallback when condensing fails or is disabled)
			const contextTruncation: ContextTruncation = {
				truncationId: truncateResult.truncationId,
				messagesRemoved: truncateResult.messagesRemoved ?? 0,
				prevContextTokens: truncateResult.prevContextTokens,
				newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
			}
			await deps.say(
				"sliding_window_truncation",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				undefined /* contextCondense */,
				contextTruncation,
			)
		}
	} finally {
		// Notify webview that context management is complete (sets isCondensing = false)
		// This removes the in-progress spinner and allows the completed result to show
		// IMPORTANT: Must always be sent to dismiss the spinner, even on error
		if (contextManagementWillRun && autoCondenseContext) {
			await deps.postCondenseTaskContext(false)
		}
	}
}

/**
 * 最初のチャンク取得で失敗したときのリトライ判断と副作用。
 *
 * attemptApiRequest generator の catch から、yield / 自己再帰を除いた「エラー分類 →
 * リトライ準備」を切り出したもの。戻り値の nextRetryAttempt を使って generator が
 * `yield* attemptApiRequest(deps, nextRetryAttempt)` を行う。リトライせず終了する場合
 * （バックオフ中の中断・ユーザー拒否）は例外を投げ、generator の外へ伝播する。
 *
 * - コンテキスト超過かつ上限未満: 切り詰めてから retryAttempt + 1 で再試行
 * - 自動承認あり: バックオフ後 retryAttempt + 1 で再試行（中断されていたら throw）
 * - それ以外: api_req_failed をユーザーに確認。承認なら retryAttempt を 0 に戻して
 *   再試行、拒否なら throw
 */
export async function handleFirstChunkError(
	deps: ApiRequestOrchestratorDeps,
	error: unknown,
	retryAttempt: number,
	autoApprovalEnabled: boolean | undefined,
): Promise<{ nextRetryAttempt: number }> {
	deps.host.stream.isWaitingForFirstChunk = false
	deps.host.stream.currentRequestAbortController = undefined

	// ウォッチドッグのタイムアウトは、無限リトライで握り潰さず終端エラーとして表面化する。
	// 即時再送してもまた無応答になりやすく（endpoint が応答しない等）、auto-approval 経路だと
	// 上限なしでリトライし続けて「無音のまま永遠にスピナー」になっていた。エラー本文には
	// `[sent]` が付いているので、ユーザーが送信内容とタイムアウトを確認できる。
	const isRequestTimeout = /timed out after \d+ms/.test((error as { message?: string })?.message ?? "")
	if (isRequestTimeout) {
		deps.log?.(`[API] タイムアウトのため中断（リトライしない）: ${(error as { message?: string })?.message ?? ""}`)
		throw error
	}

	const isContextWindowExceededError = checkContextWindowExceededError(error)

	// If it's a context window error and we haven't exceeded max retries for this error type
	if (isContextWindowExceededError && retryAttempt < MAX_CONTEXT_WINDOW_RETRIES) {
		console.warn(
			`[Task#${deps.host.taskId}] Context window exceeded for model ${deps.host.api.getModel().id}. ` +
				`Retry attempt ${retryAttempt + 1}/${MAX_CONTEXT_WINDOW_RETRIES}. ` +
				`Attempting automatic truncation...`,
		)
		await handleContextWindowExceededError(deps)
		return { nextRetryAttempt: retryAttempt + 1 }
	}

	// HTTP 4xx（クライアントエラー）は「送ったリクエスト自体が拒否された」ので、無限リトライ
	// しても同じ 400 が返り続けるだけ。**終端エラーとして表面化する**（`[sent]` 付き）。
	// これをしないと、サーバが一瞬で返す 400 が auto-approval の上限なしリトライで「無音のまま
	// 永遠にスピナー」に化ける（実際、Azure GPT-5.x の reasoning_effort+tools=400 がこれで
	// ハングに見えていた）。例外: 429（レート制限）は時間で回復するのでリトライ対象に残す。
	// context-window 超過（4xx のことがある）は上の専用処理に任せるため除外済み。
	const httpStatus = (error as { status?: number })?.status
	if (
		typeof httpStatus === "number" &&
		httpStatus >= 400 &&
		httpStatus < 500 &&
		httpStatus !== 429 &&
		!isContextWindowExceededError
	) {
		deps.log?.(
			`[API] クライアントエラー HTTP ${httpStatus} のため中断（リトライしない）: ${(error as { message?: string })?.message ?? ""}`,
		)
		throw error
	}

	// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.
	if (autoApprovalEnabled) {
		// Apply shared exponential backoff and countdown UX
		await deps.backoffAndAnnounce(retryAttempt, error)

		// CRITICAL: Check if task was aborted during the backoff countdown
		// This prevents infinite loops when users cancel during auto-retry
		// Without this check, the recursive call below would continue even after abort
		if (deps.host.abort) {
			throw new Error(
				`[Task#attemptApiRequest] task ${deps.host.taskId}.${deps.host.instanceId} aborted during retry`,
			)
		}

		// Retry with an incremented retry count.
		return { nextRetryAttempt: retryAttempt + 1 }
	}

	const err = error as { message?: string }
	const { response } = await deps.ask("api_req_failed", err.message ?? JSON.stringify(serializeError(err), null, 2))

	if (response !== "yesButtonClicked") {
		// This will never happen since if noButtonClicked, we will
		// clear current task, aborting this instance.
		throw new Error("API request failed")
	}

	await deps.say("api_req_retried")
	// Fresh retry: reset the retry counter (matches the original attemptApiRequest(deps) call).
	return { nextRetryAttempt: 0 }
}

export async function* attemptApiRequest(
	deps: ApiRequestOrchestratorDeps,
	retryAttempt: number = 0,
	options: { skipProviderRateLimit?: boolean } = {},
): ApiStream {
	// 段階表示の起点。この行が Output に出なければ、ハングは attemptApiRequest より前
	// （リクエスト準備＝環境情報のワークスペース走査など）にある、と切り分けられる。
	deps.log?.(`[API] リクエスト準備開始 (retry=${retryAttempt})`)
	const state = await deps.getProviderState()

	const { apiConfiguration, autoApprovalEnabled, mode } = state ?? {}

	if (!options.skipProviderRateLimit) {
		deps.log?.("[API] レート制限待ちを確認中…")
		await deps.maybeWaitForProviderRateLimit(retryAttempt)
	}

	// Update last request time right before making the request so that subsequent
	// requests — even from new subtasks — will honour the provider's rate-limit.
	//
	// NOTE: When recursivelyMakeClineRequests handles rate limiting, it sets the
	// timestamp earlier to include the environment details build. We still set it
	// here for direct callers (tests) and for the case where we didn't rate-limit
	// in the caller.
	deps.stampLastGlobalApiRequestTime()

	// 段階表示: どのステップで止まっているかを Output に出す。API 呼び出しの「外」で
	// ハングしても（環境情報の走査など）、最後に出たログで場所が分かる。
	deps.log?.("[API] system prompt を構築中…")
	const systemPrompt = await deps.getSystemPrompt()
	const { contextTokens } = deps.getTokenUsage()
	const api = deps.host.api

	if (contextTokens) {
		deps.log?.("[API] コンテキスト管理（必要なら切り詰め）を実行中…")
		await applyInRequestContextManagement(deps, state, api, contextTokens, systemPrompt)
	}

	// 保存済み履歴 → 送信する item 列。段の順序に意味があるので関数に寄せてある。
	const cleanConversationHistory = buildRequestHistory(deps.host.messageStore.apiConversationHistory, api)

	// Check auto-approval limits
	const approvalResult = await deps.host.autoApprovalHandler.checkAutoApprovalLimits(
		state,
		deps.combineMessages(deps.host.messageStore.clineMessages.slice(1)),
		async (type: ClineAsk, data?: string) => deps.ask(type, data),
	)

	if (!approvalResult.shouldProceed) {
		// User did not approve, task should be aborted
		throw new Error("Auto-approval limit reached and user did not approve continuation")
	}

	// Whether we include tools is determined by whether we have any tools to send.
	const modelInfo = api.getModel().info

	// ネイティブツール + 動的な MCP ツールを、現在のモードでフィルタして組み立てる。
	// MCP サーバへの問い合わせを含むことがあり、ここで止まる可能性がある。
	deps.log?.("[API] tools を構築中（MCP 含む）…")
	const toolsResult = await deps.buildTools({
		mode,
		experiments: state?.experiments,
		apiConfiguration,
		disabledTools: state?.disabledTools,
		modelInfo,
	})
	const allTools = toolsResult.tools

	const shouldIncludeTools = allTools.length > 0

	const metadata: ApiHandlerCreateMessageMetadata = {
		taskId: deps.host.taskId,
		// Include tools whenever they are present.
		...(shouldIncludeTools
			? {
					tools: allTools,
					tool_choice: "auto",
					parallelToolCalls: true,
				}
			: {}),
	}

	// Create an AbortController to allow cancelling the request mid-stream
	const abortController = new AbortController()
	deps.host.stream.currentRequestAbortController = abortController
	const abortSignal = abortController.signal

	// The provider accepts reasoning items alongside standard messages; cast to the expected parameter type.
	deps.log?.(
		`[API] リクエスト送信 (model=${api.getModel().id}, tools=${allTools.length}, stream=${apiConfiguration?.openAiStreamingEnabled ?? true})`,
	)
	const stream = api.createMessage(systemPrompt, cleanConversationHistory, metadata)
	const iterator = stream[Symbol.asyncIterator]()

	// Set up abort handling - when the signal is aborted, clean up the controller reference
	abortSignal.addEventListener("abort", () => {
		console.log(`[Task#${deps.host.taskId}.${deps.host.instanceId}] AbortSignal triggered for current request`)
		deps.host.stream.currentRequestAbortController = undefined
	})

	try {
		// Awaiting first chunk to see if it will throw an error.
		deps.host.stream.isWaitingForFirstChunk = true
		deps.log?.("[API] 応答待ち（最初のチャンク）…")

		// Race between the first chunk and the abort signal
		const firstChunkPromise = iterator.next()
		const abortPromise = new Promise<never>((_, reject) => {
			if (abortSignal.aborted) {
				reject(new Error("Request cancelled by user"))
			} else {
				abortSignal.addEventListener("abort", () => {
					reject(new Error("Request cancelled by user"))
				})
			}
		})

		const firstChunk = await Promise.race([firstChunkPromise, abortPromise])
		deps.log?.("[API] 受信開始（最初のチャンク受領）")
		yield firstChunk.value
		deps.host.stream.isWaitingForFirstChunk = false
	} catch (error) {
		// エラー分類とリトライ準備（切り詰め / バックオフ / ユーザー確認）は
		// handleFirstChunkError に委ね、generator 側は yield* の自己再帰だけを持つ。
		// リトライせず終了する場合（中断・拒否）は同関数が throw して外へ伝播する。
		const { nextRetryAttempt } = await handleFirstChunkError(deps, error, retryAttempt, autoApprovalEnabled)
		yield* attemptApiRequest(deps, nextRetryAttempt)
		return
	}

	// No error, so we can continue to yield all remaining chunks.
	// (Needs to be placed outside of try/catch since it we want caller to
	// handle errors not with api_req_failed as that is reserved for first
	// chunk failures only.)
	// This delegates to another generator or iterable object. In this case,
	// it's saying "yield all remaining values from this iterator". This
	// effectively passes along all subsequent chunks from the original
	// stream.
	yield* iterator
}
