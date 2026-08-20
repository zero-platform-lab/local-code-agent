import type { QueuedMessage } from "@openai-agent/types"

/**
 * message queue から1件取り出して、次の tick で `submitUserMessage` に渡す。
 *
 * setTimeout(0) を挟むのは呼び出し元 flow を先に完了させるため。
 * queue 空・dequeue null は no-op（catch でエラーはログに落として吸収する）。
 */
export interface ProcessQueuedMessagesHost {
	messageQueueService: {
		isEmpty(): boolean
		dequeueMessage(): QueuedMessage | undefined
	}
	submitUserMessage: (text: string, images?: string[]) => Promise<void>
}

export function processQueuedMessages(host: ProcessQueuedMessagesHost): void {
	try {
		if (!host.messageQueueService.isEmpty()) {
			const queued = host.messageQueueService.dequeueMessage()
			if (queued) {
				setTimeout(() => {
					host.submitUserMessage(queued.text, queued.images).catch((err) =>
						console.error(`[Task] Failed to submit queued message:`, err),
					)
				}, 0)
			}
		}
	} catch (e) {
		console.error(`[Task] Queue processing error:`, e)
	}
}
