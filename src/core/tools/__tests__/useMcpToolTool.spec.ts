// npx vitest core/tools/__tests__/useMcpToolTool.spec.ts

import { useMcpToolTool } from "../UseMcpToolTool"
import { Task } from "../../task/Task"
import { ToolUse } from "../../../shared/tools"
import { makeMockTask } from "../../task/__tests__/makeMockTask"

// Mock dependencies
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((result: string, images?: string[]) => {
			if (images && images.length > 0) {
				return `Tool result: ${result} [with ${images.length} image(s)]`
			}
			return `Tool result: ${result}`
		}),
		toolError: vi.fn((error: string) => `Tool error: ${error}`),
		invalidMcpToolArgumentError: vi.fn((server: string, tool: string) => `Invalid args for ${server}:${tool}`),
		unknownMcpToolError: vi.fn((server: string, tool: string, availableTools: string[]) => {
			const toolsList = availableTools.length > 0 ? availableTools.join(", ") : "No tools available"
			return `Tool '${tool}' does not exist on server '${server}'. Available tools: ${toolsList}`
		}),
		unknownMcpServerError: vi.fn((server: string, availableServers: string[]) => {
			const list = availableServers.length > 0 ? availableServers.join(", ") : "No servers available"
			return `Server '${server}' is not configured. Available servers: ${list}`
		}),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, params?: any) => {
		if (key === "mcp:errors.invalidJsonArgument" && params?.toolName) {
			return `Agent tried to use ${params.toolName} with an invalid JSON argument. Retrying...`
		}
		if (key === "mcp:errors.toolNotFound" && params) {
			return `Tool '${params.toolName}' does not exist on server '${params.serverName}'. Available tools: ${params.availableTools}`
		}
		if (key === "mcp:errors.serverNotFound" && params) {
			return `MCP server '${params.serverName}' is not configured. Available servers: ${params.availableServers}`
		}
		return key
	}),
}))

describe("useMcpToolTool", () => {
	let mockTask: Partial<Task>
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let mockPushToolResult: ReturnType<typeof vi.fn>
	let mockProviderRef: any

	beforeEach(() => {
		mockAskApproval = vi.fn()
		mockHandleError = vi.fn()
		mockPushToolResult = vi.fn()

		mockProviderRef = {
			deref: vi.fn().mockReturnValue({
				getMcpHub: vi.fn().mockReturnValue({
					callTool: vi.fn(),
					getAllServers: vi.fn().mockReturnValue([]),
				}),
				postMessageToWebview: vi.fn(),
			}),
		}

		mockTask = makeMockTask() as any
		// useMcpToolTool needs the MCP hub on the provider — override providerRef with the local mock
		mockTask.providerRef = mockProviderRef
		mockTask.sayAndCreateMissingParamError = vi.fn()
		mockTask.say = vi.fn()
		mockTask.ask = vi.fn()
		mockTask.askState!.lastMessageTs = 123456789
	})

	describe("parameter validation", () => {
		it("should handle missing server_name", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					tool_name: "test_tool",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "",
					tool_name: "test_tool",
					arguments: {},
				},
				partial: false,
			}

			mockTask.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing server_name error")

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("use_mcp_tool", "server_name")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing server_name error")
		})

		it("should handle missing tool_name", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "",
					arguments: {},
				},
				partial: false,
			}

			mockTask.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing tool_name error")

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("use_mcp_tool", "tool_name")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing tool_name error")
		})

		it("should handle invalid arguments type", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: "invalid json",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
					// Native-only: invalid arguments are rejected unless they are an object.
					arguments: [] as unknown as any,
				},
				partial: false,
			}

			// Mock server exists so we get to the JSON validation step
			const mockServers = [
				{
					name: "test_server",
					tools: [{ name: "test_tool", description: "Test Tool" }],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("invalid JSON argument"))
			expect(mockPushToolResult).toHaveBeenCalledWith("Tool error: Invalid args for test_server:test_tool")
		})
	})

	describe("partial requests", () => {
		it("should handle partial requests", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: "{}",
				},
				partial: true,
			}

			mockTask.ask = vi.fn().mockResolvedValue(true)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.ask).toHaveBeenCalledWith("use_mcp_server", expect.stringContaining("use_mcp_tool"), true)
		})
	})

	describe("successful execution", () => {
		it("should execute tool successfully with valid parameters", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: '{"param": "value"}',
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: { param: "value" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [{ type: "text", text: "Tool executed successfully" }],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "Tool executed successfully", [])
			expect(mockPushToolResult).toHaveBeenCalledWith("Tool result: Tool executed successfully")
		})

		it("should handle user rejection", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
					arguments: {},
				},
				partial: false,
			}

			// Ensure server/tool validation passes so we actually reach askApproval.
			mockProviderRef.deref.mockReturnValueOnce({
				getMcpHub: () => ({
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] },
						]),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			mockAskApproval.mockResolvedValue(false)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.say).not.toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(expect.stringContaining("Tool result:"))
		})
	})

	describe("error handling", () => {
		it("should handle unexpected errors", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test_server",
					tool_name: "test_tool",
				},
				nativeArgs: {
					server_name: "test_server",
					tool_name: "test_tool",
				},
				partial: false,
			}

			// Ensure validation passes so askApproval is reached and throws
			mockProviderRef.deref.mockReturnValueOnce({
				getMcpHub: () => ({
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "test_server", tools: [{ name: "test_tool", description: "desc" }] },
						]),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			const error = new Error("Unexpected error")
			mockAskApproval.mockRejectedValue(error)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledWith("executing MCP tool", error)
		})

		it("should reject unknown tool names", async () => {
			// Reset consecutiveMistakeCount for this test
			mockTask.mistakeTracker!.count = 0

			const mockServers = [
				{
					name: "test-server",
					tools: [
						{ name: "existing-tool-1", description: "Tool 1" },
						{ name: "existing-tool-2", description: "Tool 2" },
					],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "non-existing-tool",
					arguments: JSON.stringify({ test: "data" }),
				},
				nativeArgs: {
					server_name: "test-server",
					tool_name: "non-existing-tool",
					arguments: { test: "data" },
				},
				partial: false,
			}

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("does not exist"))
			// Check that the error message contains available tools
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("existing-tool-1"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("existing-tool-2"))
		})

		it("should handle server with no tools", async () => {
			// Reset consecutiveMistakeCount for this test
			mockTask.mistakeTracker!.count = 0

			const mockServers = [
				{
					name: "test-server",
					tools: [],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn(),
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "any-tool",
					arguments: JSON.stringify({ test: "data" }),
				},
				nativeArgs: {
					server_name: "test-server",
					tool_name: "any-tool",
					arguments: { test: "data" },
				},
				partial: false,
			}

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("does not exist"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("No tools available"))
		})

		it("should allow valid tool names", async () => {
			// Reset consecutiveMistakeCount for this test
			mockTask.mistakeTracker!.count = 0

			const mockServers = [
				{
					name: "test-server",
					tools: [{ name: "valid-tool", description: "Valid Tool" }],
				},
			]

			const mockToolResult = {
				content: [{ type: "text", text: "Tool executed successfully" }],
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: vi.fn().mockResolvedValue(mockToolResult),
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "valid-tool",
					arguments: JSON.stringify({ test: "data" }),
				},
				nativeArgs: {
					server_name: "test-server",
					tool_name: "valid-tool",
					arguments: { test: "data" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.tokenUsageTracker!.recordToolError).not.toHaveBeenCalled()
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "Tool executed successfully", [])
		})

		it("should reject unknown server names with available servers listed", async () => {
			// Arrange
			mockTask.mistakeTracker!.count = 0

			const mockServers = [{ name: "s1", tools: [] }]
			const callToolMock = vi.fn()

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: callToolMock,
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: {},
				},
				partial: false,
			}

			// Act
			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Assert
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("not configured"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("s1"))
			expect(callToolMock).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
		})

		it("should reject unknown server names when no servers are available", async () => {
			// Arrange
			mockTask.mistakeTracker!.count = 0

			const callToolMock = vi.fn()
			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue([]),
					callTool: callToolMock,
				}),
				postMessageToWebview: vi.fn(),
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "unknown",
					tool_name: "any-tool",
					arguments: {},
				},
				partial: false,
			}

			// Act
			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Assert
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("not configured"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("No servers available"))
			expect(callToolMock).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
		})

		it("should match tool names using fuzzy matching (hyphens vs underscores)", async () => {
			// This tests the scenario where models mangle hyphens to underscores
			// e.g., model sends "get_user_profile" but actual tool name is "get-user-profile"
			mockTask.mistakeTracker!.count = 0

			const callToolMock = vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "Success" }],
			})

			const mockServers = [
				{
					name: "test-server",
					tools: [{ name: "get-user-profile", description: "Gets a user profile" }],
				},
			]

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					getAllServers: vi.fn().mockReturnValue(mockServers),
					callTool: callToolMock,
				}),
				postMessageToWebview: vi.fn(),
			})

			// Model sends the mangled version with underscores
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "test-server",
					tool_name: "get_user_profile", // Model mangled hyphens to underscores
					arguments: "{}",
				},
				nativeArgs: {
					server_name: "test-server",
					tool_name: "get_user_profile", // Model mangled hyphens to underscores
					arguments: {},
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Tool should be found and executed
			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.tokenUsageTracker!.recordToolError).not.toHaveBeenCalled()
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")

			// The original tool name (with hyphens) should be passed to callTool
			expect(callToolMock).toHaveBeenCalledWith("test-server", "get-user-profile", {})
		})
	})

	describe("image handling", () => {
		it("should handle tool response with image content", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "figma-server",
					tool_name: "get_screenshot",
					arguments: '{"nodeId": "123"}',
				},
				nativeArgs: {
					server_name: "figma-server",
					tool_name: "get_screenshot",
					arguments: { nodeId: "123" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [
					{
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
					},
				],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
					getAllServers: vi.fn().mockReturnValue([
						{
							name: "figma-server",
							tools: [{ name: "get_screenshot", description: "Get screenshot" }],
						},
					]),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "[1 image(s) received]", [
				"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
			])
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("with 1 image(s)"))
		})

		it("should handle tool response with both text and image content", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "figma-server",
					tool_name: "get_node_info",
					arguments: '{"nodeId": "123"}',
				},
				nativeArgs: {
					server_name: "figma-server",
					tool_name: "get_node_info",
					arguments: { nodeId: "123" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [
					{ type: "text", text: "Node name: Button" },
					{
						type: "image",
						mimeType: "image/png",
						data: "base64imagedata",
					},
				],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
					getAllServers: vi
						.fn()
						.mockReturnValue([
							{ name: "figma-server", tools: [{ name: "get_node_info", description: "Get node info" }] },
						]),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "Node name: Button", [
				"data:image/png;base64,base64imagedata",
			])
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("with 1 image(s)"))
		})

		it("should handle image with data URL already formatted", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "figma-server",
					tool_name: "get_screenshot",
					arguments: '{"nodeId": "123"}',
				},
				nativeArgs: {
					server_name: "figma-server",
					tool_name: "get_screenshot",
					arguments: { nodeId: "123" },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [
					{
						type: "image",
						mimeType: "image/jpeg",
						data: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
					},
				],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
					getAllServers: vi.fn().mockReturnValue([
						{
							name: "figma-server",
							tools: [{ name: "get_screenshot", description: "Get screenshot" }],
						},
					]),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should not double-prefix the data URL
			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "[1 image(s) received]", [
				"data:image/jpeg;base64,/9j/4AAQSkZJRg==",
			])
		})

		it("should handle multiple images in response", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "use_mcp_tool",
				params: {
					server_name: "figma-server",
					tool_name: "get_screenshots",
					arguments: '{"nodeIds": ["1", "2"]}',
				},
				nativeArgs: {
					server_name: "figma-server",
					tool_name: "get_screenshots",
					arguments: { nodeIds: ["1", "2"] },
				},
				partial: false,
			}

			mockAskApproval.mockResolvedValue(true)

			const mockToolResult = {
				content: [
					{
						type: "image",
						mimeType: "image/png",
						data: "image1data",
					},
					{
						type: "image",
						mimeType: "image/png",
						data: "image2data",
					},
				],
				isError: false,
			}

			mockProviderRef.deref.mockReturnValue({
				getMcpHub: () => ({
					callTool: vi.fn().mockResolvedValue(mockToolResult),
					getAllServers: vi.fn().mockReturnValue([
						{
							name: "figma-server",
							tools: [{ name: "get_screenshots", description: "Get screenshots" }],
						},
					]),
				}),
				postMessageToWebview: vi.fn(),
			})

			await useMcpToolTool.handle(mockTask as Task, block as any, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.say).toHaveBeenCalledWith("mcp_server_response", "[2 image(s) received]", [
				"data:image/png;base64,image1data",
				"data:image/png;base64,image2data",
			])
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("with 2 image(s)"))
		})
	})
})

// ---------------------------------------------------------------------------
// 追加スイート: 検証フォールバック・無効ツール・結果整形（resource/image/未知型/
// 空応答/isError）・executionId フォールバックを網羅。
// 「無効ツール・検証失敗系では callTool へ到達しない」不変条件を固定する。
// ---------------------------------------------------------------------------

describe("useMcpToolTool - 検証フォールバック/結果整形/無効ツール", () => {
	let task: any
	let askApproval: ReturnType<typeof vi.fn>
	let handleError: ReturnType<typeof vi.fn>
	let pushToolResult: ReturnType<typeof vi.fn>
	let callTool: ReturnType<typeof vi.fn>
	let postMessageToWebview: ReturnType<typeof vi.fn>

	const cbs = () => ({ askApproval, handleError, pushToolResult })

	const makeBlock = (server: string, tool: string, args?: Record<string, unknown> | unknown): ToolUse => ({
		type: "tool_use",
		name: "use_mcp_tool",
		params: { server_name: server, tool_name: tool, arguments: args as any },
		nativeArgs: { server_name: server, tool_name: tool, arguments: args as any },
		partial: false,
	})

	/** provider を差し替える。getMcpHub の戻り値はテストごとに指定。 */
	const wireHub = (hub: unknown) => {
		task.providerRef = {
			deref: vi.fn().mockReturnValue({
				getMcpHub: vi.fn().mockReturnValue(hub),
				postMessageToWebview,
			}),
		}
	}

	beforeEach(() => {
		askApproval = vi.fn().mockResolvedValue(true)
		handleError = vi.fn()
		pushToolResult = vi.fn()
		callTool = vi.fn()
		postMessageToWebview = vi.fn()

		task = makeMockTask() as any
		task.sayAndCreateMissingParamError = vi.fn()
		task.say = vi.fn()
		task.ask = vi.fn().mockResolvedValue(undefined)
		task.askState.lastMessageTs = 999
	})

	it("MCP hub が取得できないときは検証をスキップして実行へ進み、応答無しなら (No response)", async () => {
		// getMcpHub() が undefined → validateToolExists は isValid:true を返す（resolvedToolName 無し）
		wireHub(undefined)

		// arguments なし → completeMessage の arguments は undefined 分岐
		await useMcpToolTool.execute(makeBlock("srv", "tool").nativeArgs as any, task, cbs())

		expect(askApproval).toHaveBeenCalled()
		expect(task.say).toHaveBeenCalledWith("mcp_server_request_started")
		// callTool へ到達できない（hub 無し）ので (No response)
		expect(task.say).toHaveBeenCalledWith("mcp_server_response", "(No response)", [])
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("(No response)"))
	})

	it("無効化ツール（他に有効ツールあり）は callTool へ到達しない", async () => {
		wireHub({
			getAllServers: vi.fn().mockReturnValue([
				{
					name: "srv",
					tools: [
						{ name: "old-tool", enabledForPrompt: false },
						{ name: "new-tool", enabledForPrompt: true },
					],
				},
			]),
			callTool,
		})

		await useMcpToolTool.execute(makeBlock("srv", "old-tool", {}).nativeArgs as any, task, cbs())

		expect(task.mistakeTracker.count).toBe(1)
		expect(task.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
		expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("toolDisabled"))
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("new-tool"))
		expect(callTool).not.toHaveBeenCalled()
		expect(askApproval).not.toHaveBeenCalled()
	})

	it("無効化ツール（有効ツールが 1 つも無い）でも callTool へ到達しない", async () => {
		wireHub({
			getAllServers: vi
				.fn()
				.mockReturnValue([{ name: "srv", tools: [{ name: "only-tool", enabledForPrompt: false }] }]),
			callTool,
		})

		await useMcpToolTool.execute(makeBlock("srv", "only-tool", {}).nativeArgs as any, task, cbs())

		expect(task.mistakeTracker.count).toBe(1)
		expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("toolDisabled"))
		// 有効ツールが無いので tool_result は "No tools available" 側になる
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No tools available"))
		expect(callTool).not.toHaveBeenCalled()
		expect(askApproval).not.toHaveBeenCalled()
	})

	it("検証中に例外が起きても実行はブロックせず、console.error して継続する", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		wireHub({
			getAllServers: vi.fn(() => {
				throw new Error("hub boom")
			}),
			callTool: callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
		})

		await useMcpToolTool.execute(makeBlock("srv", "tool", { a: 1 }).nativeArgs as any, task, cbs())

		expect(errSpy).toHaveBeenCalledWith("Error validating MCP tool existence:", expect.any(Error))
		expect(askApproval).toHaveBeenCalled()
		expect(callTool).toHaveBeenCalledWith("srv", "tool", { a: 1 })
		errSpy.mockRestore()
	})

	describe("結果整形（processToolContent / executeToolAndProcessResult）", () => {
		const wireValidTool = (result: unknown) => {
			wireHub({
				getAllServers: vi.fn().mockReturnValue([{ name: "srv", tools: [{ name: "tool" }] }]),
				callTool: callTool.mockResolvedValue(result),
			})
		}

		it("content が空配列なら (No response) を返す", async () => {
			wireValidTool({ content: [], isError: false })

			await useMcpToolTool.execute(makeBlock("srv", "tool", {}).nativeArgs as any, task, cbs())

			expect(task.say).toHaveBeenCalledWith("mcp_server_response", "(No response)", [])
			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("(No response)"))
		})

		it("isError=true のとき Error: プレフィックス付きで返す", async () => {
			wireValidTool({ content: [{ type: "text", text: "爆発" }], isError: true })

			await useMcpToolTool.execute(makeBlock("srv", "tool", {}).nativeArgs as any, task, cbs())

			expect(task.say).toHaveBeenCalledWith("mcp_server_response", "Error:\n爆発", [])
		})

		it("resource 型コンテンツは blob を除いて JSON 整形する", async () => {
			wireValidTool({
				content: [{ type: "resource", resource: { blob: "SECRET", uri: "mcp://res/1", mime: "text/plain" } }],
				isError: false,
			})

			await useMcpToolTool.execute(makeBlock("srv", "tool", {}).nativeArgs as any, task, cbs())

			const [, text] = task.say.mock.calls.find((c: any[]) => c[0] === "mcp_server_response")!
			expect(text).toContain("mcp://res/1")
			expect(text).not.toContain("SECRET")
		})

		it("未知型・data 無し image はどちらも空文字になり (No response) に畳まれる", async () => {
			wireValidTool({
				content: [
					{ type: "audio", data: "xxx" }, // 未知型 → ""
					{ type: "image" }, // mimeType/data 無し → ""
				],
				isError: false,
			})

			await useMcpToolTool.execute(makeBlock("srv", "tool", {}).nativeArgs as any, task, cbs())

			expect(task.say).toHaveBeenCalledWith("mcp_server_response", "(No response)", [])
		})
	})

	it("askState.lastMessageTs が無いときは Date.now() を executionId に使い実行できる", async () => {
		task.askState.lastMessageTs = undefined
		wireHub({
			getAllServers: vi.fn().mockReturnValue([{ name: "srv", tools: [{ name: "tool" }] }]),
			callTool: callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
		})

		await useMcpToolTool.execute(makeBlock("srv", "tool", {}).nativeArgs as any, task, cbs())

		expect(task.say).toHaveBeenCalledWith("mcp_server_request_started")
		expect(callTool).toHaveBeenCalledWith("srv", "tool", {})
	})

	it("partial: server_name/tool_name が未定義でも空文字で ask を組み立てる", async () => {
		const block: ToolUse = {
			type: "tool_use",
			name: "use_mcp_tool",
			params: { arguments: { a: 1 } } as any,
			partial: true,
		}

		await useMcpToolTool.handle(task as Task, block as any, cbs())

		const [, payload, partialFlag] = task.ask.mock.calls[0]
		const parsed = JSON.parse(payload as string)
		expect(parsed.serverName).toBe("")
		expect(parsed.toolName).toBe("")
		expect(partialFlag).toBe(true)
	})

	describe("arguments 型検証", () => {
		it("arguments が null なら invalid として弾き、callTool へ到達しない", async () => {
			wireHub({
				getAllServers: vi.fn().mockReturnValue([{ name: "srv", tools: [{ name: "tool" }] }]),
				callTool,
			})

			await useMcpToolTool.execute({ server_name: "srv", tool_name: "tool", arguments: null } as any, task, cbs())

			expect(task.mistakeTracker.count).toBe(1)
			expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("invalid JSON argument"))
			expect(callTool).not.toHaveBeenCalled()
			expect(askApproval).not.toHaveBeenCalled()
		})

		it("arguments が非オブジェクト（文字列）なら invalid として弾く", async () => {
			wireHub({
				getAllServers: vi.fn().mockReturnValue([{ name: "srv", tools: [{ name: "tool" }] }]),
				callTool,
			})

			await useMcpToolTool.execute(
				{ server_name: "srv", tool_name: "tool", arguments: "just a string" } as any,
				task,
				cbs(),
			)

			expect(task.mistakeTracker.count).toBe(1)
			expect(callTool).not.toHaveBeenCalled()
			expect(askApproval).not.toHaveBeenCalled()
		})
	})
})
