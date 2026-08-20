import { isUserTurn } from "../task-persistence/agentMessageUtils"
import type { ContentBlockParam, MessageParam } from "@openai-agent/types"
import type { ClineAsk } from "@openai-agent/types"

import { ClineAskResponse } from "../../shared/WebviewMessage"
import type { ApiMessage } from "../task-persistence"

/**
 * API が assistant message（text / tool_use）を1つも返さなかったときの後処理。
 *
 * recursivelyMakeClineRequests の while ループの中で発生する。空応答は次のいずれかの経路で
 * 回復させる:
 *   - autoApproval 有効 → バックオフ後にリトライを stack に積む
 *   - autoApproval 無効 → ユーザーに ask して yes ならリトライ、no なら "Failure" 相当の
 *     assistant メッセージを履歴に残して諦める（履歴を巻き戻したので user メッセージも戻す）
 *
 * 呼び出し側の while ループ制御には触れない。戻り値の `action` で "continue" / "break" を、
 * `retryStackItem` で「stack に push すべき項目」を通知する。
 */
export interface HandleEmptyAssistantResponseStateHost {
	taskId: string
	instanceId: string | number
	abort: boolean
	graceRetry: { noAssistantMessages: number }
	messageStore: { apiConversationHistory: ApiMessage[] }
}

export interface HandleEmptyAssistantResponseDeps {
	host: HandleEmptyAssistantResponseStateHost
	say: (type: "error" | "api_req_retried", text?: string) => Promise<unknown>
	ask: (type: ClineAsk, text?: string) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
	getProviderState: () => Promise<{ autoApprovalEnabled?: boolean } | undefined>
	addToApiConversationHistory: (message: MessageParam) => Promise<unknown>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
}

/** 呼び出し側の while ループへの指示。 */
export type EmptyResponseAction =
	| { action: "continue"; retryStackItem?: EmptyResponseRetryStackItem }
	| { action: "break" }

/** リトライ時に stack へ push する項目（Task 側の while ループが解釈する）。 */
export interface EmptyResponseRetryStackItem {
	userContent: ContentBlockParam[]
	includeFileDetails: false
	retryAttempt: number
	/** true のとき Task 側は「user メッセージが既に取り除かれている」ことを前提に再送する。 */
	userMessageWasRemoved?: true
}

export async function handleEmptyAssistantResponse(
	deps: HandleEmptyAssistantResponseDeps,
	currentUserContent: ContentBlockParam[],
	previousRetryAttempt: number,
): Promise<EmptyResponseAction> {
	const { host } = deps

	// Increment consecutive no-assistant-messages counter
	const noAssistantCount = ++host.graceRetry.noAssistantMessages

	// Only show error and count toward mistake limit after 2 consecutive failures
	// This provides a "grace retry" - first failure retries silently
	if (noAssistantCount >= 2) {
		await deps.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
	}

	// IMPORTANT: We already added the user message to
	// apiConversationHistory earlier. Since the assistant failed to respond,
	// we need to remove that message before retrying to avoid having two consecutive
	// user messages (which would cause tool_result validation errors).
	const state = await deps.getProviderState()
	const history = host.messageStore.apiConversationHistory
	if (history.length > 0) {
		// 直前の user ターンを丸ごと取り除く（item 列では本文と tool 結果に割れている）。
		while (history.length > 0 && isUserTurn(history[history.length - 1])) {
			history.pop()
		}
	}

	// Check if we should auto-retry or prompt the user
	if (state?.autoApprovalEnabled) {
		// Auto-retry with backoff - don't persist failure message when retrying
		await deps.backoffAndAnnounce(
			previousRetryAttempt,
			new Error(
				"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
			),
		)

		// Check if task was aborted during the backoff
		if (host.abort) {
			console.log(`[Task#${host.taskId}.${host.instanceId}] Task aborted during empty-assistant retry backoff`)
			return { action: "break" }
		}

		// Push the same content back onto the stack to retry, incrementing the retry attempt counter
		// Mark that user message was removed so it gets re-added on retry
		return {
			action: "continue",
			retryStackItem: {
				userContent: currentUserContent,
				includeFileDetails: false,
				retryAttempt: previousRetryAttempt + 1,
				userMessageWasRemoved: true,
			},
		}
	}

	// Prompt the user for retry decision
	const { response } = await deps.ask(
		"api_req_failed",
		"The model returned no assistant messages. This may indicate an issue with the API or the model's output.",
	)

	if (response === "yesButtonClicked") {
		await deps.say("api_req_retried")

		return {
			action: "continue",
			retryStackItem: {
				userContent: currentUserContent,
				includeFileDetails: false,
				retryAttempt: previousRetryAttempt + 1,
				// 上で user メッセージを pop したので、auto 経路と同様に再追加させる。
				// これが無いと retryAttempt>0 で persistUserMessageAndPlaceholder が
				// user を再登録せず、リトライ要求がユーザー発話を欠いたまま送られる。
				userMessageWasRemoved: true,
			},
		}
	}

	// User declined to retry.
	// Re-add the user message we removed above, then record a "failure" assistant message.
	await deps.addToApiConversationHistory({
		role: "user",
		content: currentUserContent,
	})

	await deps.say(
		"error",
		"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
	)

	await deps.addToApiConversationHistory({
		role: "assistant",
		content: [{ type: "text", text: "Failure: I did not provide a response." }],
	})

	return { action: "continue" }
}
