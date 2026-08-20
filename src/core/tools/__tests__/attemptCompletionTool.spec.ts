import { AgentEventName, TodoItem } from "@openai-agent/types"

import { AttemptCompletionToolUse, ToolUse } from "../../../shared/tools"

// Mock the formatResponse module before importing the tool
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		toolResult: vi.fn((msg: string) => `Result: ${msg}`),
		toolDenied: vi.fn(() => "Denied"),
	},
}))

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
	},
}))

import { attemptCompletionTool, AttemptCompletionCallbacks } from "../AttemptCompletionTool"
import { Task } from "../../task/Task"
import { makeMockTask } from "../../task/__tests__/makeMockTask"
import * as vscode from "vscode"

describe("attemptCompletionTool", () => {
	let mockTask: Partial<Task>
	let mockPushToolResult: ReturnType<typeof vi.fn>
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let mockToolDescription: ReturnType<typeof vi.fn>
	let mockAskFinishSubTaskApproval: ReturnType<typeof vi.fn>
	let mockGetConfiguration: ReturnType<typeof vi.fn>

	beforeEach(() => {
		mockPushToolResult = vi.fn()
		mockAskApproval = vi.fn()
		mockHandleError = vi.fn()
		mockToolDescription = vi.fn()
		mockAskFinishSubTaskApproval = vi.fn()
		mockGetConfiguration = vi.fn(() => ({
			get: vi.fn((key: string, defaultValue: any) => {
				if (key === "preventCompletionWithOpenTodos") {
					return defaultValue // Default to false unless overridden in test
				}
				return defaultValue
			}),
		}))

		// Setup vscode mock
		vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

		mockTask = makeMockTask() as any
		;(mockTask as any).taskId = "task_1"
		mockTask.todoList = undefined
		mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })
		mockTask.emit = vi.fn()
		;(mockTask as any).tokenUsageTracker = {
			toolUsage: {},
			getTokenUsage: vi.fn().mockReturnValue({}),
			emitFinal: vi.fn(),
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
		} as any
		mockTask.apiConfiguration = { apiProvider: "test" } as any
		mockTask.api = { getModel: vi.fn().mockReturnValue({ id: "test-model", info: {} }) } as any
	})

	describe("todo list validation", () => {
		it("should allow completion when there is no todo list", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			mockTask.todoList = undefined

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not call pushToolResult with an error for empty todo list
			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.tokenUsageTracker!.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when todo list is empty", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			mockTask.todoList = []

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.tokenUsageTracker!.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.tokenUsageTracker!.recordToolError).not.toHaveBeenCalled()
		})

		it("should prevent completion when there are pending todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are in-progress todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithInProgress: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "in_progress" },
			]

			mockTask.todoList = todosWithInProgress

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are mixed incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const mixedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
				{ id: "3", content: "Third task", status: "in_progress" },
			]

			mockTask.todoList = mixedTodos

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is disabled even with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Ensure the setting is disabled (default behavior)
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return false // Setting is disabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not prevent completion when setting is disabled
			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.tokenUsageTracker!.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when setting is enabled with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should prevent completion when setting is enabled and there are incomplete todos
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is enabled but all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			// Enable the setting
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should allow completion when setting is enabled but all todos are completed
			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.tokenUsageTracker!.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		describe("tool failure guardrail", () => {
			it("should prevent completion when a previous tool failed in the current turn", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully" },
					nativeArgs: { result: "Task completed successfully" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.stream!.didToolFailInCurrentTurn = true

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				const mockSay = vi.fn()
				mockTask.say = mockSay

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockSay).toHaveBeenCalledWith(
					"error",
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
			})

			it("should allow completion when no tools failed", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully" },
					nativeArgs: { result: "Task completed successfully" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.stream!.didToolFailInCurrentTurn = false

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockTask.mistakeTracker!.count).toBe(0)
				expect(mockTask.tokenUsageTracker!.recordToolError).not.toHaveBeenCalled()
			})
		})

		describe("completion lifecycle", () => {
			it("emits TaskCompleted only when completion is accepted", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}

				mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockTask.emit).toHaveBeenCalledWith(
					AgentEventName.TaskCompleted,
					"task_1",
					expect.anything(),
					expect.anything(),
				)
			})

			it("does not emit TaskCompleted when user provides follow-up feedback", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}

				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "Different question now: what is 3+3?",
					images: [],
				})

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					AgentEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("<user_message>"))
			})
		})
	})
})

// ---------------------------------------------------------------------------
// 追加スイート: サブタスク委譲・必須パラメータ・例外・partial の分岐を網羅し、
// 「承認ゲートを通らない経路で親タスクへ委譲（外部作用）が起きない」ことを固定する。
// ---------------------------------------------------------------------------

describe("attemptCompletionTool - 委譲/必須param/例外/partial", () => {
	let task: any
	let pushToolResult: ReturnType<typeof vi.fn>
	let handleError: ReturnType<typeof vi.fn>
	let askFinishSubTaskApproval: ReturnType<typeof vi.fn>
	let getTaskWithId: ReturnType<typeof vi.fn>
	let reopenParentFromDelegation: ReturnType<typeof vi.fn>

	const makeCallbacks = (): AttemptCompletionCallbacks => ({
		askApproval: vi.fn(),
		handleError,
		pushToolResult,
		askFinishSubTaskApproval,
		toolDescription: vi.fn(),
	})

	const makeBlock = (result: string = "全部おわった"): AttemptCompletionToolUse => ({
		type: "tool_use",
		name: "attempt_completion",
		params: { result },
		nativeArgs: { result },
		partial: false,
	})

	beforeEach(() => {
		pushToolResult = vi.fn()
		handleError = vi.fn()
		askFinishSubTaskApproval = vi.fn().mockResolvedValue(true)
		getTaskWithId = vi.fn()
		reopenParentFromDelegation = vi.fn().mockResolvedValue(undefined)

		// vscode 設定は既定で false（preventCompletionWithOpenTodos 無効）。
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn((_key: string, defaultValue: any) => defaultValue),
		} as any)

		task = makeMockTask() as any
		task.taskId = "task_1"
		task.parentTaskId = undefined
		task.todoList = undefined
		task.emit = vi.fn()
		task.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })
		task.messageStore = { clineMessages: [] }
		task.tokenUsageTracker = {
			toolUsage: {},
			getTokenUsage: vi.fn().mockReturnValue({}),
			emitFinal: vi.fn(),
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
		}
	})

	/** parentTaskId を持たせ、provider を差し替えて委譲経路へ入れる。 */
	const wireDelegation = (status: "active" | "completed" | "delegated" | undefined) => {
		task.parentTaskId = "parent_1"
		getTaskWithId.mockResolvedValue({ historyItem: status === undefined ? {} : { status } })
		task.providerRef = {
			deref: vi.fn(() => ({ getTaskWithId, reopenParentFromDelegation })),
		}
	}

	describe("必須パラメータ", () => {
		it("result が空なら missing param エラーを返し、以降へ進まない", async () => {
			task.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing result")
			const block = makeBlock("")

			await attemptCompletionTool.execute(block.params as any, task, makeCallbacks())

			expect(task.mistakeTracker.count).toBe(1)
			expect(task.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("attempt_completion", "result")
			expect(pushToolResult).toHaveBeenCalledWith("Missing result")
			// 完了 ask には到達しない
			expect(task.ask).not.toHaveBeenCalled()
			expect(task.emit).not.toHaveBeenCalled()
		})
	})

	describe("サブタスク委譲（parentTaskId あり）", () => {
		it("status=active で承認 → 親へ委譲し TaskCompleted を emit（完了 ask は行わない）", async () => {
			wireDelegation("active")
			askFinishSubTaskApproval.mockResolvedValue(true)

			await attemptCompletionTool.execute(makeBlock("結果S").params as any, task, makeCallbacks())

			expect(askFinishSubTaskApproval).toHaveBeenCalledTimes(1)
			expect(reopenParentFromDelegation).toHaveBeenCalledWith({
				parentTaskId: "parent_1",
				childTaskId: "task_1",
				completionResultSummary: "結果S",
			})
			// 空文字の tool_result（委譲成功の合図）
			expect(pushToolResult).toHaveBeenCalledWith("")
			expect(task.emit).toHaveBeenCalledWith(
				AgentEventName.TaskCompleted,
				"task_1",
				expect.anything(),
				expect.anything(),
			)
			// 委譲したので通常の完了 ask には進まない
			expect(task.ask).not.toHaveBeenCalled()
		})

		it("status=active で拒否 → 親へ委譲せず toolDenied、TaskCompleted も出さない（承認ゲート不変条件）", async () => {
			wireDelegation("active")
			askFinishSubTaskApproval.mockResolvedValue(false)

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			expect(askFinishSubTaskApproval).toHaveBeenCalledTimes(1)
			// 承認を通らないので親タスク再開（外部作用）に到達しない
			expect(reopenParentFromDelegation).not.toHaveBeenCalled()
			expect(pushToolResult).toHaveBeenCalledWith("Denied")
			expect(task.emit).not.toHaveBeenCalled()
			expect(task.ask).not.toHaveBeenCalled()
		})

		it("status=completed → 委譲せず通常の完了 ask にフォールスルー", async () => {
			wireDelegation("completed")

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			// 委譲は一切走らない
			expect(askFinishSubTaskApproval).not.toHaveBeenCalled()
			expect(reopenParentFromDelegation).not.toHaveBeenCalled()
			// 通常の完了 ask に進む（既定 yesButtonClicked → 完了）
			expect(task.ask).toHaveBeenCalledWith("completion_result", "", false)
			expect(task.emit).toHaveBeenCalledWith(
				AgentEventName.TaskCompleted,
				"task_1",
				expect.anything(),
				expect.anything(),
			)
		})

		it("status=delegated（想定外）→ console.error して完了 ask にフォールスルー", async () => {
			wireDelegation("delegated")
			const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unexpected child task status"))
			expect(reopenParentFromDelegation).not.toHaveBeenCalled()
			expect(task.ask).toHaveBeenCalledWith("completion_result", "", false)
			errSpy.mockRestore()
		})

		it("status=undefined（永続化バグ）→ console.error して完了 ask にフォールスルー", async () => {
			wireDelegation(undefined)
			const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unexpected child task status"))
			expect(reopenParentFromDelegation).not.toHaveBeenCalled()
			expect(task.ask).toHaveBeenCalledWith("completion_result", "", false)
			errSpy.mockRestore()
		})

		it("getTaskWithId が例外 → console.error して完了 ask にフォールスルー", async () => {
			task.parentTaskId = "parent_1"
			getTaskWithId.mockRejectedValue(new Error("history 読めない"))
			task.providerRef = { deref: vi.fn(() => ({ getTaskWithId, reopenParentFromDelegation })) }
			const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to get history"))
			expect(reopenParentFromDelegation).not.toHaveBeenCalled()
			expect(task.ask).toHaveBeenCalledWith("completion_result", "", false)
			errSpy.mockRestore()
		})

		it("getTaskWithId が例外（非 Error を throw）でも String 化して継続", async () => {
			task.parentTaskId = "parent_1"
			getTaskWithId.mockRejectedValue("なぞの文字列")
			task.providerRef = { deref: vi.fn(() => ({ getTaskWithId, reopenParentFromDelegation })) }
			const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("なぞの文字列"))
			expect(task.ask).toHaveBeenCalledWith("completion_result", "", false)
			errSpy.mockRestore()
		})

		it("provider が失われている（deref=undefined）→ 委譲を試みず完了 ask にフォールスルー", async () => {
			task.parentTaskId = "parent_1"
			task.providerRef = { deref: vi.fn(() => undefined) }

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			expect(getTaskWithId).not.toHaveBeenCalled()
			expect(reopenParentFromDelegation).not.toHaveBeenCalled()
			expect(task.ask).toHaveBeenCalledWith("completion_result", "", false)
		})
	})

	describe("完了 ask のフィードバック分岐と例外処理", () => {
		it("ユーザがフィードバックを返すと user_feedback を say し tool_result を返す（完了 emit なし）", async () => {
			task.ask = vi.fn().mockResolvedValue({ response: "messageResponse", text: "もう一問", images: ["img1"] })

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			expect(task.say).toHaveBeenCalledWith("user_feedback", "もう一問", ["img1"])
			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("<user_message>"))
			expect(task.emit).not.toHaveBeenCalled()
		})

		it("フィードバック text が undefined でも空文字に丸めて say/tool_result を返す", async () => {
			task.ask = vi.fn().mockResolvedValue({ response: "messageResponse", text: undefined, images: undefined })

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			expect(task.say).toHaveBeenCalledWith("user_feedback", "", undefined)
			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("<user_message>"))
		})

		it("完了 ask 中に例外が起きたら handleError('inspecting site') に委ねる", async () => {
			const boom = new Error("ask 失敗")
			task.ask = vi.fn().mockRejectedValue(boom)

			await attemptCompletionTool.execute(makeBlock().params as any, task, makeCallbacks())

			expect(handleError).toHaveBeenCalledWith("inspecting site", boom)
		})
	})

	describe("handlePartial", () => {
		it("command あり・直前が command ask → completion_result を say せず command を再 ask", async () => {
			task.messageStore = { clineMessages: [{ ask: "command" }] }
			const block: ToolUse<"attempt_completion"> = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "r", command: "ls -la" },
				nativeArgs: { result: "r", command: "ls -la" } as any,
				partial: true,
			}

			await attemptCompletionTool.handlePartial(task, block)

			expect(task.say).not.toHaveBeenCalled()
			expect(task.ask).toHaveBeenCalledWith("command", "ls -la", true)
		})

		it("command あり・直前が command でない → completion_result を say してから command を ask", async () => {
			task.messageStore = { clineMessages: [{ ask: "tool" }] }
			const block: ToolUse<"attempt_completion"> = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "r", command: "npm test" },
				nativeArgs: { result: "r", command: "npm test" } as any,
				partial: true,
			}

			await attemptCompletionTool.handlePartial(task, block)

			expect(task.say).toHaveBeenCalledWith("completion_result", "r", undefined, false)
			expect(task.ask).toHaveBeenCalledWith("command", "npm test", true)
		})

		it("command あり・直前メッセージ無し → else 分岐で say してから ask", async () => {
			task.messageStore = { clineMessages: [] }
			const block: ToolUse<"attempt_completion"> = {
				type: "tool_use",
				name: "attempt_completion",
				params: { command: "echo hi" } as any,
				nativeArgs: { command: "echo hi" } as any,
				partial: true,
			}

			await attemptCompletionTool.handlePartial(task, block)

			expect(task.say).toHaveBeenCalledWith("completion_result", "", undefined, false)
			expect(task.ask).toHaveBeenCalledWith("command", "echo hi", true)
		})

		it("command なし → completion_result を partial 付きで say する", async () => {
			task.messageStore = { clineMessages: [] }
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "途中経過" },
				nativeArgs: { result: "途中経過" },
				partial: true,
			}

			await attemptCompletionTool.handlePartial(task, block)

			expect(task.say).toHaveBeenCalledWith("completion_result", "途中経過", undefined, true)
			expect(task.ask).not.toHaveBeenCalled()
		})

		it("command なし・result も無し → 空文字にフォールバックして say する", async () => {
			task.messageStore = { clineMessages: [] }
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: {},
				nativeArgs: {} as any,
				partial: true,
			}

			await attemptCompletionTool.handlePartial(task, block)

			expect(task.say).toHaveBeenCalledWith("completion_result", "", undefined, true)
			expect(task.ask).not.toHaveBeenCalled()
		})
	})
})
