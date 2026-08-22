import { describe, it, expect, vi, beforeEach } from "vitest"
import { runSlashCommandTool } from "../RunSlashCommandTool"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import { getCommand, getCommandNames } from "../../../services/command/commands"
import type { ToolUse } from "../../../shared/tools"
import { makeMockTask } from "../../task/__tests__/makeMockTask"

// Mock dependencies
vi.mock("../../../services/command/commands", () => ({
	getCommand: vi.fn(),
	getCommandNames: vi.fn(),
}))

describe("runSlashCommandTool", () => {
	let mockTask: any
	let mockCallbacks: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockTask = makeMockTask({
			cwd: "/test/project",
			providerState: {
				experiments: {
					runSlashCommand: true,
				},
			},
		}) as any
		// runSlashCommand needs getSkillsManager on the provider — add it to the default provider
		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({
				experiments: {
					runSlashCommand: true,
				},
			}),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		})

		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	it("should handle missing command parameter", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "",
			},
		}

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.mistakeTracker!.count).toBe(1)
		expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("run_slash_command")
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("run_slash_command", "command")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
	})

	it("should handle command not found", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "nonexistent",
			},
		}

		vi.mocked(getCommand).mockResolvedValue(undefined)
		vi.mocked(getCommandNames).mockResolvedValue(["init", "test", "deploy"])

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("run_slash_command")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Command 'nonexistent' not found. Available commands: init, test, deploy"),
		)
	})

	it("should fallback to skill content when command is missing and matching skill exists", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "skill-only",
				args: "target flow",
			},
		}

		const getSkillContent = vi.fn().mockResolvedValue({
			name: "skill-only",
			description: "Skill-generated command",
			path: "/mock/.agent/skills/skill-only/SKILL.md",
			source: "project" as const,
			instructions: "Use skill workflow",
		})

		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({
				experiments: {
					runSlashCommand: true,
				},
				mode: "code",
			}),
			getSkillsManager: vi.fn().mockReturnValue({
				getSkillContent,
			}),
		})

		vi.mocked(getCommand).mockResolvedValue(undefined)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(getSkillContent).toHaveBeenCalledWith("skill-only", "code")
		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "skill-only",
				args: "target flow",
				source: "project",
				description: "Skill-generated command",
			}),
		)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: skill-only
Description: Skill-generated command
Provided arguments: target flow
Source: project

--- Skill Instructions ---

Use skill workflow`,
		)
		expect(mockTask.tokenUsageTracker!.recordToolError).not.toHaveBeenCalledWith("run_slash_command")
		expect(getCommandNames).not.toHaveBeenCalled()
	})

	it("should preserve command precedence over skill fallback", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "setup",
			},
		}

		const mockCommand = {
			name: "setup",
			content: "Command content",
			source: "project" as const,
			filePath: ".agent/commands/setup.md",
			description: "Real command",
		}

		const getSkillContent = vi.fn().mockResolvedValue({
			name: "setup",
			description: "Setup skill",
			path: "/mock/.agent/skills/setup/SKILL.md",
			source: "project" as const,
			instructions: "Skill should not run",
		})

		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({
				experiments: {
					runSlashCommand: true,
				},
				mode: "code",
			}),
			getSkillsManager: vi.fn().mockReturnValue({
				getSkillContent,
			}),
		})

		vi.mocked(getCommand).mockResolvedValue(mockCommand)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(getSkillContent).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Command: /setup
Description: Real command
Source: project

--- Command Content ---

Command content`,
		)
	})

	it("should handle user rejection", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "init",
			},
		}

		const mockCommand = {
			name: "init",
			content: "Initialize project",
			source: "built-in" as const,
			filePath: "<built-in:init>",
			description: "Initialize the project",
		}

		vi.mocked(getCommand).mockResolvedValue(mockCommand)
		mockCallbacks.askApproval.mockResolvedValue(false)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should successfully execute built-in command", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "init",
			},
		}

		const mockCommand = {
			name: "init",
			content: "Initialize project content here",
			source: "built-in" as const,
			filePath: "<built-in:init>",
			description: "Analyze codebase and create AGENTS.md",
		}

		vi.mocked(getCommand).mockResolvedValue(mockCommand)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "runSlashCommand",
				command: "init",
				args: undefined,
				source: "built-in",
				description: "Analyze codebase and create AGENTS.md",
			}),
		)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Command: /init
Description: Analyze codebase and create AGENTS.md
Source: built-in

--- Command Content ---

Initialize project content here`,
		)
	})

	it("should successfully execute command with arguments", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "test",
				args: "focus on unit tests",
			},
		}

		const mockCommand = {
			name: "test",
			content: "Run tests with specific focus",
			source: "project" as const,
			filePath: ".agent/commands/test.md",
			description: "Run project tests",
			argumentHint: "test type or focus area",
		}

		vi.mocked(getCommand).mockResolvedValue(mockCommand)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Command: /test
Description: Run project tests
Argument hint: test type or focus area
Provided arguments: focus on unit tests
Source: project

--- Command Content ---

Run tests with specific focus`,
		)
	})

	it("should handle global command", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "deploy",
			},
		}

		const mockCommand = {
			name: "deploy",
			content: "Deploy application to production",
			source: "global" as const,
			filePath: "~/.agent/commands/deploy.md",
		}

		vi.mocked(getCommand).mockResolvedValue(mockCommand)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Command: /deploy
Source: global

--- Command Content ---

Deploy application to production`,
		)
	})

	it("should handle partial block", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {
				command: "init",
				args: "",
			},
			partial: true,
		}

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.ask).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "runSlashCommand",
				command: "init",
				args: "",
			}),
			true,
		)

		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should handle errors during execution", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "init",
			},
		}

		const error = new Error("Test error")
		vi.mocked(getCommand).mockRejectedValue(error)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.handleError).toHaveBeenCalledWith("running slash command", error)
	})

	it("should handle empty available commands list", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "nonexistent",
			},
		}

		vi.mocked(getCommand).mockResolvedValue(undefined)
		vi.mocked(getCommandNames).mockResolvedValue([])

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Command 'nonexistent' not found. Available commands: (none)"),
		)
	})

	it("should reset consecutive mistake count on valid command", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "init",
			},
		}

		mockTask.mistakeTracker!.count = 5

		const mockCommand = {
			name: "init",
			content: "Initialize project",
			source: "built-in" as const,
			filePath: "<built-in:init>",
		}

		vi.mocked(getCommand).mockResolvedValue(mockCommand)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.mistakeTracker!.count).toBe(0)
	})

	it("should switch mode when mode is specified in command", async () => {
		const mockHandleModeSwitch = vi.fn()
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "debug-app",
			},
		}

		const mockCommand = {
			name: "debug-app",
			content: "Start debugging the application",
			source: "project" as const,
			filePath: ".agent/commands/debug-app.md",
			description: "Debug the application",
			mode: "code",
		}

		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({
				experiments: {
					runSlashCommand: true,
				},
				customModes: undefined,
			}),
			handleModeSwitch: mockHandleModeSwitch,
		})

		vi.mocked(getCommand).mockResolvedValue(mockCommand)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockHandleModeSwitch).toHaveBeenCalledWith("code")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Command: /debug-app
Description: Debug the application
Mode: code
Source: project

--- Command Content ---

Start debugging the application`,
		)
	})

	it("should not switch mode when mode is not specified in command", async () => {
		const mockHandleModeSwitch = vi.fn()
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "test",
			},
		}

		const mockCommand = {
			name: "test",
			content: "Run tests",
			source: "project" as const,
			filePath: ".agent/commands/test.md",
			description: "Run project tests",
		}

		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({
				experiments: {
					runSlashCommand: true,
				},
				customModes: undefined,
			}),
			handleModeSwitch: mockHandleModeSwitch,
		})

		vi.mocked(getCommand).mockResolvedValue(mockCommand)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockHandleModeSwitch).not.toHaveBeenCalled()
	})

	it("実験機能が無効なら getCommand を呼ばず案内だけ返す", async () => {
		// RUN_SLASH_COMMAND 実験が切られている状態。副作用ゼロで案内文のみ。
		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({ experiments: {} }),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		})

		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: { command: "init" },
		}

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(getCommand).not.toHaveBeenCalled()
		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		const msg = String(mockCallbacks.pushToolResult.mock.calls[0][0])
		expect(msg).toContain("experimental feature")
	})

	it("getState が undefined でも experiments 空として無効扱いにする", async () => {
		// state が取れない（provider 初期化前など）。state?.experiments ?? {} に落ち、無効扱い。
		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue(undefined),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		})

		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: { command: "init" },
		}

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(getCommand).not.toHaveBeenCalled()
		expect(String(mockCallbacks.pushToolResult.mock.calls[0][0])).toContain("experimental feature")
	})

	it("skill フォールバックで承認されなければ結果を出さない", async () => {
		const getSkillContent = vi.fn().mockResolvedValue({
			name: "skill-only",
			description: "Skill",
			path: "/mock/.agent/skills/skill-only/SKILL.md",
			source: "project" as const,
			instructions: "Use skill workflow",
		})
		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({
				experiments: { runSlashCommand: true },
				mode: "code",
			}),
			getSkillsManager: vi.fn().mockReturnValue({ getSkillContent }),
		})
		vi.mocked(getCommand).mockResolvedValue(undefined)
		mockCallbacks.askApproval.mockResolvedValue(false)

		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: { command: "skill-only" },
		}

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("不変条件：区切り／.. を含む名前もツールはパスを組まず getCommand へそのまま渡す", async () => {
		// command 名はモデル由来（外部入力）。ツール自身は fs パスを一切組み立てず、
		// 名前検索を getCommand / getSkillContent に丸投げする。ここでは「素通し」を固定し、
		// 見つからなければ traversal ではなく "not found" に落ちることを確認する。
		const malicious = "../../../../etc/passwd"
		const getSkillContent = vi.fn().mockResolvedValue(null)
		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({
				experiments: { runSlashCommand: true },
				mode: "code",
			}),
			getSkillsManager: vi.fn().mockReturnValue({ getSkillContent }),
		})
		vi.mocked(getCommand).mockResolvedValue(undefined)
		vi.mocked(getCommandNames).mockResolvedValue([])

		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: { command: malicious },
		}

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		// cwd と名前をそのまま渡す（ツール側で結合・正規化しない）。
		expect(getCommand).toHaveBeenCalledWith("/test/project", malicious)
		expect(getSkillContent).toHaveBeenCalledWith(malicious, "code")
		// 承認要求は出さず、未検出として扱う。
		expect(mockCallbacks.askApproval).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError(`Command '${malicious}' not found. Available commands: (none)`),
		)
	})

	it("should include mode in askApproval message when mode is specified", async () => {
		const block: ToolUse<"run_slash_command"> = {
			type: "tool_use" as const,
			name: "run_slash_command" as const,
			params: {},
			partial: false,
			nativeArgs: {
				command: "debug-app",
			},
		}

		const mockCommand = {
			name: "debug-app",
			content: "Start debugging",
			source: "project" as const,
			filePath: ".agent/commands/debug-app.md",
			description: "Debug the application",
			mode: "code",
		}

		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({
				experiments: {
					runSlashCommand: true,
				},
				customModes: undefined,
			}),
			handleModeSwitch: vi.fn(),
		})

		vi.mocked(getCommand).mockResolvedValue(mockCommand)

		await runSlashCommandTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "runSlashCommand",
				command: "debug-app",
				args: undefined,
				source: "project",
				description: "Debug the application",
				mode: "code",
			}),
		)
	})
})
