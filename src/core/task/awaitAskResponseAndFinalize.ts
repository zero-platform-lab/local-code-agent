import pWaitFor from "p-wait-for"

import type { ClineAsk, ClineAskResponse, QueuedMessage } from "@openai-agent/types"
import { AgentEventName } from "@openai-agent/types"

import { AskIgnoredError } from "./AskIgnoredError"
import { drainQueuedMessageForAsk } from "./drainQueuedMessageForAsk"
import type { AskState } from "./AskState"

/**
 * `Task.ask()` の後半（pWaitFor で応答を待ち、supersede チェック → response を
 * 束ねて返し、timeouts clear と switchable ask reset と emit まで）を切り出した
 * モジュール。
 *
 * pWaitFor ループ内で queue に新しい message が届いた場合は task hang を防ぐため
 * その場で drainQueuedMessageForAsk を叩いて ask を fulfill する既存動作を維持。
 */
export interface AwaitAskResponseAndFinalizeHost {
	askState: AskState
	taskId: string
	emit: {
		(event: AgentEventName.TaskActive, taskId: string): unknown
		(event: AgentEventName.TaskAskResponded): unknown
	}
	messageQueueService: {
		isEmpty(): boolean
		dequeueMessage(): QueuedMessage | undefined
	}
	handleWebviewAskResponse: (askResponse: ClineAskResponse, text?: string, images?: string[]) => void
}

export interface AwaitAskResponseAndFinalizeInput {
	askTs: number
	timeouts: NodeJS.Timeout[]
	type: ClineAsk
	shouldDrainQueuedMessageForAsk: boolean
}

export async function awaitAskResponseAndFinalize(
	host: AwaitAskResponseAndFinalizeHost,
	input: AwaitAskResponseAndFinalizeInput,
): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
	const { askTs, timeouts, type, shouldDrainQueuedMessageForAsk } = input

	// Wait for askResponse to be set
	await pWaitFor(
		() => {
			if (host.askState.askResponse !== undefined || host.askState.lastMessageTs !== askTs) {
				return true
			}

			// If a queued message arrives while we're blocked on an ask (e.g. a follow-up
			// suggestion click that was incorrectly queued due to UI state), consume it
			// immediately so the task doesn't hang.
			if (shouldDrainQueuedMessageForAsk && !host.messageQueueService.isEmpty()) {
				drainQueuedMessageForAsk(host, type)
			}

			return false
		},
		{ interval: 100 },
	)

	if (host.askState.lastMessageTs !== askTs) {
		// Could happen if we send multiple asks in a row i.e. with
		// command_output. It's important that when we know an ask could
		// fail, it is handled gracefully.
		throw new AskIgnoredError("superseded")
	}

	const result = {
		response: host.askState.askResponse!,
		text: host.askState.askResponseText,
		images: host.askState.askResponseImages,
	}
	host.askState.resetResponse()

	// Cancel the timeouts if they are still running.
	timeouts.forEach((timeout) => clearTimeout(timeout))

	// Switch back to an active state.
	if (host.askState.currentAsk) {
		host.askState.clearAsks()
		host.emit(AgentEventName.TaskActive, host.taskId)
	}

	host.emit(AgentEventName.TaskAskResponded)
	return result
}
