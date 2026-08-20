import type { ContentBlockParam, ImageBlockParam } from "@openai-agent/types"
import {
	MAX_MCP_TOOLS_THRESHOLD,
	type ClineApiReqCancelReason,
	type ClineMessage,
	type ClineSay,
} from "@openai-agent/types"

import { formatResponse } from "../prompts/responses"
import type { ApiMessage } from "../task-persistence"

/**
 * 新しいタスクを開始するときに必要な操作。
 *
 * Task の state field は host 経由で直接書き換え、外部依存は callback として渡す。
 */
export interface StartTaskStateHost {
	messageStore: { clineMessages: ClineMessage[]; apiConversationHistory: ApiMessage[] }
	isInitialized: boolean
	abort: boolean
	abandoned: boolean
	abortReason?: ClineApiReqCancelReason
	say: (
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: undefined,
		options?: { isNonInteractive?: boolean },
	) => Promise<unknown>
	getEnabledMcpToolsCount: () => Promise<{ enabledToolCount: number; enabledServerCount: number }>
	initiateTaskLoop: (userContent: ContentBlockParam[]) => Promise<void>
	postStateToWebviewWithoutTaskHistory: () => Promise<unknown> | undefined
}

export interface StartTaskDeps {
	host: StartTaskStateHost
}

/**
 * 新規タスクの初期化と最初のループ開始。
 *
 * webview 側の履歴を確実にクリアしてから最初のメッセージを表示、MCP ツール数が
 * 多すぎる場合の警告を出し、`initiateTaskLoop` を呼ぶ。
 *
 * `initiateTaskLoop` は無限ループを回すため、途中で abort / abandon されたときの
 * unhandled rejection を防ぐガードを外側と内側の両方に持つ。
 */
export async function startTask(
	deps: StartTaskDeps,
	task: string | undefined,
	images: string[] | undefined,
): Promise<void> {
	const { host } = deps

	try {
		// `conversationHistory` (for API) and `clineMessages` (for webview)
		// need to be in sync.
		// If the extension process were killed, then on restart the
		// `clineMessages` might not be empty, so we need to set it to [] when
		// we create a new Cline client (otherwise webview would show stale
		// messages from previous session).
		host.messageStore.clineMessages = []
		host.messageStore.apiConversationHistory = []

		// The todo list is already set in the constructor if initialTodos were provided
		// No need to add any messages - the todoList property is already set

		await deps.host.postStateToWebviewWithoutTaskHistory()

		await host.say("text", task, images)

		// Check for too many MCP tools and warn the user
		const { enabledToolCount, enabledServerCount } = await host.getEnabledMcpToolsCount()
		if (enabledToolCount > MAX_MCP_TOOLS_THRESHOLD) {
			await host.say(
				"too_many_tools_warning",
				JSON.stringify({
					toolCount: enabledToolCount,
					serverCount: enabledServerCount,
					threshold: MAX_MCP_TOOLS_THRESHOLD,
				}),
				undefined,
				undefined,
				undefined,
				undefined,
				{ isNonInteractive: true },
			)
		}
		host.isInitialized = true

		const imageBlocks: ImageBlockParam[] = formatResponse.imageBlocks(images)

		// Task starting
		await host
			.initiateTaskLoop([
				{
					type: "text",
					text: `<user_message>\n${task}\n</user_message>`,
				},
				...imageBlocks,
			])
			.catch((error) => {
				// Swallow loop rejection when the task was intentionally abandoned/aborted
				// during delegation or user cancellation to prevent unhandled rejections.
				if (host.abandoned === true || host.abortReason === "user_cancelled") {
					return
				}
				throw error
			})
	} catch (error) {
		// In tests and some UX flows, tasks can be aborted while `startTask` is still
		// initializing. Treat abort/abandon as expected and avoid unhandled rejections.
		if (host.abandoned === true || host.abort === true || host.abortReason === "user_cancelled") {
			return
		}
		throw error
	}
}
