import type { AgentMessage, MessageParam } from "@openai-agent/types"
import { ApiHandler } from "../../api"
import { getEffectiveApiHistory } from "../condense"
import { type ApiMessage } from "../task-persistence"
import { messageToAgentItems } from "../task-persistence/migrateLegacyApiMessages"
import { validateAndFixToolResultIds } from "./validateToolResultIds"

/**
 * API 会話履歴への追記に必要な操作。
 *
 * Task を state host として渡し、`saveApiConversationHistory` は host 経由で呼ぶ。
 */
export interface AddToApiConversationHistoryStateHost {
	/** 現在の ApiHandler。プロバイダ固有の reasoning 取得に使う。 */
	api: ApiHandler
	/** 追記先の履歴配列。push でその場を変更する。 */
	messageStore: { apiConversationHistory: ApiMessage[] }
	saveApiConversationHistory: () => Promise<unknown>
}

export interface AddToApiConversationHistoryDeps {
	host: AddToApiConversationHistoryStateHost
}

/**
 * API 会話履歴にメッセージを1件追記する。
 *
 * 呼び出し側は「1 ターン = 1 メッセージ」の形（`{role, content}`）で渡すが、履歴に
 * 積まれるのは `AgentMessage`（Responses API の item 列）。本文・tool_use・tool_result は
 * ここで独立 item に割られる。送信時の変換はもう無い。
 *
 * assistant では、この応答で得た reasoning を独立 item として本文より前に置く。
 * user では tool_result の ID を直前の assistant と突き合わせて検証・補正する。
 */
export async function addToApiConversationHistory(
	deps: AddToApiConversationHistoryDeps,
	message: MessageParam,
	reasoning?: string,
): Promise<void> {
	// Responses API 経由で得た reasoning items (encrypted_content) を、この応答の分だけ拾う。
	const handler = deps.host.api as ApiHandler & {
		getEncryptedContent?: () => { encrypted_content: string; id?: string } | undefined
	}

	const ts = Date.now()
	const history = deps.host.messageStore.apiConversationHistory

	if (message.role === "assistant") {
		const reasoningData = handler.getEncryptedContent?.()
		const items: AgentMessage[] = []

		// 暗号化 reasoning は独立 item として本文より前に置く（Responses が要求する順序）。
		// 平文 reasoning は Responses item にできないので本文の先頭に畳む。
		if (reasoningData?.encrypted_content) {
			items.push({
				type: "reasoning",
				summary: [],
				encrypted_content: reasoningData.encrypted_content,
				...(reasoningData.id ? { id: reasoningData.id } : {}),
				ts,
			})
		}

		const content = reasoning ? prependReasoningText(message.content, reasoning) : message.content
		items.push(...messageToAgentItems("assistant", content, { ts }))

		history.push(...items)
	} else {
		// For user messages, validate tool_result IDs ONLY when the immediately previous *effective* message
		// is an assistant message.
		//
		// If the previous effective message is also a user message (e.g., summary + a new user message),
		// validating against any earlier assistant message can incorrectly inject placeholder tool_results.
		const effectiveHistoryForValidation = getEffectiveApiHistory(history)
		const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
		const prevIsAssistantTurn = isAssistantTurn(lastEffective)
		const historyForValidation = prevIsAssistantTurn ? effectiveHistoryForValidation : []

		// If the previous effective message is NOT an assistant, convert tool_result blocks to text blocks.
		// This prevents orphaned tool_results from being filtered out by getEffectiveApiHistory.
		// This can happen when condensing occurs after the assistant sends tool_uses but before
		// the user responds - the tool_use blocks get condensed away, leaving orphaned tool_results.
		let messageToAdd = message
		if (!prevIsAssistantTurn && Array.isArray(message.content)) {
			messageToAdd = {
				...message,
				content: message.content.map((block) =>
					block.type === "tool_result"
						? {
								type: "text" as const,
								text: `Tool result:\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`,
							}
						: block,
				),
			}
		}

		const validatedMessage = validateAndFixToolResultIds(messageToAdd, historyForValidation)
		history.push(...messageToAgentItems("user", validatedMessage.content, { ts }))
	}

	await deps.host.saveApiConversationHistory()
}

/**
 * 直前の effective item が assistant のターンだったか。
 *
 * item 列では 1 ターンが複数 item に割れるので、末尾が `function_call`（tool 呼び出し）でも
 * assistant のターンとみなす。
 */
function isAssistantTurn(item: AgentMessage | undefined): boolean {
	if (!item) return false
	if (item.type === "function_call") return true
	return item.type === "message" && item.role === "assistant"
}

/** 平文 reasoning を本文の先頭にテキストとして畳む。 */
function prependReasoningText(content: MessageParam["content"], reasoning: string): MessageParam["content"] {
	if (typeof content === "string") {
		return [
			{ type: "text", text: reasoning },
			{ type: "text", text: content },
		]
	}
	if (Array.isArray(content)) {
		return [{ type: "text", text: reasoning }, ...content]
	}
	return [{ type: "text", text: reasoning }]
}
