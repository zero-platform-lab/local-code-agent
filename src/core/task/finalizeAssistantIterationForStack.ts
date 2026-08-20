import type { ContentBlockParam, ToolResultBlockParam, TextBlockParam, ImageBlockParam } from "@openai-agent/types"
import pWaitFor from "p-wait-for"

import type { AssistantMessageContent } from "../assistant-message/types"
import type { ClineSay } from "@openai-agent/types"

import { handleAssistantToolUseFollowup, type HandleAssistantToolUseHost } from "./handleNoToolUseFollowup"

/**
 * hasContent iteration の後半処理: pWaitFor で userMessageContentReady を待ち、
 * no-tool-use followup を反映し、次のイテレーションを stack に積むかどうかを判定する。
 *
 * 「stack に積むべきなら次の StackItem を返し、そうでなければ undefined を返す」
 * 制御は呼び出し側の while ループが握る（handleMidStreamError / handleEmptyAssistantResponse
 * と同じ設計）。
 */
export type FinalizeIterationHost = HandleAssistantToolUseHost & {
	stream: {
		userMessageContent: (TextBlockParam | ImageBlockParam | ToolResultBlockParam)[]
		userMessageContentReady: boolean
		assistantMessageContent: AssistantMessageContent[]
	}
	isPaused: boolean
	say: (type: ClineSay, text?: string) => Promise<unknown>
}

export interface FinalizeIterationStackItem {
	userContent: ContentBlockParam[]
	includeFileDetails: false
}

export async function finalizeAssistantIterationForStack(
	host: FinalizeIterationHost,
): Promise<FinalizeIterationStackItem | undefined> {
	await pWaitFor(() => host.stream.userMessageContentReady)

	// If the model did not tool use, then we need to tell it to
	// either use a tool or attempt_completion.
	await handleAssistantToolUseFollowup(host)

	// Push to stack if there's content OR if we're paused waiting for a subtask.
	// When paused, we push an empty item so the loop continues to the pause check.
	if (host.stream.userMessageContent.length > 0 || host.isPaused) {
		const item: FinalizeIterationStackItem = {
			userContent: [...host.stream.userMessageContent], // Create a copy to avoid mutation issues
			includeFileDetails: false, // Subsequent iterations don't need file details
		}

		// Add periodic yielding to prevent blocking
		await new Promise((resolve) => setImmediate(resolve))
		return item
	}

	return undefined
}
