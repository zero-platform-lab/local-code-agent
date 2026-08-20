import type { AgentMessageContentPart } from "@openai-agent/types"

import type { ApiMessage } from "../task-persistence"
import { isMessageItem } from "../task-persistence/agentMessageUtils"

type Role = "user" | "assistant"

/**
 * 同じ role の message item が連続する場合に、送信用に 1 件へまとめる。
 *
 * **リクエスト整形専用**（保存には使わない）。rewind / edit が元の個別 item を
 * 参照し続けられるよう、非破壊で新しい配列を返す。
 *
 * function_call / function_call_output / reasoning はターンの境界を作るので、
 * それらを挟んだ message item 同士はマージしない（自然に prev が別 item になる）。
 */
export function mergeConsecutiveApiMessages(messages: ApiMessage[], options?: { roles?: Role[] }): ApiMessage[] {
	if (messages.length <= 1) {
		return messages
	}

	const mergeRoles = new Set<Role>(options?.roles ?? ["user"]) // default: user only
	const out: ApiMessage[] = []

	for (const msg of messages) {
		const prev = out[out.length - 1]
		const canMerge =
			isMessageItem(prev) &&
			isMessageItem(msg) &&
			prev.role === msg.role &&
			(msg.role === "user" || msg.role === "assistant") &&
			mergeRoles.has(msg.role) &&
			// Allow merging regular messages into a summary (API-only shaping),
			// but never merge a summary into something else.
			!msg.isSummary &&
			!prev.isTruncationMarker &&
			!msg.isTruncationMarker

		if (!canMerge || !isMessageItem(prev) || !isMessageItem(msg)) {
			out.push(msg)
			continue
		}

		// Preserve the newest ts to keep chronological ordering for downstream logic.
		out[out.length - 1] = {
			...prev,
			content: [...toParts(prev.content), ...toParts(msg.content)],
			ts: Math.max(prev.ts ?? 0, msg.ts ?? 0) || prev.ts || msg.ts,
		}
	}

	return out
}

/** content を parts 配列に正規化する。文字列は 1 パートに包む。 */
function toParts(content: string | AgentMessageContentPart[]): AgentMessageContentPart[] {
	return typeof content === "string" ? [{ type: "input_text", text: content }] : content
}
