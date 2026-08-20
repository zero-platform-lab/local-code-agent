import type { AgentMessage } from "@openai-agent/types"

import type { ApiHandler } from "../../api"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { getEffectiveApiHistory, getMessagesSinceLastSummary } from "../condense"
import type { ApiMessage } from "../task-persistence"

import { buildCleanConversationHistory } from "./buildCleanConversationHistory"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"

/**
 * 保存済み会話履歴から、API に送る item 列を組み立てる。
 *
 * `attemptApiRequest` の中に直列で並んでいた 5 段を関数として切り出したもの。
 * **順序に意味がある**ので、まとめてテストできる形にしてある:
 *
 * 1. `getEffectiveApiHistory` — condense / truncation で隠されたものを外す。
 *    最初にやらないと、後段が「送らないもの」を数えたり結合したりしてしまう
 * 2. `getMessagesSinceLastSummary` — 最後のサマリ以降だけにする（fresh start）
 * 3. `mergeConsecutiveApiMessages` — 連続する user を送信用にまとめる。
 *    **保存には反映しない**（rewind が元の item を参照し続けられるように）
 * 4. `maybeRemoveImageBlocks` — 画像を扱えないモデル向けにプレースホルダ化。
 *    マージ後にやるのは、結合で content が配列になった分も拾うため
 * 5. `buildCleanConversationHistory` — 拡張独自メタを落とし、送れない reasoning を外す
 */
export function buildRequestHistory(history: ApiMessage[], api: ApiHandler): AgentMessage[] {
	const effectiveHistory = getEffectiveApiHistory(history)
	const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
	const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] })
	const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, api)
	// reasoning は既定で送る（multi-turn reasoning の要件）。
	return buildCleanConversationHistory(messagesWithoutImages as ApiMessage[])
}
