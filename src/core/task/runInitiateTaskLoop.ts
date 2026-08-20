import type { ContentBlockParam } from "@openai-agent/types"
import { AgentEventName } from "@openai-agent/types"

import { formatResponse } from "../prompts/responses"

/**
 * agentic loop の入口: 与えられた userContent で `recursivelyMakeClineRequests` を
 * 繰り返し呼び出し、abort されるか loop 側が `didEndLoop = true` を返すまで走る。
 *
 * loop 内でツールが呼ばれなかった場合は "No tools used" を促す user prompt を
 * 次のイテレーションに渡す既存動作をそのまま保持する。
 *
 * checkpoint service 初期化は fire-and-forget（起動時に一度だけ）。呼び出し側で
 * `() => getCheckpointService(this)` を渡す。
 */
export interface RunInitiateTaskLoopHost {
	abort: boolean
	recursivelyMakeClineRequests: (userContent: ContentBlockParam[], includeFileDetails: boolean) => Promise<boolean>
	emit: (event: typeof AgentEventName.TaskStarted) => unknown
	initCheckpointService: () => unknown
	/** `.agentignore` の読み込み。await するとロード完了を保証する（未設定なら何もしない）。 */
	rooIgnoreController?: { initialize: () => Promise<void> }
}

export interface RunInitiateTaskLoopDeps {
	host: RunInitiateTaskLoopHost
}

export async function runInitiateTaskLoop(
	deps: RunInitiateTaskLoopDeps,
	userContent: ContentBlockParam[],
): Promise<void> {
	// 最初のツール/環境情報アクセスの前に .agentignore の読み込みを保証する。未初期化のあいだ
	// AgentIgnoreController.validateAccess は全許可を返すため、初期化を await して保護ファイルが
	// 素通りする窓を塞ぐ。
	await deps.host.rooIgnoreController?.initialize()

	// Kicks off the checkpoints initialization process in the background.
	deps.host.initCheckpointService()

	let nextUserContent = userContent
	let includeFileDetails = true

	deps.host.emit(AgentEventName.TaskStarted)

	while (!deps.host.abort) {
		const didEndLoop = await deps.host.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
		includeFileDetails = false // We only need file details the first time.

		// The way this agentic loop works is that cline will be given a
		// task that he then calls tools to complete. Unless there's an
		// attempt_completion call, we keep responding back to him with his
		// tool's responses until he either attempt_completion or does not
		// use anymore tools. If he does not use anymore tools, we ask him
		// to consider if he's completed the task and then call
		// attempt_completion, otherwise proceed with completing the task.
		// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
		// requests, but Cline is prompted to finish the task as efficiently
		// as he can.

		if (didEndLoop) {
			// For now a task never 'completes'. This will only happen if
			// the user hits max requests and denies resetting the count.
			break
		} else {
			nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
		}
	}
}
