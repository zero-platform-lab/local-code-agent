import { MAX_CHECKPOINT_TIMEOUT_SECONDS, MIN_CHECKPOINT_TIMEOUT_SECONDS } from "@openai-agent/types"

/**
 * Task constructor の引数事前検証。startTask/task/images/historyItem の排他と
 * checkpointTimeout の範囲チェックだけを担う純関数。分岐ロジックが増えたら
 * ここに集約する（constructor 本体には残さない）。
 */
export interface ValidateTaskOptionsInput {
	startTask: boolean
	task: string | undefined
	images: string[] | undefined
	historyItem: unknown
	checkpointTimeout: number
}

export function validateTaskOptions(input: ValidateTaskOptionsInput): void {
	if (input.startTask && !input.task && !input.images && !input.historyItem) {
		throw new Error("Either historyItem or task/images must be provided")
	}

	if (
		!input.checkpointTimeout ||
		input.checkpointTimeout > MAX_CHECKPOINT_TIMEOUT_SECONDS ||
		input.checkpointTimeout < MIN_CHECKPOINT_TIMEOUT_SECONDS
	) {
		throw new Error(
			"checkpointTimeout must be between " +
				MIN_CHECKPOINT_TIMEOUT_SECONDS +
				" and " +
				MAX_CHECKPOINT_TIMEOUT_SECONDS +
				" seconds",
		)
	}
}
