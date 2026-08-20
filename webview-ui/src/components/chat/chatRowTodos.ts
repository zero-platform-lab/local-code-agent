import type { ClineMessage } from "@openai-agent/types"
import type { TodoItem } from "@openai-agent/types"

/**
 * `updateTodoList` の差分表示に使う「1 つ前の TODO 一覧」を求める規則。
 *
 * `ChatRow` の中のトップレベル関数として置かれていたが export されておらず、
 * 直接のテストが 1 件も無かった。行う判断は 2 つ:
 *
 * 1. 対象メッセージ**より前**にある直近の `updateTodoList` を選ぶ
 * 2. その payload から `todos` を取り出す（壊れていれば空）
 *
 * React にも DOM にも依存しない。
 */

/** その ask が `updateTodoList` ツールの呼び出しか。壊れた JSON は対象外。 */
function isUpdateTodoListAsk(message: ClineMessage): boolean {
	if (message.type !== "ask" || message.ask !== "tool") {
		return false
	}

	try {
		return JSON.parse(message.text || "{}").tool === "updateTodoList"
	} catch {
		return false
	}
}

/** payload から todos を取り出す。壊れていれば空配列。 */
function readTodos(message: ClineMessage): TodoItem[] {
	try {
		/* v8 ignore next -- 到達不能: isUpdateTodoListAsk が text の parse 成功を保証するので `|| "{}"` は踏めない */
		return JSON.parse(message.text || "{}").todos || []
		/* v8 ignore next 3 -- 到達不能: isUpdateTodoListAsk が同じ text の parse 成功を保証 */
	} catch {
		return []
	}
}

/**
 * `currentMessageTs` より前にある直近の `updateTodoList` の TODO 一覧を返す。
 * 見つからなければ空配列（= 差分表示は「全部が新規」になる）。
 *
 * 同じ ts のメッセージは「前」に含めない。自分自身と比較して差分が空になるのを避ける。
 */
export function getPreviousTodos(messages: ClineMessage[], currentMessageTs: number): TodoItem[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]

		if (message.ts >= currentMessageTs) {
			continue
		}

		if (isUpdateTodoListAsk(message)) {
			return readTodos(message)
		}
	}

	return []
}
