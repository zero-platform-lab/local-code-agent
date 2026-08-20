import type { TextBlockParam, ImageBlockParam } from "@openai-agent/types"
import { serializeError } from "serialize-error"

import type { ClineAsk, ToolProgressStatus } from "@openai-agent/types"

import type { ToolResponse, ToolUse, McpToolUse } from "../../shared/tools"

import { AskIgnoredError } from "../task/AskIgnoredError"
import type { PresentAssistantMessageCline } from "./presentAssistantMessageHost"

import { useMcpToolTool } from "../tools/UseMcpToolTool"

import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"

/**
 * ネイティブ MCP ツール呼び出し（mcp_tool_use ブロック）の提示・実行。
 *
 * presentAssistantMessage の巨大 switch から `case "mcp_tool_use"` の本体を切り出したもの。
 * use_mcp_tool と同じ実行経路に合流させつつ、API 履歴には元の名前を残す。
 */
export async function presentMcpToolUse(cline: PresentAssistantMessageCline, mcpBlock: McpToolUse): Promise<void> {
	if (cline.stream.didRejectTool) {
		// For native protocol, we must send a tool_result for every tool_use to avoid API errors
		const toolCallId = mcpBlock.id
		const errorMessage = !mcpBlock.partial
			? `Skipping MCP tool ${mcpBlock.name} due to user rejecting a previous tool.`
			: `MCP tool ${mcpBlock.name} was interrupted and not executed due to user rejecting a previous tool.`

		if (toolCallId) {
			cline.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(toolCallId),
				content: errorMessage,
				is_error: true,
			})
		}
		return
	}

	// Track if we've already pushed a tool result
	let hasToolResult = false
	const toolCallId = mcpBlock.id

	// Store approval feedback to merge into tool result (GitHub #10465)
	let approvalFeedback: { text: string; images?: string[] } | undefined

	const pushToolResult = (content: ToolResponse, _feedbackImages?: string[]) => {
		if (hasToolResult) {
			console.warn(`[presentAssistantMessage] Skipping duplicate tool_result for mcp_tool_use: ${toolCallId}`)
			return
		}

		let resultContent: string
		let imageBlocks: ImageBlockParam[] = []

		if (typeof content === "string") {
			resultContent = content || "(tool did not return anything)"
		} else {
			const textBlocks = content.filter((item) => item.type === "text")
			imageBlocks = content.filter((item) => item.type === "image") as ImageBlockParam[]
			resultContent =
				textBlocks.map((item) => (item as TextBlockParam).text).join("\n") || "(tool did not return anything)"
		}

		// Merge approval feedback into tool result (GitHub #10465)
		if (approvalFeedback) {
			const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
			resultContent = `${feedbackText}\n\n${resultContent}`

			// Add feedback images to the image blocks
			if (approvalFeedback.images) {
				const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
				imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
			}
		}

		if (toolCallId) {
			cline.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(toolCallId),
				content: resultContent,
			})

			if (imageBlocks.length > 0) {
				cline.stream.userMessageContent.push(...imageBlocks)
			}
		}

		hasToolResult = true
	}

	const askApproval = async (
		type: ClineAsk,
		partialMessage?: string,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	) => {
		const { response, text, images } = await cline.ask(
			type,
			partialMessage,
			false,
			progressStatus,
			isProtected || false,
		)

		if (response !== "yesButtonClicked") {
			if (text) {
				await cline.say("user_feedback", text, images)
				pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
			} else {
				pushToolResult(formatResponse.toolDenied())
			}
			cline.stream.didRejectTool = true
			return false
		}

		// Store approval feedback to be merged into tool result (GitHub #10465)
		// Don't push it as a separate tool_result here - that would create duplicates.
		// The tool will call pushToolResult, which will merge the feedback into the actual result.
		if (text) {
			await cline.say("user_feedback", text, images)
			approvalFeedback = { text, images }
		}

		return true
	}

	const handleError = async (action: string, error: Error) => {
		// Silently ignore AskIgnoredError - this is an internal control flow
		// signal, not an actual error. It occurs when a newer ask supersedes an older one.
		if (error instanceof AskIgnoredError) {
			return
		}
		const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
		await cline.say("error", `Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`)
		pushToolResult(formatResponse.toolError(errorString))
	}

	if (!mcpBlock.partial) {
		cline.tokenUsageTracker.recordToolUsage("use_mcp_tool")
	}

	// Resolve sanitized server name back to original server name
	// The serverName from parsing is sanitized (e.g., "my_server" from "my server")
	// We need the original name to find the actual MCP connection
	const mcpHub = cline.providerRef.deref()?.getMcpHub()
	let resolvedServerName = mcpBlock.serverName
	if (mcpHub) {
		const originalName = mcpHub.findServerNameBySanitizedName(mcpBlock.serverName)
		if (originalName) {
			resolvedServerName = originalName
		}
	}

	// Execute the MCP tool using the same handler as use_mcp_tool
	// Create a synthetic ToolUse block that the useMcpToolTool can handle
	const syntheticToolUse: ToolUse<"use_mcp_tool"> = {
		type: "tool_use",
		id: mcpBlock.id,
		name: "use_mcp_tool",
		params: {
			server_name: resolvedServerName,
			tool_name: mcpBlock.toolName,
			arguments: JSON.stringify(mcpBlock.arguments),
		},
		partial: mcpBlock.partial,
		nativeArgs: {
			server_name: resolvedServerName,
			tool_name: mcpBlock.toolName,
			arguments: mcpBlock.arguments,
		},
	}

	await useMcpToolTool.handle(cline, syntheticToolUse, {
		askApproval,
		handleError,
		pushToolResult,
	})
}
