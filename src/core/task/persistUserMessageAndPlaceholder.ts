import type { ContentBlockParam, MessageParam } from "@openai-agent/types"
import type { ClineApiReqInfo, ClineMessage } from "@openai-agent/types"

import { findLastIndex } from "../../shared/array"

/**
 * `recursivelyMakeClineRequests` 準備フェーズの後半（env_details 追記 →
 * user message の会話履歴登録 → placeholder `api_req_started` の text 更新 →
 * 永続化 → webview へ通知）をまとめたモジュール。
 *
 * getEnvironmentDetails は Task 全体を要するため呼び出し側で先に fetch して
 * `environmentDetails` を渡す。それ以降は host + narrow callable + data だけに依存する。
 */
export interface PersistUserMessageAndPlaceholderStateHost {
	messageStore: { clineMessages: ClineMessage[] }
}

export interface PersistUserMessageAndPlaceholderInput {
	/** stripDuplicateEnvironmentDetails 済みの user content。 */
	contentWithoutEnvDetails: ContentBlockParam[]
	/** 今回リクエストのために fetch した最新の env_details 本文。 */
	environmentDetails: string
	/** 現在の stack item の retryAttempt（省略時 0）。 */
	retryAttempt: number
	/** 前段リトライで空応答扱いされ user message を消した履歴があるか。 */
	userMessageWasRemoved: boolean
	/** mistake_limit_check の追加を含めた mutation 後の currentUserContent が空か。 */
	isEmptyOriginalUserContent: boolean
	/** api_req_started に埋める api protocol（この build では常に "openai"）。 */
	apiProtocol: ClineApiReqInfo["apiProtocol"]
}

export interface PersistUserMessageAndPlaceholderDeps {
	host: PersistUserMessageAndPlaceholderStateHost
	addToApiConversationHistory: (message: MessageParam) => Promise<unknown>
	saveClineMessages: () => Promise<unknown>
	postStateToWebviewWithoutTaskHistory: () => Promise<unknown> | undefined
}

export interface PersistUserMessageAndPlaceholderResult {
	lastApiReqIndex: number
}

export async function persistUserMessageAndPlaceholder(
	deps: PersistUserMessageAndPlaceholderDeps,
	input: PersistUserMessageAndPlaceholderInput,
): Promise<PersistUserMessageAndPlaceholderResult> {
	const { host } = deps

	// Add environment details as its own text block, separate from tool results.
	const finalUserContent = [
		...input.contentWithoutEnvDetails,
		{ type: "text" as const, text: input.environmentDetails },
	]

	// Only add user message to conversation history if:
	// 1. This is the first attempt (retryAttempt === 0), AND
	// 2. The original userContent was not empty (empty signals delegation resume where
	//    the user message with tool_result and env details is already in history), OR
	// 3. The message was removed in a previous iteration (userMessageWasRemoved === true)
	// This prevents consecutive user messages while allowing re-add when needed.
	const shouldAddUserMessage =
		(input.retryAttempt === 0 && !input.isEmptyOriginalUserContent) || input.userMessageWasRemoved
	if (shouldAddUserMessage) {
		await deps.addToApiConversationHistory({ role: "user", content: finalUserContent })
	}

	// Since we sent off a placeholder api_req_started message to update the
	// webview while waiting to actually start the API request (to load
	// potential details for example), we need to update the text of that message.
	const lastApiReqIndex = findLastIndex(host.messageStore.clineMessages, (m) => m.say === "api_req_started")

	// placeholder が見つからない (-1) 場合は text 更新をスキップする。呼び出し側は必ず placeholder を
	// 先に積む契約だが、履歴が壊れた再開経路等で欠落すると clineMessages[-1] が undefined になり
	// `.text =` で TypeError になるため防御する。下流（apiReqMessageUpdater）は index < 0 を許容する。
	if (lastApiReqIndex >= 0) {
		host.messageStore.clineMessages[lastApiReqIndex].text = JSON.stringify({
			apiProtocol: input.apiProtocol,
		} satisfies ClineApiReqInfo)
	}

	await deps.saveClineMessages()
	await deps.postStateToWebviewWithoutTaskHistory()

	return { lastApiReqIndex }
}
