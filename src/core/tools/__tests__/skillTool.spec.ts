import { describe, it, expect, vi, beforeEach } from "vitest"
import { skillTool } from "../SkillTool"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import type { ToolUse } from "../../../shared/tools"
import { makeMockTask } from "../../task/__tests__/makeMockTask"

describe("skillTool", () => {
	let mockTask: any
	let mockCallbacks: any
	let mockSkillsManager: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockSkillsManager = {
			getSkillContent: vi.fn(),
			getSkillsForMode: vi.fn().mockReturnValue([]),
		}

		mockTask = makeMockTask({
			providerState: { mode: "code" },
		}) as any
		// skillTool needs getSkillsManager on the provider — override with test-specific manager
		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			getSkillsManager: vi.fn().mockReturnValue(mockSkillsManager),
		})

		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	it("should handle missing skill parameter", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "",
			},
		}

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.mistakeTracker!.count).toBe(1)
		expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("skill")
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("skill", "skill")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
	})

	it("should handle skill not found", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "non-existent",
			},
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(null)
		mockSkillsManager.getSkillsForMode.mockReturnValue([{ name: "create-mcp-server" }])

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skill 'non-existent' not found. Available skills: create-mcp-server"),
		)
	})

	it("should handle empty available skills list", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "non-existent",
			},
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(null)
		mockSkillsManager.getSkillsForMode.mockReturnValue([])

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skill 'non-existent' not found. Available skills: (none)"),
		)
	})

	it("should successfully load a global skill", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		const mockSkillContent = {
			name: "create-mcp-server",
			description: "Instructions for creating MCP servers",
			source: "global",
			instructions: "Step 1: Create the server...",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "create-mcp-server",
				args: undefined,
				source: "global",
				description: "Instructions for creating MCP servers",
			}),
		)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: create-mcp-server
Description: Instructions for creating MCP servers
Source: global

--- Skill Instructions ---

Step 1: Create the server...`,
		)
	})

	it("should successfully load skill with arguments", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
				args: "weather API server",
			},
		}

		const mockSkillContent = {
			name: "create-mcp-server",
			description: "Instructions for creating MCP servers",
			source: "global",
			instructions: "Step 1: Create the server...",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: create-mcp-server
Description: Instructions for creating MCP servers
Provided arguments: weather API server
Source: global

--- Skill Instructions ---

Step 1: Create the server...`,
		)
	})

	it("should handle user rejection", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		mockSkillsManager.getSkillContent.mockResolvedValue({
			name: "create-mcp-server",
			description: "Test",
			source: "global",
			instructions: "Test instructions",
		})

		mockCallbacks.askApproval.mockResolvedValue(false)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should handle partial block", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {
				skill: "create-mcp-server",
				args: "",
			},
			partial: true,
		}

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.ask).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "create-mcp-server",
				args: "",
			}),
			true,
		)

		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should handle errors during execution", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		const error = new Error("Test error")
		mockSkillsManager.getSkillContent.mockRejectedValue(error)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.handleError).toHaveBeenCalledWith("executing skill", error)
	})

	it("should reset consecutive mistake count on valid skill", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		mockTask.mistakeTracker!.count = 5

		const mockSkillContent = {
			name: "create-mcp-server",
			description: "Test",
			source: "global",
			instructions: "Test instructions",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.mistakeTracker!.count).toBe(0)
	})

	it("should handle Skills Manager not available", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		})

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("skill")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skills Manager not available"),
		)
	})

	it("provider の state が無ければモードは既定（code）で解決する", async () => {
		// getState が undefined を返す＝mode 不明。currentMode は "code" に落ちる。
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: { skill: "create-mcp-server" },
		}

		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue(undefined),
			getSkillsManager: vi.fn().mockReturnValue(mockSkillsManager),
		})
		mockSkillsManager.getSkillContent.mockResolvedValue({
			name: "create-mcp-server",
			description: "Test",
			source: "global",
			instructions: "Test instructions",
		})

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockSkillsManager.getSkillContent).toHaveBeenCalledWith("create-mcp-server", "code")
	})

	it("不変条件：区切り／.. を含む名前もツールはパスを組まず getSkillContent へそのまま渡す", async () => {
		// skill 名はモデル由来（外部入力）。ツールは fs パスを組み立てず、名前照合を
		// SkillsManager へ丸投げする。未登録なら traversal ではなく "not found" に落ちる。
		const malicious = "../../../../etc/passwd"
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: { skill: malicious },
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(null)
		mockSkillsManager.getSkillsForMode.mockReturnValue([])

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		// 名前は素通し（結合・正規化なし）。
		expect(mockSkillsManager.getSkillContent).toHaveBeenCalledWith(malicious, "code")
		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError(`Skill '${malicious}' not found. Available skills: (none)`),
		)
	})

	it("should load project skill", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "my-project-skill",
			},
		}

		const mockSkillContent = {
			name: "my-project-skill",
			description: "A custom project skill",
			source: "project",
			instructions: "Follow these project-specific instructions...",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "my-project-skill",
				args: undefined,
				source: "project",
				description: "A custom project skill",
			}),
		)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: my-project-skill
Description: A custom project skill
Source: project

--- Skill Instructions ---

Follow these project-specific instructions...`,
		)
	})
})
