import { AgentEventName } from "@openai-agent/types"

import type { MessageQueueService } from "../message-queue/MessageQueueService"

import type { TaskSubscription } from "./TaskSubscriptions"

/**
 * MessageQueueService の `stateChanged` を購読し、Task の event 再 emit と
 * webview の再描画をトリガする。
 *
 * 旧 `makeMessageQueueStateChangedHandler` は handler 関数だけを返し、`on` は
 * Task constructor、`removeListener` は `disposeTask` に散っていた。ここでは
 * 登録と解除を一組で返すので、handler 参照を Task の field に置く必要がない。
 */
export interface MessageQueueStateChangedHost {
	taskId: string
	messageQueueService: MessageQueueService
	emit(event: typeof AgentEventName.TaskUserMessage, taskId: string): unknown
	emit(event: typeof AgentEventName.QueuedMessagesUpdated, taskId: string, messages: unknown[]): unknown
	providerRef: WeakRef<{ postStateToWebviewWithoutTaskHistory(): Promise<void> | void }>
}

export function subscribeMessageQueueStateChanged(host: MessageQueueStateChangedHost): TaskSubscription {
	const handler = () => {
		host.emit(AgentEventName.TaskUserMessage, host.taskId)
		host.emit(AgentEventName.QueuedMessagesUpdated, host.taskId, host.messageQueueService.messages)
		host.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
	}

	host.messageQueueService.on("stateChanged", handler)

	return {
		label: "messageQueue.stateChanged",
		dispose: () => {
			host.messageQueueService.removeListener("stateChanged", handler)
		},
	}
}
