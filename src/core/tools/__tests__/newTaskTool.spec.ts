// npx vitest core/tools/__tests__/newTaskTool.spec.ts

import type { AskApproval, HandleError, NativeToolArgs, ToolUse } from "../../../shared/tools"

// Mock vscode module
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
	},
}))

// Mock Package module
vi.mock("../../../shared/package", () => ({
	Package: {
		name: "openai-agent",
		publisher: "internal",
		version: "1.0.0",
		outputChannel: "OpenAI-Agent",
	},
}))

// Mock other modules first - these are hoisted to the top
vi.mock("../../../shared/modes", () => ({
	getModeBySlug: vi.fn(),
	defaultModeSlug: "ask",
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Tool Error: ${msg}`),
	},
}))

// 注意: 実インポートは "../UpdateTodoListTool"（大文字始まり）。case-sensitive な
// Linux fs では小文字 "../updateTodoListTool" への mock は適用されず、これまで実関数が
// 走っていた（出力がたまたま互換だったため露見しなかった）。正しい casing に修正する。
vi.mock("../UpdateTodoListTool", () => ({
	parseMarkdownChecklist: vi.fn((md: string) => {
		// Simple mock implementation
		const lines = md.split("\n").filter((line) => line.trim())
		return lines.map((line, index) => {
			let status = "pending"
			let content = line

			if (line.includes("[x]") || line.includes("[X]")) {
				status = "completed"
				content = line.replace(/^\[x\]\s*/i, "")
			} else if (line.includes("[-]") || line.includes("[~]")) {
				status = "in_progress"
				content = line.replace(/^\[-\]\s*/, "").replace(/^\[~\]\s*/, "")
			} else {
				content = line.replace(/^\[\s*\]\s*/, "")
			}

			return {
				id: `todo-${index}`,
				content,
				status,
			}
		})
	}),
}))

// Define a minimal type for the resolved value
type MockClineInstance = { taskId: string }

// Mock dependencies after modules are mocked
const mockAskApproval = vi.fn<AskApproval>()
const mockHandleError = vi.fn<HandleError>()
const mockPushToolResult = vi.fn()
const mockEmit = vi.fn()
const mockRecordToolError = vi.fn()
const mockSayAndCreateMissingParamError = vi.fn()
const mockStartSubtask = vi
	.fn<(message: string, todoItems: any[], mode: string) => Promise<MockClineInstance>>()
	.mockResolvedValue({ taskId: "mock-subtask-id" })

// Adapter to satisfy legacy expectations while exercising new delegation path
const mockDelegateParentAndOpenChild = vi.fn(
	async (args: { parentTaskId: string; message: string; initialTodos: any[]; mode: string }) => {
		// Call legacy spy so existing expectations still pass
		await mockStartSubtask(args.message, args.initialTodos, args.mode)
		return { taskId: "child-1" }
	},
)
const mockCheckpointSave = vi.fn()

// Mock the Cline instance and its methods/properties
const mockCline = {
	ask: vi.fn(),
	sayAndCreateMissingParamError: mockSayAndCreateMissingParamError,
	emit: mockEmit,
	tokenUsageTracker: { recordToolError: mockRecordToolError, recordToolUsage: vi.fn() } as any,
	mistakeTracker: { count: 0 } as any,
	stream: { didToolFailInCurrentTurn: false } as any,
	isPaused: false,
	pausedModeSlug: "ask",
	taskId: "mock-parent-task-id",
	enableCheckpoints: false,
	checkpointSave: mockCheckpointSave,
	startSubtask: mockStartSubtask,
	providerRef: {
		deref: vi.fn(() => ({
			getState: vi.fn(() => ({ customModes: [], mode: "ask" })),
			handleModeSwitch: vi.fn(),
			delegateParentAndOpenChild: mockDelegateParentAndOpenChild,
		})),
	},
}

// Import the class to test AFTER mocks are set up
import { newTaskTool } from "../NewTaskTool"
import { getModeBySlug } from "../../../shared/modes"
import { parseMarkdownChecklist } from "../UpdateTodoListTool"
import * as vscode from "vscode"

const withNativeArgs = (block: ToolUse<"new_task">): ToolUse<"new_task"> => ({
	...block,
	// Native tool calling: `nativeArgs` is the source of truth for tool execution.
	// These tests intentionally exercise missing-param behavior, so we allow undefined
	// values and let the tool's runtime validation handle it.
	nativeArgs: {
		mode: block.params.mode,
		message: block.params.message,
		todos: block.params.todos,
	} as unknown as NativeToolArgs["new_task"],
})

describe("newTaskTool", () => {
	beforeEach(() => {
		// Reset mocks before each test
		vi.clearAllMocks()
		mockAskApproval.mockResolvedValue(true) // Default to approved
		vi.mocked(getModeBySlug).mockReturnValue({
			slug: "code",
			name: "Code Mode",
			roleDefinition: "Test role definition",
			groups: ["command", "read", "edit"],
		}) // Default valid mode
		mockCline.mistakeTracker!.count = 0
		mockCline.isPaused = false
		// Default: VSCode setting is disabled
		const mockGet = vi.fn().mockReturnValue(false)
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: mockGet,
		} as any)
	})

	it("should correctly un-escape \\\\@ to \\@ in the message passed to the new task", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use", // Add required 'type' property
			name: "new_task", // Correct property name
			params: {
				mode: "code",
				message: "Review this: \\\\@file1.txt and also \\\\\\\\@file2.txt", // Input with \\@ and \\\\@
				todos: "[ ] First task\n[ ] Second task",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// Verify askApproval was called
		expect(mockAskApproval).toHaveBeenCalled()

		// Verify the message passed to startSubtask reflects the code's behavior in unit tests
		expect(mockStartSubtask).toHaveBeenCalledWith(
			"Review this: \\@file1.txt and also \\\\\\@file2.txt", // Unit Test Expectation: \\@ -> \@, \\\\@ -> \\\\@
			expect.arrayContaining([
				expect.objectContaining({ content: "First task" }),
				expect.objectContaining({ content: "Second task" }),
			]),
			"code",
		)

		// Verify side effects
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
	})

	it("should not un-escape single escaped @", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use", // Add required 'type' property
			name: "new_task", // Correct property name
			params: {
				mode: "code",
				message: "This is already unescaped: \\@file1.txt",
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockStartSubtask).toHaveBeenCalledWith(
			"This is already unescaped: \\@file1.txt", // Expected: \@ remains \@
			expect.any(Array),
			"code",
		)
	})

	it("should not un-escape non-escaped @", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use", // Add required 'type' property
			name: "new_task", // Correct property name
			params: {
				mode: "code",
				message: "A normal mention @file1.txt",
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockStartSubtask).toHaveBeenCalledWith(
			"A normal mention @file1.txt", // Expected: @ remains @
			expect.any(Array),
			"code",
		)
	})

	it("should handle mixed escaping scenarios", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use", // Add required 'type' property
			name: "new_task", // Correct property name
			params: {
				mode: "code",
				message: "Mix: @file0.txt, \\@file1.txt, \\\\@file2.txt, \\\\\\\\@file3.txt",
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockStartSubtask).toHaveBeenCalledWith(
			"Mix: @file0.txt, \\@file1.txt, \\@file2.txt, \\\\\\@file3.txt", // Unit Test Expectation: @->@, \@->\@, \\@->\@, \\\\@->\\\\@
			expect.any(Array),
			"code",
		)
	})

	it("should handle missing todos parameter gracefully (backward compatibility)", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Test message",
				// todos missing - should work for backward compatibility
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// Should NOT error when todos is missing
		expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
		expect(mockCline.mistakeTracker!.count).toBe(0)
		expect(mockCline.tokenUsageTracker.recordToolError).not.toHaveBeenCalledWith("new_task")

		// Should create task with empty todos array
		expect(mockStartSubtask).toHaveBeenCalledWith("Test message", [], "code")

		// Should complete successfully
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
	})

	it("should work with todos parameter when provided", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Test message with todos",
				todos: "[ ] First task\n[ ] Second task",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// Should parse and include todos when provided
		expect(mockStartSubtask).toHaveBeenCalledWith(
			"Test message with todos",
			expect.arrayContaining([
				expect.objectContaining({ content: "First task" }),
				expect.objectContaining({ content: "Second task" }),
			]),
			"code",
		)

		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
	})

	it("should error when mode parameter is missing", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				// mode missing
				message: "Test message",
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "mode")
		expect(mockCline.mistakeTracker!.count).toBe(1)
		expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("new_task")
	})

	it("should error when message parameter is missing", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				// message missing
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "message")
		expect(mockCline.mistakeTracker!.count).toBe(1)
		expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("new_task")
	})

	it("should parse todos with different statuses correctly", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Test message",
				todos: "[ ] Pending task\n[x] Completed task\n[-] In progress task",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockStartSubtask).toHaveBeenCalledWith(
			"Test message",
			expect.arrayContaining([
				expect.objectContaining({ content: "Pending task", status: "pending" }),
				expect.objectContaining({ content: "Completed task", status: "completed" }),
				expect.objectContaining({ content: "In progress task", status: "in_progress" }),
			]),
			"code",
		)
	})

	describe("VSCode setting: newTaskRequireTodos", () => {
		it("should NOT require todos when VSCode setting is disabled (default)", async () => {
			// Ensure VSCode setting is disabled
			const mockGet = vi.fn().mockReturnValue(false)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					// todos missing - should work when setting is disabled
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should NOT error when todos is missing and setting is disabled
			expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
			expect(mockCline.mistakeTracker!.count).toBe(0)
			expect(mockCline.tokenUsageTracker.recordToolError).not.toHaveBeenCalledWith("new_task")

			// Should create task with empty todos array
			expect(mockStartSubtask).toHaveBeenCalledWith("Test message", [], "code")

			// Should complete successfully
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
		})

		it("should REQUIRE todos when VSCode setting is enabled", async () => {
			// Enable VSCode setting
			const mockGet = vi.fn().mockReturnValue(true)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					// todos missing - should error when setting is enabled
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should error when todos is missing and setting is enabled
			expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "todos")
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("new_task")

			// Should NOT create task
			expect(mockStartSubtask).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Successfully created new task"),
			)
		})

		it("should work with todos when VSCode setting is enabled", async () => {
			// Enable VSCode setting
			const mockGet = vi.fn().mockReturnValue(true)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					todos: "[ ] First task\n[ ] Second task",
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should NOT error when todos is provided and setting is enabled
			expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
			expect(mockCline.mistakeTracker!.count).toBe(0)

			// Should create task with parsed todos
			expect(mockStartSubtask).toHaveBeenCalledWith(
				"Test message",
				expect.arrayContaining([
					expect.objectContaining({ content: "First task" }),
					expect.objectContaining({ content: "Second task" }),
				]),
				"code",
			)

			// Should complete successfully
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
		})

		it("should work with empty todos string when VSCode setting is enabled", async () => {
			// Enable VSCode setting
			const mockGet = vi.fn().mockReturnValue(true)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					todos: "", // Empty string should be accepted
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should NOT error when todos is empty string and setting is enabled
			expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
			expect(mockCline.mistakeTracker!.count).toBe(0)

			// Should create task with empty todos array
			expect(mockStartSubtask).toHaveBeenCalledWith("Test message", [], "code")

			// Should complete successfully
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
		})

		it("should check VSCode setting with Package.name configuration key", async () => {
			const mockGet = vi.fn().mockReturnValue(false)
			const mockGetConfiguration = vi.fn().mockReturnValue({
				get: mockGet,
			} as any)
			vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Verify that VSCode configuration was accessed with Package.name
			expect(mockGetConfiguration).toHaveBeenCalledWith("openai-agent")
			expect(mockGet).toHaveBeenCalledWith("newTaskRequireTodos", false)
		})

		it("should use current Package.name value (openai-agent-nightly) when accessing VSCode configuration", async () => {
			// Arrange: capture calls to VSCode configuration and ensure we can assert the namespace
			const mockGet = vi.fn().mockReturnValue(false)
			const mockGetConfiguration = vi.fn().mockReturnValue({
				get: mockGet,
			} as any)
			vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

			// Mutate the mocked Package.name dynamically to simulate a different build variant
			const pkg = await import("../../../shared/package")
			;(pkg.Package as any).name = "openai-agent-nightly"

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Assert: configuration was read using the dynamic nightly namespace
			expect(mockGetConfiguration).toHaveBeenCalledWith("openai-agent-nightly")
			expect(mockGet).toHaveBeenCalledWith("newTaskRequireTodos", false)
		})
	})

	// Add more tests for error handling (invalid mode, approval denied) if needed
})

describe("newTaskTool delegation flow", () => {
	it("delegates to provider and does not call legacy startSubtask", async () => {
		// Arrange: stub provider delegation
		const providerSpy = {
			getState: vi.fn().mockResolvedValue({
				mode: "ask",
				experiments: {},
			}),
			delegateParentAndOpenChild: vi.fn().mockResolvedValue({ taskId: "child-1" }),
			handleModeSwitch: vi.fn(),
		} as any

		// Use a fresh local cline instance to avoid cross-test interference
		const localStartSubtask = vi.fn()
		const localEmit = vi.fn()
		const localCline = {
			ask: vi.fn(),
			sayAndCreateMissingParamError: mockSayAndCreateMissingParamError,
			emit: localEmit,
			tokenUsageTracker: { recordToolError: mockRecordToolError, recordToolUsage: vi.fn() } as any,
			mistakeTracker: { count: 0 } as any,
			isPaused: false,
			pausedModeSlug: "ask",
			taskId: "mock-parent-task-id",
			enableCheckpoints: false,
			checkpointSave: mockCheckpointSave,
			startSubtask: localStartSubtask,
			providerRef: {
				deref: vi.fn(() => providerSpy),
			},
		}

		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Do something",
				// no todos -> should default to []
			},
			partial: false,
		}

		// Act
		await newTaskTool.handle(localCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// Assert: provider method called with correct params
		expect(providerSpy.delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "mock-parent-task-id",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		// Assert: legacy path not used
		expect(localStartSubtask).not.toHaveBeenCalled()

		// Assert: no pause/unpause events emitted in delegation path
		const pauseEvents = (localEmit as any).mock.calls.filter(
			(c: any[]) => c[0] === "taskPaused" || c[0] === "taskUnpaused",
		)
		expect(pauseEvents.length).toBe(0)

		// Assert: tool result reflects delegation
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task child-1"))
	})
})

// ---------------------------------------------------------------------------
// 追加スイート: エラー系・承認拒否・partial の分岐を網羅し、
// 「承認ゲートを通らない限り子タスクは生成されない（delegateParentAndOpenChild が 0 回）」
// という不変条件を固定する。
// ---------------------------------------------------------------------------

describe("newTaskTool - エラー系/承認ゲート/partial", () => {
	let delegateSpy: ReturnType<typeof vi.fn>

	const validMode = {
		slug: "code",
		name: "Code Mode",
		roleDefinition: "role",
		groups: ["command", "read", "edit"],
	}

	beforeEach(() => {
		vi.clearAllMocks()
		delegateSpy = vi.fn().mockResolvedValue({ taskId: "child-9" })
		vi.mocked(getModeBySlug).mockReturnValue(validMode as any)
		// 既定: parseMarkdownChecklist は素直にパースする（mock 実体を復元）
		vi.mocked(parseMarkdownChecklist).mockImplementation((md: string) => {
			return md
				.split("\n")
				.filter((l) => l.trim())
				.map(
					(line, index) =>
						({ id: `todo-${index}`, content: line.replace(/^\[.\]\s*/, ""), status: "pending" }) as any,
				)
		})
		const mockGet = vi.fn().mockReturnValue(false)
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as any)
	})

	/** provider を差し替えた最小 cline を組み立てる。 */
	const makeCline = (provider: unknown | undefined) => ({
		ask: vi.fn().mockResolvedValue(undefined),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
		emit: vi.fn(),
		tokenUsageTracker: { recordToolError: vi.fn(), recordToolUsage: vi.fn() } as any,
		mistakeTracker: { count: 0 } as any,
		stream: { didToolFailInCurrentTurn: false } as any,
		taskId: "parent-x",
		providerRef: { deref: vi.fn(() => provider) },
	})

	const makeProvider = (overrides: Record<string, unknown> = {}) => ({
		getState: vi.fn().mockResolvedValue({ customModes: [], mode: "ask" }),
		delegateParentAndOpenChild: delegateSpy,
		handleModeSwitch: vi.fn(),
		...overrides,
	})

	const block = (params: Record<string, unknown>): ToolUse<"new_task"> => ({
		type: "tool_use",
		name: "new_task",
		params: params as any,
		nativeArgs: {
			mode: params.mode,
			message: params.message,
			todos: params.todos,
		} as unknown as NativeToolArgs["new_task"],
		partial: false,
	})

	const cbs = (_cline: any) => ({
		askApproval: mockAskApproval,
		handleError: mockHandleError,
		pushToolResult: mockPushToolResult,
	})

	it("provider 参照が失われていたら error を返し、子タスクを生成しない", async () => {
		mockAskApproval.mockResolvedValue(true)
		const cline = makeCline(undefined)

		await newTaskTool.handle(cline as any, block({ mode: "code", message: "x" }), cbs(cline))

		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Provider reference lost"))
		expect(delegateSpy).not.toHaveBeenCalled()
		expect(mockAskApproval).not.toHaveBeenCalled()
	})

	it("不正な mode（getModeBySlug が undefined）なら Invalid mode を返し、承認も委譲もしない", async () => {
		vi.mocked(getModeBySlug).mockReturnValue(undefined as any)
		mockAskApproval.mockResolvedValue(true)
		const cline = makeCline(makeProvider())

		await newTaskTool.handle(cline as any, block({ mode: "bogus", message: "x" }), cbs(cline))

		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Invalid mode: bogus"))
		expect(mockAskApproval).not.toHaveBeenCalled()
		expect(delegateSpy).not.toHaveBeenCalled()
	})

	it("承認が拒否されたら子タスクを生成しない（承認ゲート不変条件）", async () => {
		mockAskApproval.mockResolvedValue(false)
		const cline = makeCline(makeProvider())

		await newTaskTool.handle(cline as any, block({ mode: "code", message: "x", todos: "[ ] a" }), cbs(cline))

		expect(mockAskApproval).toHaveBeenCalled()
		expect(delegateSpy).not.toHaveBeenCalled()
		expect(mockPushToolResult).not.toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
	})

	it("todos のパースに失敗したら error を返し、承認・委譲へ進まない", async () => {
		vi.mocked(parseMarkdownChecklist).mockImplementationOnce(() => {
			throw new Error("bad checklist")
		})
		mockAskApproval.mockResolvedValue(true)
		const cline = makeCline(makeProvider())

		await newTaskTool.handle(cline as any, block({ mode: "code", message: "x", todos: "壊れた" }), cbs(cline))

		expect(cline.mistakeTracker.count).toBe(1)
		expect(cline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("new_task")
		expect(cline.stream.didToolFailInCurrentTurn).toBe(true)
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Invalid todos format"))
		expect(mockAskApproval).not.toHaveBeenCalled()
		expect(delegateSpy).not.toHaveBeenCalled()
	})

	it("委譲中に例外が起きたら handleError('creating new task') に委ねる", async () => {
		const boom = new Error("delegate 失敗")
		delegateSpy.mockRejectedValue(boom)
		mockAskApproval.mockResolvedValue(true)
		const cline = makeCline(makeProvider())

		await newTaskTool.handle(cline as any, block({ mode: "code", message: "x" }), cbs(cline))

		expect(mockHandleError).toHaveBeenCalledWith("creating new task", boom)
	})

	it("getState が customModes を持たない値でも getModeBySlug へ undefined を渡して継続する", async () => {
		const provider = makeProvider({ getState: vi.fn().mockResolvedValue(undefined) })
		mockAskApproval.mockResolvedValue(true)
		const cline = makeCline(provider)

		await newTaskTool.handle(cline as any, block({ mode: "code", message: "x" }), cbs(cline))

		expect(vi.mocked(getModeBySlug)).toHaveBeenCalledWith("code", undefined)
		expect(delegateSpy).toHaveBeenCalledWith({
			parentTaskId: "parent-x",
			message: "x",
			initialTodos: [],
			mode: "code",
		})
	})

	describe("handlePartial", () => {
		it("todos 付きで partial なら tool ask を組み立てて投げる", async () => {
			const cline = makeCline(makeProvider())
			const partialBlock: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: { mode: "code", message: "途中", todos: "[ ] a" } as any,
				partial: true,
			}

			await newTaskTool.handle(cline as any, partialBlock, cbs(cline))

			expect(cline.ask).toHaveBeenCalledWith("tool", expect.stringContaining("newTask"), true)
			expect(cline.ask).toHaveBeenCalledWith("tool", expect.stringContaining("途中"), true)
			expect(delegateSpy).not.toHaveBeenCalled()
		})

		it("mode/message/todos が未定義でも既定値で ask を組み立てる", async () => {
			const cline = makeCline(makeProvider())
			const partialBlock: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {} as any,
				partial: true,
			}

			await newTaskTool.handle(cline as any, partialBlock, cbs(cline))

			const [, payload] = cline.ask.mock.calls[0]
			const parsed = JSON.parse(payload as string)
			expect(parsed).toEqual({ tool: "newTask", mode: "", content: "", todos: undefined })
		})
	})
})
