import type {
	ClineAskUseMcpServer,
	ExtensionMessage,
	McpExecutionStatus,
	McpServer,
	McpToolCallResponse,
} from "@openai-agent/types"

import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import type { ToolUse } from "../../shared/tools"
import { toolNamesMatch } from "../../utils/mcp-name"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolTaskContext, ToolTaskSay } from "./toolHost"

interface UseMcpToolParams {
	server_name: string
	tool_name: string
	arguments?: Record<string, unknown>
}

interface McpHubLike {
	getAllServers(): McpServer[]
	callTool(
		serverName: string,
		toolName: string,
		toolArguments?: Record<string, unknown>,
	): Promise<McpToolCallResponse>
}

interface UseMcpToolProviderLike {
	getMcpHub(): McpHubLike | undefined
	postMessageToWebview(message: ExtensionMessage): Promise<unknown>
}

/** Narrow structural view of `Task` required by {@link UseMcpToolTool}. */
interface UseMcpToolHost extends ToolTaskContext, ToolTaskSay {
	stream: {
		didToolFailInCurrentTurn: boolean
	}
	readonly askState: { lastMessageTs?: number }
	readonly providerRef: WeakRef<UseMcpToolProviderLike>
}

type ValidationResult =
	| { isValid: false }
	| {
			isValid: true
			serverName: string
			toolName: string
			parsedArguments?: Record<string, unknown>
	  }

export class UseMcpToolTool extends BaseTool<"use_mcp_tool"> {
	readonly name = "use_mcp_tool" as const

	async execute(params: UseMcpToolParams, task: UseMcpToolHost, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate parameters
			const validation = await this.validateParams(task, params, pushToolResult)
			if (!validation.isValid) {
				return
			}

			const { serverName, toolName, parsedArguments } = validation

			// Validate that the tool exists on the server
			const toolValidation = await this.validateToolExists(task, serverName, toolName, pushToolResult)
			if (!toolValidation.isValid) {
				return
			}

			// Use the resolved tool name (original name from the server) for MCP calls
			// This handles cases where models mangle hyphens to underscores
			const resolvedToolName = toolValidation.resolvedToolName ?? toolName

			// Reset mistake count on successful validation
			task.mistakeTracker.count = 0

			// Get user approval
			const completeMessage = JSON.stringify({
				type: "use_mcp_tool",
				serverName,
				toolName: resolvedToolName,
				arguments: params.arguments ? JSON.stringify(params.arguments) : undefined,
			} satisfies ClineAskUseMcpServer)

			const executionId = task.askState.lastMessageTs?.toString() ?? Date.now().toString()
			const didApprove = await askApproval("use_mcp_server", completeMessage)

			if (!didApprove) {
				return
			}

			// Execute the tool and process results
			await this.executeToolAndProcessResult(
				task,
				serverName,
				resolvedToolName,
				parsedArguments,
				executionId,
				pushToolResult,
			)
		} catch (error) {
			await handleError("executing MCP tool", error as Error)
		}
	}

	override async handlePartial(task: UseMcpToolHost, block: ToolUse<"use_mcp_tool">): Promise<void> {
		const params = block.params
		const partialMessage = JSON.stringify({
			type: "use_mcp_tool",
			serverName: params.server_name ?? "",
			toolName: params.tool_name ?? "",
			arguments: params.arguments,
		} satisfies ClineAskUseMcpServer)

		await task.ask("use_mcp_server", partialMessage, true).catch(() => {})
	}

	private async validateParams(
		task: UseMcpToolHost,
		params: UseMcpToolParams,
		pushToolResult: (content: string) => void,
	): Promise<ValidationResult> {
		if (!params.server_name) {
			task.mistakeTracker.count++
			task.tokenUsageTracker.recordToolError("use_mcp_tool")
			pushToolResult(await task.sayAndCreateMissingParamError("use_mcp_tool", "server_name"))
			return { isValid: false }
		}

		if (!params.tool_name) {
			task.mistakeTracker.count++
			task.tokenUsageTracker.recordToolError("use_mcp_tool")
			pushToolResult(await task.sayAndCreateMissingParamError("use_mcp_tool", "tool_name"))
			return { isValid: false }
		}

		// Native-only: arguments are already a structured object.
		let parsedArguments: Record<string, unknown> | undefined
		if (params.arguments !== undefined) {
			if (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments)) {
				task.mistakeTracker.count++
				task.tokenUsageTracker.recordToolError("use_mcp_tool")
				await task.say("error", t("mcp:errors.invalidJsonArgument", { toolName: params.tool_name }))
				task.stream.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						formatResponse.invalidMcpToolArgumentError(params.server_name, params.tool_name),
					),
				)
				return { isValid: false }
			}
			parsedArguments = params.arguments
		}

		return {
			isValid: true,
			serverName: params.server_name,
			toolName: params.tool_name,
			parsedArguments,
		}
	}

	private async validateToolExists(
		task: UseMcpToolHost,
		serverName: string,
		toolName: string,
		pushToolResult: (content: string) => void,
	): Promise<{ isValid: boolean; availableTools?: string[]; resolvedToolName?: string }> {
		try {
			// Get the MCP hub to access server information
			const provider = task.providerRef.deref()
			const mcpHub = provider?.getMcpHub()

			if (!mcpHub) {
				// If we can't get the MCP hub, we can't validate, so proceed with caution
				return { isValid: true }
			}

			// Get all servers to find the specific one
			const servers = mcpHub.getAllServers()
			const server = servers.find((s) => s.name === serverName)

			if (!server) {
				// Fail fast when server is unknown
				const availableServersArray = servers.map((s) => s.name)
				const availableServers =
					availableServersArray.length > 0 ? availableServersArray.join(", ") : "No servers available"

				task.mistakeTracker.count++
				task.tokenUsageTracker.recordToolError("use_mcp_tool")
				await task.say("error", t("mcp:errors.serverNotFound", { serverName, availableServers }))
				task.stream.didToolFailInCurrentTurn = true

				pushToolResult(formatResponse.unknownMcpServerError(serverName, availableServersArray))
				return { isValid: false, availableTools: [] }
			}

			// Check if the server has tools defined
			if (!server.tools || server.tools.length === 0) {
				// No tools available on this server
				task.mistakeTracker.count++
				task.tokenUsageTracker.recordToolError("use_mcp_tool")
				await task.say(
					"error",
					t("mcp:errors.toolNotFound", {
						toolName,
						serverName,
						availableTools: "No tools available",
					}),
				)
				task.stream.didToolFailInCurrentTurn = true

				pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, []))
				return { isValid: false, availableTools: [] }
			}

			// Check if the requested tool exists (using fuzzy matching to handle model mangling of hyphens)
			const tool = server.tools.find((t) => toolNamesMatch(t.name, toolName))

			if (!tool) {
				// Tool not found - provide list of available tools
				const availableToolNames = server.tools.map((tool) => tool.name)

				task.mistakeTracker.count++
				task.tokenUsageTracker.recordToolError("use_mcp_tool")
				await task.say(
					"error",
					t("mcp:errors.toolNotFound", {
						toolName,
						serverName,
						availableTools: availableToolNames.join(", "),
					}),
				)
				task.stream.didToolFailInCurrentTurn = true

				pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, availableToolNames))
				return { isValid: false, availableTools: availableToolNames }
			}

			// Check if the tool is disabled (enabledForPrompt is false)
			if (tool.enabledForPrompt === false) {
				// Tool is disabled - only show enabled tools
				const enabledTools = server.tools.filter((t) => t.enabledForPrompt !== false)
				const enabledToolNames = enabledTools.map((t) => t.name)

				task.mistakeTracker.count++
				task.tokenUsageTracker.recordToolError("use_mcp_tool")
				await task.say(
					"error",
					t("mcp:errors.toolDisabled", {
						toolName,
						serverName,
						availableTools:
							enabledToolNames.length > 0 ? enabledToolNames.join(", ") : "No enabled tools available",
					}),
				)
				task.stream.didToolFailInCurrentTurn = true

				pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, enabledToolNames))
				return { isValid: false, availableTools: enabledToolNames }
			}

			// Tool exists and is enabled - return the original tool name for use with the MCP server
			return { isValid: true, availableTools: server.tools.map((t) => t.name), resolvedToolName: tool.name }
		} catch (error) {
			// If there's an error during validation, log it but don't block the tool execution
			// The actual tool call might still fail with a proper error
			console.error("Error validating MCP tool existence:", error)
			return { isValid: true }
		}
	}

	private async sendExecutionStatus(task: UseMcpToolHost, status: McpExecutionStatus): Promise<void> {
		const clineProvider = await task.providerRef.deref()
		clineProvider?.postMessageToWebview({
			type: "mcpExecutionStatus",
			text: JSON.stringify(status),
		})
	}

	private processToolContent(toolResult: any): { text: string; images: string[] } {
		if (!toolResult?.content || toolResult.content.length === 0) {
			return { text: "", images: [] }
		}

		const images: string[] = []

		const textContent = toolResult.content
			.map((item: any) => {
				if (item.type === "text") {
					return item.text
				}
				if (item.type === "resource") {
					const { blob: _, ...rest } = item.resource
					return JSON.stringify(rest, null, 2)
				}
				if (item.type === "image") {
					// Handle image content (MCP image content has mimeType and data properties)
					if (item.mimeType && item.data) {
						if (item.data.startsWith("data:")) {
							images.push(item.data)
						} else {
							images.push(`data:${item.mimeType};base64,${item.data}`)
						}
					}
					return ""
				}
				return ""
			})
			.filter(Boolean)
			.join("\n\n")

		return { text: textContent, images }
	}

	private async executeToolAndProcessResult(
		task: UseMcpToolHost,
		serverName: string,
		toolName: string,
		parsedArguments: Record<string, unknown> | undefined,
		executionId: string,
		pushToolResult: (content: string | Array<any>) => void,
	): Promise<void> {
		await task.say("mcp_server_request_started")

		// Send started status
		await this.sendExecutionStatus(task, {
			executionId,
			status: "started",
			serverName,
			toolName,
		})

		const toolResult = await task.providerRef.deref()?.getMcpHub()?.callTool(serverName, toolName, parsedArguments)

		let toolResultPretty = "(No response)"
		let images: string[] = []

		if (toolResult) {
			const { text: outputText, images: extractedImages } = this.processToolContent(toolResult)
			images = extractedImages

			if (outputText || images.length > 0) {
				// この分岐に入る時点で `outputText` が空なら images.length > 0 が確定するため、
				// `images.length > 0 ? … : ""` の `: ""` は到達不能。素の画像枚数表現を右辺に置く。
				await this.sendExecutionStatus(task, {
					executionId,
					status: "output",
					response: outputText || `[${images.length} image(s)]`,
				})

				toolResultPretty =
					(toolResult.isError ? "Error:\n" : "") + (outputText || `[${images.length} image(s) received]`)
			}

			// Send completion status
			await this.sendExecutionStatus(task, {
				executionId,
				status: toolResult.isError ? "error" : "completed",
				response: toolResultPretty,
				error: toolResult.isError ? "Error executing MCP tool" : undefined,
			})
		} else {
			// Send error status if no result
			await this.sendExecutionStatus(task, {
				executionId,
				status: "error",
				error: "No response from MCP server",
			})
		}

		await task.say("mcp_server_response", toolResultPretty, images)
		pushToolResult(formatResponse.toolResult(toolResultPretty, images))
	}
}

export const useMcpToolTool = new UseMcpToolTool()
