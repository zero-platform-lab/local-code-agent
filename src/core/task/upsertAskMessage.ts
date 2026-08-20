import type { ClineAsk, ClineMessage, ToolProgressStatus } from "@openai-agent/types"

import { AskIgnoredError } from "./AskIgnoredError"

/**
 * `Task.ask()` の前半、clineMessages への「ask 型メッセージの追加/更新」を担うヘルパ。
 *
 * partial 3 状態（true / false / undefined）と直前メッセージの partial 状態の組み合わせで
 * 分岐が 5 通りに広がるが、いずれも「clineMessages 末尾を更新するか末尾に append するか、
 * その際 lastMessageTs / askResponse* をどう扱うか」の違いだけ。
 *
 * partial=true 系（新規 partial / 既存 partial の更新）は AskIgnoredError を投げて
 * 呼び出し側の pWaitFor に進まないようにする既存動作をそのまま保つ。
 */
export interface UpsertAskMessageDeps {
	clineMessages: ClineMessage[]
	setLastMessageTs: (ts: number) => void
	resetAskResponse: () => void
	addToClineMessages: (message: ClineMessage) => Promise<unknown>
	saveClineMessages: () => Promise<unknown>
	updateClineMessage: (message: ClineMessage) => unknown
}

export interface UpsertAskMessageInput {
	type: ClineAsk
	text?: string
	partial?: boolean
	progressStatus?: ToolProgressStatus
	isProtected?: boolean
}

export interface UpsertAskMessageResult {
	askTs: number
}

export async function upsertAskMessage(
	deps: UpsertAskMessageDeps,
	input: UpsertAskMessageInput,
): Promise<UpsertAskMessageResult> {
	const { type, text, partial, progressStatus, isProtected } = input
	let askTs: number

	if (partial !== undefined) {
		const lastMessage = deps.clineMessages.at(-1)

		const isUpdatingPreviousPartial =
			lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

		if (partial) {
			if (isUpdatingPreviousPartial) {
				// Existing partial message, so update it.
				lastMessage.text = text
				lastMessage.partial = partial
				lastMessage.progressStatus = progressStatus
				lastMessage.isProtected = isProtected
				// TODO: Be more efficient about saving and posting only new
				// data or one whole message at a time so ignore partial for
				// saves, and only post parts of partial message instead of
				// whole array in new listener.
				deps.updateClineMessage(lastMessage)
				throw new AskIgnoredError("updating existing partial")
			} else {
				// This is a new partial message, so add it with partial state.
				askTs = Date.now()
				deps.setLastMessageTs(askTs)
				await deps.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial, isProtected })
				throw new AskIgnoredError("new partial")
			}
		} else {
			if (isUpdatingPreviousPartial) {
				// This is the complete version of a previously partial message,
				// so replace the partial with the complete version.
				deps.resetAskResponse()

				// Bug for the history books:
				// In the webview we use the ts as the chatrow key for the
				// virtuoso list. Since we would update this ts right at the
				// end of streaming, it would cause the view to flicker. The
				// key prop has to be stable otherwise react has trouble
				// reconciling items between renders, causing unmounting and
				// remounting of components (flickering).
				// The lesson here is if you see flickering when rendering
				// lists, it's likely because the key prop is not stable.
				// So in this case we must make sure that the message ts is
				// never altered after first setting it.
				askTs = lastMessage.ts
				deps.setLastMessageTs(askTs)
				lastMessage.text = text
				lastMessage.partial = false
				lastMessage.progressStatus = progressStatus
				lastMessage.isProtected = isProtected
				await deps.saveClineMessages()
				deps.updateClineMessage(lastMessage)
			} else {
				// This is a new and complete message, so add it like normal.
				deps.resetAskResponse()
				askTs = Date.now()
				deps.setLastMessageTs(askTs)
				await deps.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
			}
		}
	} else {
		// This is a new non-partial message, so add it like normal.
		deps.resetAskResponse()
		askTs = Date.now()
		deps.setLastMessageTs(askTs)
		await deps.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
	}

	return { askTs }
}
