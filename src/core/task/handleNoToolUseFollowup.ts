import type { ToolResultBlockParam, TextBlockParam, ImageBlockParam } from "@openai-agent/types"
import type { ClineSay } from "@openai-agent/types"

import type { AssistantMessageContent } from "../assistant-message/types"
import { formatResponse } from "../prompts/responses"

/**
 * ストリーム完了後、assistant が tool_use / mcp_tool_use を1つも呼ばなかった場合の
 * フォローアップ処理をまとめたモジュール。
 *
 * - consecutiveNoToolUseCount をカウントアップ
 * - 2連続以上で "MODEL_NO_TOOLS_USED" エラー通知 + consecutiveMistakeCount++
 * - userMessageContent に「ツールを使ってください」相当のメッセージを push
 * - 逆にツールを使った場合は counter を 0 にリセット
 *
 * Task 本体は host 型を満たすので `this` を直接渡す。
 */
export interface HandleAssistantToolUseHost {
	stream: {
		assistantMessageContent: AssistantMessageContent[]
		userMessageContent: (TextBlockParam | ImageBlockParam | ToolResultBlockParam)[]
	}
	graceRetry: { noToolUse: number }
	mistakeTracker: { count: number }
	say: (type: ClineSay, text?: string) => Promise<unknown>
}

export async function handleAssistantToolUseFollowup(host: HandleAssistantToolUseHost): Promise<void> {
	const didToolUse = host.stream.assistantMessageContent.some(
		(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
	)

	if (didToolUse) {
		host.graceRetry.noToolUse = 0
		return
	}

	host.graceRetry.noToolUse++

	// Only show error and count toward mistake limit after 2 consecutive failures
	if (host.graceRetry.noToolUse >= 2) {
		await host.say("error", "MODEL_NO_TOOLS_USED")
		host.mistakeTracker.count++
	}

	// Use the task's locked protocol for consistent behavior
	host.stream.userMessageContent.push({
		type: "text",
		text: formatResponse.noToolsUsed(),
	})
}
