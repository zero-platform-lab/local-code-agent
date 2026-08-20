import {
	AgentEventName,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	type ClineAsk,
	type ClineMessage,
} from "@openai-agent/types"

/**
 * `Task.ask()` の中で「一定時間反応が無かった時に task の interactive/resumable/idle
 * 状態に遷移させる」タイマーをセットする部分を切り出したもの。
 *
 * ask 型に応じて 3 種類の遷移を分岐。いずれも 2 秒後に発火し、まだ該当メッセージが
 * clineMessages に残っていれば `this.interactiveAsk` 等に紐付けて対応する
 * イベントを emit する。interactive のときは webview にも通知する。
 *
 * どれにも該当しない ask 型では何もセットしない（undefined 相当）。
 *
 * 返り値の Timeout を呼び出し側の timeouts 配列に push することで、応答が
 * 帰ってきたときに一括 clear できるようにする。
 */
export interface ScheduleAskStatusMutationHost {
	findMessageByTimestamp: (ts: number) => ClineMessage | undefined
	setInteractiveAsk: (m: ClineMessage) => void
	setResumableAsk: (m: ClineMessage) => void
	setIdleAsk: (m: ClineMessage) => void
	emit: (
		event: AgentEventName.TaskInteractive | AgentEventName.TaskResumable | AgentEventName.TaskIdle,
		taskId: string,
	) => unknown
	taskId: string
	postMessageToWebview: (message: { type: "interactionRequired" }) => void
}

const STATUS_MUTATION_TIMEOUT_MS = 2_000

export function scheduleAskStatusMutation(
	host: ScheduleAskStatusMutationHost,
	type: ClineAsk,
	askTs: number,
): NodeJS.Timeout | undefined {
	if (isInteractiveAsk(type)) {
		return setTimeout(() => {
			const message = host.findMessageByTimestamp(askTs)

			if (message) {
				host.setInteractiveAsk(message)
				host.emit(AgentEventName.TaskInteractive, host.taskId)
				host.postMessageToWebview({ type: "interactionRequired" })
			}
		}, STATUS_MUTATION_TIMEOUT_MS)
	}

	if (isResumableAsk(type)) {
		return setTimeout(() => {
			const message = host.findMessageByTimestamp(askTs)

			if (message) {
				host.setResumableAsk(message)
				host.emit(AgentEventName.TaskResumable, host.taskId)
			}
		}, STATUS_MUTATION_TIMEOUT_MS)
	}

	if (isIdleAsk(type)) {
		return setTimeout(() => {
			const message = host.findMessageByTimestamp(askTs)

			if (message) {
				host.setIdleAsk(message)
				host.emit(AgentEventName.TaskIdle, host.taskId)
			}
		}, STATUS_MUTATION_TIMEOUT_MS)
	}

	return undefined
}
