import type { ClineApiReqCancelReason } from "@openai-agent/types"

/**
 * stream の1 chunk 処理後に「今回のイテレーションを中断すべきか」を判定する。
 *
 * 中断ケース:
 *  - `abort` かつ `!abandoned`: user_cancelled として abortStream を呼び break
 *  - `didRejectTool`: user が tool を reject したので "interrupted by user feedback" を suffix に追加して break
 *  - `didAlreadyUseTool`: 同一 assistant message で複数 tool 使ってしまったので "only one tool at a time" を suffix に追加して break
 *
 * 継続ケースは `stop: false`。呼び出し側は while ループ内で break の可否を
 * 返り値の `stop` から判断する。suffix は呼び出し側で `assistantMessage += suffix`。
 */
export interface CheckAbortOrInterruptionHost {
	abort: boolean
	abandoned: boolean
	stream: {
		didRejectTool: boolean
		didAlreadyUseTool: boolean
	}
}

export type ChunkLoopStep = { stop: false } | { stop: true; assistantMessageSuffix?: string }

export async function checkAbortOrInterruption(
	host: CheckAbortOrInterruptionHost,
	abortStream: (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => Promise<void>,
): Promise<ChunkLoopStep> {
	if (host.abort) {
		console.log(`aborting stream, this.abandoned = ${host.abandoned}`)

		if (!host.abandoned) {
			// Only need to gracefully abort if this instance isn't abandoned
			// (sometimes OpenRouter stream hangs, in which case this would affect
			// future instances of Cline).
			await abortStream("user_cancelled")
		}

		return { stop: true }
	}

	if (host.stream.didRejectTool) {
		// userContent has a tool rejection, so interrupt the assistant's response
		// to present the user's feedback.
		return {
			stop: true,
			assistantMessageSuffix: "\n\n[Response interrupted by user feedback]",
		}
	}

	if (host.stream.didAlreadyUseTool) {
		return {
			stop: true,
			assistantMessageSuffix:
				"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]",
		}
	}

	return { stop: false }
}
