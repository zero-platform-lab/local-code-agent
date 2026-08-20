import type { AgentMessage } from "@openai-agent/types"

import type { ApiMessage } from "../task-persistence"

/**
 * 保存済み会話履歴を、そのまま API に送れる `AgentMessage[]` に整える。
 *
 * かつてはここが Anthropic 形式 → Responses item 列の**変換**を担っていたが、
 * 履歴自体が item 列になったので、残る仕事は送信前のフィルタだけ:
 *
 * - 拡張独自のメタデータ（ts / condense* / truncation* / isSummary）を落とす
 *   （送信 body に載せると互換サーバが未知フィールドで弾くことがある）
 * - `encrypted_content` を持たない reasoning item を落とす
 *   （Responses API は暗号化された reasoning しか受け付けない）
 *
 * `includeReasoning` は **既定で true**。`include: ["reasoning.encrypted_content"]` で
 * 受け取った思考を次ターンに戻すのが multi-turn reasoning の要件なので、通常の推論
 * リクエストでは常に送る。思考の連続性が要らない要約リクエストだけが明示的に false を渡す。
 *
 * 既定を true にしているのは事故防止。かつてここに `modelInfo.preserveReasoning` を
 * 渡していたが、その値を設定する UI が無いため常に false になり、multi-turn reasoning が
 * 全ユーザーで無効になっていた（実機で発見）。渡し忘れが安全側に倒れるようにしてある。
 */
export function buildCleanConversationHistory(messages: ApiMessage[], includeReasoning = true): AgentMessage[] {
	const out: AgentMessage[] = []

	for (const msg of messages) {
		if (msg.type === "reasoning") {
			// 暗号化されていない reasoning は送れない（Responses API は encrypted のみ受ける）。
			if (!msg.encrypted_content) continue
			if (!includeReasoning) continue
			out.push({
				type: "reasoning",
				encrypted_content: msg.encrypted_content,
				...(msg.summary !== undefined ? { summary: msg.summary } : {}),
				...(msg.id ? { id: msg.id } : {}),
			})
			continue
		}

		out.push(stripMeta(msg))
	}

	return out
}

/** 拡張独自のメタデータを落として、SDK が受け付ける形だけにする。 */
function stripMeta(item: AgentMessage): AgentMessage {
	switch (item.type) {
		case "message":
			return { type: "message", role: item.role, content: item.content }
		case "function_call":
			return {
				type: "function_call",
				call_id: item.call_id,
				name: item.name,
				arguments: item.arguments,
			}
		case "function_call_output":
			return { type: "function_call_output", call_id: item.call_id, output: item.output }
		/* v8 ignore next 2 -- 到達不能: reasoning item は buildCleanConversationHistory 側で intercept され stripMeta には渡らない（呼び出し契約上どの入力でも踏めない、型網羅のための防御ケース） */
		case "reasoning":
			return item
	}
}
