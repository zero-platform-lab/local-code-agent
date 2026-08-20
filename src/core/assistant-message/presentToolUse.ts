import type { TextBlockParam, ImageBlockParam } from "@openai-agent/types"
import { serializeError } from "serialize-error"

import type { ToolName, ClineAsk, ToolProgressStatus } from "@openai-agent/types"

import { t } from "../../i18n"

import { defaultModeSlug } from "../../shared/modes"
import type { ToolResponse, ToolUse } from "../../shared/tools"

import { AskIgnoredError } from "../task/AskIgnoredError"
import type { PresentAssistantMessageCline } from "./presentAssistantMessageHost"

import { isValidToolName, validateToolUse } from "../tools/validateToolUse"

import { describeToolUse } from "./describeToolUse"
import { toolDispatch } from "./toolDispatch"

import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"

/**
 * ネイティブ・ツール呼び出し（tool_use ブロック）の提示・検証・実行。
 *
 * presentAssistantMessage の巨大 switch から `case "tool_use"` の本体を切り出したもの。
 * id 検証 → 拒否済みの後始末 → nativeArgs 検証 → tool 検証 → 繰り返し検出 →
 * toolDispatch で実ツールへ委譲、という一連の実行経路。case 内早期 break は return に対応。
 */
export async function presentToolUse(cline: PresentAssistantMessageCline, block: ToolUse): Promise<void> {
	// Native tool calling is the only supported tool calling mechanism.
	// A tool_use block without an id is invalid and cannot be executed.
	const toolCallId = (block as any).id as string | undefined
	if (!toolCallId) {
		const errorMessage =
			"Invalid tool call: missing tool_use.id. XML tool calls are no longer supported. Remove any XML tool markup (e.g. <read_file>...</read_file>) and use native tool calling instead."
		// Record a tool error for visibility. Use the reported tool name if present.
		try {
			if (
				typeof (cline as any).tokenUsageTracker.recordToolError === "function" &&
				typeof (block as any).name === "string"
			) {
				;(cline as any).tokenUsageTracker.recordToolError((block as any).name as ToolName, errorMessage)
			}
		} catch {
			// Best-effort only
		}
		cline.mistakeTracker.count++
		await cline.say("error", errorMessage)
		cline.stream.userMessageContent.push({ type: "text", text: errorMessage })
		cline.stream.didAlreadyUseTool = true
		return
	}

	// Fetch state early so it's available for toolDescription and validation
	const state = await cline.providerRef.deref()?.getState()
	const { mode, customModes, experiments: stateExperiments, disabledTools, autonomyMode } = state ?? {}

	const toolDescription = (): string => describeToolUse(block, customModes)

	if (cline.stream.didRejectTool) {
		// Ignore any tool content after user has rejected tool once.
		// For native tool calling, we must send a tool_result for every tool_use to avoid API errors
		const errorMessage = !block.partial
			? `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`
			: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`

		cline.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: sanitizeToolUseId(toolCallId),
			content: errorMessage,
			is_error: true,
		})

		return
	}

	// Track if we've already pushed a tool result for this tool call (native tool calling only)
	let hasToolResult = false

	// If this is a native tool call but the parser couldn't construct nativeArgs
	// (e.g., malformed/unfinished JSON in a streaming tool call), we must NOT attempt to
	// execute the tool. Instead, emit exactly one structured tool_result so the provider
	// receives a matching tool_result for the tool_use_id.
	//
	// This avoids executing an invalid tool_use block and prevents duplicate/fragmented
	// error reporting.
	if (!block.partial) {
		const isKnownTool = isValidToolName(String(block.name), stateExperiments)
		if (isKnownTool && !block.nativeArgs) {
			const errorMessage =
				`Invalid tool call for '${block.name}': missing nativeArgs. ` +
				`This usually means the model streamed invalid or incomplete arguments and the call could not be finalized.`

			cline.mistakeTracker.count++
			try {
				cline.tokenUsageTracker.recordToolError(block.name as ToolName, errorMessage)
			} catch {
				// Best-effort only
			}

			// Push tool_result directly without setting didAlreadyUseTool so streaming can
			// continue gracefully.
			cline.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(toolCallId),
				content: formatResponse.toolError(errorMessage),
				is_error: true,
			})

			return
		}
	}

	// Store approval feedback to merge into tool result (GitHub #10465)
	let approvalFeedback: { text: string; images?: string[] } | undefined

	const pushToolResult = (content: ToolResponse) => {
		// Native tool calling: only allow ONE tool_result per tool call
		if (hasToolResult) {
			console.warn(`[presentAssistantMessage] Skipping duplicate tool_result for tool_use_id: ${toolCallId}`)
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
			if (approvalFeedback.images) {
				const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
				imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
			}
		}

		cline.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: sanitizeToolUseId(toolCallId),
			content: resultContent,
		})

		if (imageBlocks.length > 0) {
			cline.stream.userMessageContent.push(...imageBlocks)
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
			// Handle both messageResponse and noButtonClicked with text.
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

	const askFinishSubTaskApproval = async () => {
		// Ask the user to approve this task has completed, and he has
		// reviewed it, and we can declare task is finished and return
		// control to the parent task to continue running the rest of
		// the sub-tasks.
		const toolMessage = JSON.stringify({ tool: "finishTask" })
		return await askApproval("tool", toolMessage)
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

	if (!block.partial) {
		cline.tokenUsageTracker.recordToolUsage(block.name)
	}

	// Validate tool use before execution - ONLY for complete (non-partial) blocks.
	// Validating partial blocks would cause validation errors to be thrown repeatedly
	// during streaming, pushing multiple tool_results for the same tool_use_id and
	// potentially causing the stream to appear frozen.
	if (!block.partial) {
		const modelInfo = cline.api.getModel()
		// Resolve aliases in includedTools before validation
		// e.g., "edit_file" should resolve to "apply_diff"
		const rawIncludedTools = modelInfo?.info?.includedTools
		const { resolveToolAlias } = await import("../prompts/tools/filter-tools-for-mode")
		const includedTools = rawIncludedTools?.map((tool) => resolveToolAlias(tool))

		try {
			const toolRequirements =
				disabledTools?.reduce(
					(acc: Record<string, boolean>, tool: string) => {
						acc[tool] = false
						const resolvedToolName = resolveToolAlias(tool)
						acc[resolvedToolName] = false
						return acc
					},
					{} as Record<string, boolean>,
				) ?? {}

			validateToolUse(
				block.name as ToolName,
				mode ?? defaultModeSlug,
				customModes ?? [],
				toolRequirements,
				block.params,
				stateExperiments,
				includedTools,
				autonomyMode,
			)
		} catch (error) {
			cline.mistakeTracker.count++
			// For validation errors (unknown tool, tool not allowed for mode), we need to:
			// 1. Send a tool_result with the error (required for native tool calling)
			// 2. NOT set didAlreadyUseTool = true (the tool was never executed, just failed validation)
			// This prevents the stream from being interrupted with "Response interrupted by tool use result"
			// which would cause the extension to appear to hang
			const errorContent = formatResponse.toolError(error.message)
			// Push tool_result directly without setting didAlreadyUseTool
			cline.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(toolCallId),
				content: typeof errorContent === "string" ? errorContent : "(validation error)",
				is_error: true,
			})

			return
		}
	}

	// Check for identical consecutive tool calls.
	if (!block.partial) {
		// Use the detector to check for repetition, passing the ToolUse
		// block directly.
		const repetitionCheck = cline.toolRepetitionDetector.check(block)

		// If execution is not allowed, notify user and break.
		if (!repetitionCheck.allowExecution && repetitionCheck.askUser) {
			// Handle repetition similar to mistake_limit_reached pattern.
			const { response, text, images } = await cline.ask(
				repetitionCheck.askUser.messageKey as ClineAsk,
				repetitionCheck.askUser.messageDetail.replace("{toolName}", block.name),
			)

			if (response === "messageResponse") {
				// Add user feedback to userContent.
				cline.stream.userMessageContent.push(
					{
						type: "text" as const,
						text: `Tool repetition limit reached. User feedback: ${text}`,
					},
					...formatResponse.imageBlocks(images),
				)

				// Add user feedback to chat.
				await cline.say("user_feedback", text, images)
			}

			// Return tool result message about the repetition
			pushToolResult(
				formatResponse.toolError(
					`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
				),
			)
			return
		}
	}

	const dispatchEntry = toolDispatch[block.name as ToolName]

	if (dispatchEntry) {
		if (dispatchEntry.savesCheckpoint) {
			await checkpointSaveAndMark(cline)
		}

		await dispatchEntry.handle(cline, block, {
			askApproval,
			handleError,
			pushToolResult,
			...dispatchEntry.extraCallbacks?.({ block, askFinishSubTaskApproval, toolDescription }),
		})
	} else if (!block.partial) {
		// Unknown/invalid tool name, or a custom tool we don't route.
		// Native tool calling requires a tool_result for EVERY tool_use, so we must answer.
		//
		// CRITICAL: partial blocks are ignored on purpose. Showing the error on every
		// streaming chunk would loop and look like the extension had frozen.
		const errorMessage = `Unknown tool "${block.name}". This tool does not exist. Please use one of the available tools.`
		cline.mistakeTracker.count++
		cline.tokenUsageTracker.recordToolError(block.name as ToolName, errorMessage)
		await cline.say("error", t("tools:unknownToolError", { toolName: block.name }))
		// Push tool_result directly WITHOUT setting didAlreadyUseTool
		// This prevents the stream from being interrupted with "Response interrupted by tool use result"
		cline.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: sanitizeToolUseId(toolCallId),
			content: formatResponse.toolError(errorMessage),
			is_error: true,
		})
	}
}

/**
 * save checkpoint and mark done in the current streaming task.
 * @param task The Task instance to checkpoint save and mark.
 * @returns
 */
async function checkpointSaveAndMark(task: PresentAssistantMessageCline) {
	if (task.stream.currentStreamingDidCheckpoint) {
		return
	}
	try {
		await task.checkpointSave(true)
		task.stream.currentStreamingDidCheckpoint = true
	} catch (error) {
		console.error(`[Task#presentAssistantMessage] Error saving checkpoint: ${error.message}`, error)
	}
}
