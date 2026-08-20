// npx vitest run __tests__/history-resume-delegation.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { AgentEventName } from "@openai-agent/types"

/* vscode mock for Task/Provider imports */
vi.mock("vscode", () => {
	const window = {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: any) => defaultValue),
			update: vi.fn(),
		})),
		workspaceFolders: [],
	}
	const env = { machineId: "test-machine", uriScheme: "vscode", appName: "VSCode", language: "en", sessionId: "sess" }
	const Uri = { file: (p: string) => ({ fsPath: p, toString: () => p }) }
	const commands = { executeCommand: vi.fn() }
	const ExtensionMode = { Development: 2 }
	const version = "1.0.0-test"
	return { window, workspace, env, Uri, commands, ExtensionMode, version }
})

// Mock persistence BEFORE importing provider
vi.mock("../core/task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))
vi.mock("../core/task-persistence", () => ({
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
	saveTaskMessages: vi.fn().mockResolvedValue(undefined),
}))

import { ClineProvider } from "../core/webview/ClineProvider"
import { makeDelegationController } from "./helpers/taskDelegation"
import { readTaskMessages } from "../core/task-persistence/taskMessages"
import { readApiMessages, saveApiMessages, saveTaskMessages } from "../core/task-persistence"

describe("History resume delegation - parent metadata transitions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reopenParentFromDelegation persists parent metadata (delegated → active) before reopen", async () => {
		const providerEmit = vi.fn()
		const getTaskWithId = vi.fn().mockResolvedValue({
			historyItem: {
				id: "parent-1",
				status: "delegated",
				delegatedToId: "child-1",
				awaitingChildId: "child-1",
				childIds: ["child-1"],
				ts: Date.now(),
				task: "Parent task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				mode: "code",
				workspace: "/tmp",
			},
		})

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue({
			taskId: "parent-1",
			skipPrevResponseIdOnce: false,
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
		})

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId,
			emit: providerEmit,
			getCurrentTask: vi.fn(() => ({ taskId: "child-1" })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			updateTaskHistory,
		} as unknown as ClineProvider

		// Mock persistence reads to return empty arrays
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await makeDelegationController(provider).reopenParentFromDelegation({
			parentTaskId: "parent-1",
			childTaskId: "child-1",
			completionResultSummary: "Child done",
		})

		// Assert: metadata updated BEFORE createTaskWithHistoryItem
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "parent-1",
				status: "active",
				completedByChildId: "child-1",
				completionResultSummary: "Child done",
				awaitingChildId: undefined,
				childIds: ["child-1"],
			}),
		)

		// Verify call ordering: updateTaskHistory before createTaskWithHistoryItem
		const updateCall = updateTaskHistory.mock.invocationCallOrder[0]
		const createCall = createTaskWithHistoryItem.mock.invocationCallOrder[0]
		expect(updateCall).toBeLessThan(createCall)

		// Verify child closed and parent reopened with updated metadata
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "active",
				completedByChildId: "child-1",
			}),
			{ startTask: false },
		)
	})

	it("reopenParentFromDelegation injects subtask_result into both UI and API histories", async () => {
		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p1",
					status: "delegated",
					awaitingChildId: "c1",
					childIds: [],
					ts: 100,
					task: "Parent",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c1" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p1",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
		} as unknown as ClineProvider

		// Start with existing messages in history
		const existingUiMessages = [{ type: "ask", ask: "tool", text: "Old tool", ts: 50 }]
		const existingApiMessages = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Old request" }], ts: 50 },
		]

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages as any)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages as any)

		await makeDelegationController(provider).reopenParentFromDelegation({
			parentTaskId: "p1",
			childTaskId: "c1",
			completionResultSummary: "Subtask completed successfully",
		})

		// Verify UI history injection (say: subtask_result)
		expect(saveTaskMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						type: "say",
						say: "subtask_result",
						text: "Subtask completed successfully",
					}),
				]),
				taskId: "p1",
				globalStoragePath: "/storage",
			}),
		)

		// Verify API history injection (user role message).
		// 対応する function_call が履歴に無いので、テキストだけの message item にフォールバックする。
		// テキストのみの item は content を文字列で持つ（パート配列に包まない）。
		expect(saveApiMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						type: "message",
						role: "user",
						content: expect.stringContaining("Subtask c1 completed"),
					}),
				]),
				taskId: "p1",
				globalStoragePath: "/storage",
			}),
		)

		// Verify both include original messages
		const uiCall = vi.mocked(saveTaskMessages).mock.calls[0][0]
		expect(uiCall.messages).toHaveLength(2) // 1 original + 1 injected

		const apiCall = vi.mocked(saveApiMessages).mock.calls[0][0]
		expect(apiCall.messages).toHaveLength(2) // 1 original + 1 injected
	})

	it("reopenParentFromDelegation injects tool_result when new_task tool_use exists in API history", async () => {
		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p-tool",
					status: "delegated",
					awaitingChildId: "c-tool",
					childIds: [],
					ts: 100,
					task: "Parent with tool_use",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c-tool" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p-tool",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
		} as unknown as ClineProvider

		// Include the assistant's new_task function_call item to exercise the function_call_output path
		const existingUiMessages = [{ type: "ask", ask: "tool", text: "new_task request", ts: 50 }]
		const existingApiMessages = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Create a subtask" }], ts: 40 },
			{
				type: "function_call",
				call_id: "toolu_abc123",
				name: "new_task",
				arguments: JSON.stringify({ mode: "code", message: "Do something" }),
				ts: 50,
			},
		]

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages as any)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages as any)

		await makeDelegationController(provider).reopenParentFromDelegation({
			parentTaskId: "p-tool",
			childTaskId: "c-tool",
			completionResultSummary: "Subtask completed via tool_result",
		})

		// Verify API history injection answers the call with function_call_output (not text fallback)
		expect(saveApiMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						type: "function_call_output",
						call_id: "toolu_abc123",
						output: expect.stringContaining("Subtask c-tool completed"),
					}),
				]),
				taskId: "p-tool",
				globalStoragePath: "/storage",
			}),
		)

		// Verify total item count: 2 original + 1 injected function_call_output item
		const apiCall = vi.mocked(saveApiMessages).mock.calls[0][0]
		expect(apiCall.messages).toHaveLength(3)

		// item 列では tool 結果は user メッセージの中のブロックではなく独立 item になる
		const injectedMsg = apiCall.messages[2]
		expect(injectedMsg.type).toBe("function_call_output")
		expect(injectedMsg).toMatchObject({ call_id: "toolu_abc123" })
	})

	it("同じターンに未応答の呼び出しが他にあっても orphan を作らない", async () => {
		// 委譲復帰は new_task の呼び出しに応答を足す。同じ assistant ターンに
		// 別の未応答呼び出しがあると、応答だけ増えて対応の取れない状態になりうる。
		// item 列でもこの不変条件が保たれることを確認する。
		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p-multi",
					status: "delegated",
					awaitingChildId: "c-multi",
					childIds: [],
					ts: 100,
					task: "Parent",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c-multi" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p-multi",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as never

		vi.mocked(readTaskMessages).mockResolvedValue([] as never)
		vi.mocked(readApiMessages).mockResolvedValue([
			{ type: "message", role: "user", content: "task", ts: 10 },
			// 同じターンで 2 つ呼んでいて、どちらも未応答
			{ type: "function_call", call_id: "call_other", name: "read_file", arguments: "{}", ts: 20 },
			{ type: "function_call", call_id: "call_newtask", name: "new_task", arguments: "{}", ts: 21 },
		] as never)

		await makeDelegationController(provider).reopenParentFromDelegation({
			parentTaskId: "p-multi",
			childTaskId: "c-multi",
			completionResultSummary: "done",
		})

		const saved = vi.mocked(saveApiMessages).mock.calls[0][0].messages as unknown as Array<Record<string, string>>
		const calls = new Set(saved.filter((m) => m.type === "function_call").map((m) => m.call_id))
		const outputs = saved.filter((m) => m.type === "function_call_output").map((m) => m.call_id)

		// 応答は必ず既存の呼び出しに対応する
		for (const id of outputs) expect(calls.has(id)).toBe(true)
		// new_task には応答が付く
		expect(outputs).toContain("call_newtask")
	})

	it("reopenParentFromDelegation injects plain text when no new_task tool_use exists in API history", async () => {
		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p-no-tool",
					status: "delegated",
					awaitingChildId: "c-no-tool",
					childIds: [],
					ts: 100,
					task: "Parent without tool_use",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c-no-tool" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "p-no-tool",
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
		} as unknown as ClineProvider

		// No assistant tool_use in history
		const existingUiMessages = [{ type: "ask", ask: "tool", text: "subtask request", ts: 50 }]
		const existingApiMessages = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Create a subtask" }], ts: 40 },
		]

		vi.mocked(readTaskMessages).mockResolvedValue(existingUiMessages as any)
		vi.mocked(readApiMessages).mockResolvedValue(existingApiMessages as any)

		await makeDelegationController(provider).reopenParentFromDelegation({
			parentTaskId: "p-no-tool",
			childTaskId: "c-no-tool",
			completionResultSummary: "Subtask completed without tool_use",
		})

		const apiCall = vi.mocked(saveApiMessages).mock.calls[0][0]
		// Should append a user text note
		expect(apiCall.messages).toHaveLength(2)
		const injected = apiCall.messages[1]
		expect(injected).toMatchObject({
			type: "message",
			role: "user",
			content: expect.stringContaining("Subtask c-no-tool completed"),
		})
	})

	it("reopenParentFromDelegation sets skipPrevResponseIdOnce via resumeAfterDelegation", async () => {
		const parentInstance: any = {
			skipPrevResponseIdOnce: false,
			resumeAfterDelegation: vi.fn().mockImplementation(async function (this: any) {
				// Simulate what the real resumeAfterDelegation does
				this.skipPrevResponseIdOnce = true
			}),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "parent-2",
					status: "delegated",
					awaitingChildId: "child-2",
					childIds: [],
					ts: 200,
					task: "P",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "child-2" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(parentInstance),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await makeDelegationController(provider).reopenParentFromDelegation({
			parentTaskId: "parent-2",
			childTaskId: "child-2",
			completionResultSummary: "Done",
		})

		// Critical: verify skipPrevResponseIdOnce set to true by resumeAfterDelegation
		expect(parentInstance.skipPrevResponseIdOnce).toBe(true)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)
	})

	it("reopenParentFromDelegation emits events in correct order: TaskDelegationCompleted → TaskDelegationResumed", async () => {
		const emitSpy = vi.fn()
		const updateTaskHistory = vi.fn().mockResolvedValue([])

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p3",
					status: "delegated",
					awaitingChildId: "c3",
					childIds: [],
					ts: 300,
					task: "P3",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "c3" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await makeDelegationController(provider).reopenParentFromDelegation({
			parentTaskId: "p3",
			childTaskId: "c3",
			completionResultSummary: "Summary",
		})

		// Verify both events emitted
		const eventNames = emitSpy.mock.calls.map((c) => c[0])
		expect(eventNames).toContain(AgentEventName.TaskDelegationCompleted)
		expect(eventNames).toContain(AgentEventName.TaskDelegationResumed)

		// CRITICAL: verify ordering (TaskDelegationCompleted before TaskDelegationResumed)
		const completedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === AgentEventName.TaskDelegationCompleted)
		const resumedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === AgentEventName.TaskDelegationResumed)
		expect(completedIdx).toBeGreaterThanOrEqual(0)
		expect(resumedIdx).toBeGreaterThan(completedIdx)

		// RPD-05: verify parent metadata persistence happens before TaskDelegationCompleted emit
		const parentUpdateCallIdx = updateTaskHistory.mock.calls.findIndex((call) => {
			const item = call[0] as { id?: string; status?: string } | undefined
			return item?.id === "p3" && item.status === "active"
		})
		expect(parentUpdateCallIdx).toBeGreaterThanOrEqual(0)

		const parentUpdateCallOrder = updateTaskHistory.mock.invocationCallOrder[parentUpdateCallIdx]
		const completedEmitCallOrder = emitSpy.mock.invocationCallOrder[completedIdx]
		expect(parentUpdateCallOrder).toBeLessThan(completedEmitCallOrder)
	})

	it("reopenParentFromDelegation continues when overwrite operations fail and still resumes/emits (RPD-06)", async () => {
		const emitSpy = vi.fn()
		const parentInstance = {
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockRejectedValue(new Error("ui overwrite failed")),
			overwriteApiConversationHistory: vi.fn().mockRejectedValue(new Error("api overwrite failed")),
		}

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockImplementation(async (id: string) => {
				if (id === "parent-rpd06") {
					return {
						historyItem: {
							id: "parent-rpd06",
							status: "delegated",
							awaitingChildId: "child-rpd06",
							childIds: ["child-rpd06"],
							ts: 800,
							task: "Parent RPD-06",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
					}
				}

				return {
					historyItem: {
						id: "child-rpd06",
						status: "active",
						ts: 801,
						task: "Child RPD-06",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				}
			}),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "child-rpd06" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(parentInstance),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			makeDelegationController(provider).reopenParentFromDelegation({
				parentTaskId: "parent-rpd06",
				childTaskId: "child-rpd06",
				completionResultSummary: "Subtask finished despite overwrite failures",
			}),
		).resolves.toBeUndefined()

		expect(parentInstance.overwriteClineMessages).toHaveBeenCalledTimes(1)
		expect(parentInstance.overwriteApiConversationHistory).toHaveBeenCalledTimes(1)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)

		expect(emitSpy).toHaveBeenCalledWith(
			AgentEventName.TaskDelegationCompleted,
			"parent-rpd06",
			"child-rpd06",
			"Subtask finished despite overwrite failures",
		)
		expect(emitSpy).toHaveBeenCalledWith(AgentEventName.TaskDelegationResumed, "parent-rpd06", "child-rpd06")

		const completedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === AgentEventName.TaskDelegationCompleted)
		const resumedIdx = emitSpy.mock.calls.findIndex((c) => c[0] === AgentEventName.TaskDelegationResumed)
		expect(completedIdx).toBeGreaterThanOrEqual(0)
		expect(resumedIdx).toBeGreaterThan(completedIdx)
	})

	it("reopenParentFromDelegation does NOT emit TaskPaused or TaskUnpaused (new flow only)", async () => {
		const emitSpy = vi.fn()

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p4",
					status: "delegated",
					awaitingChildId: "c4",
					childIds: [],
					ts: 400,
					task: "P4",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "c4" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await makeDelegationController(provider).reopenParentFromDelegation({
			parentTaskId: "p4",
			childTaskId: "c4",
			completionResultSummary: "S",
		})

		// CRITICAL: verify legacy pause/unpause events NOT emitted
		const eventNames = emitSpy.mock.calls.map((c) => c[0])
		expect(eventNames).not.toContain(AgentEventName.TaskPaused)
		expect(eventNames).not.toContain(AgentEventName.TaskUnpaused)
		expect(eventNames).not.toContain(AgentEventName.TaskSpawned)
	})

	it("reopenParentFromDelegation skips child close when current task differs and still reopens parent (RPD-02)", async () => {
		const parentInstance = {
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(parentInstance)

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockImplementation(async (id: string) => {
				if (id === "parent-rpd02") {
					return {
						historyItem: {
							id: "parent-rpd02",
							status: "delegated",
							awaitingChildId: "child-rpd02",
							childIds: ["child-rpd02"],
							ts: 600,
							task: "Parent RPD-02",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
					}
				}
				return {
					historyItem: {
						id: "child-rpd02",
						status: "active",
						ts: 601,
						task: "Child RPD-02",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				}
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "different-open-task" })),
			removeClineFromStack,
			createTaskWithHistoryItem,
			updateTaskHistory,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await makeDelegationController(provider).reopenParentFromDelegation({
			parentTaskId: "parent-rpd02",
			childTaskId: "child-rpd02",
			completionResultSummary: "Child done without being current",
		})

		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "child-rpd02",
				status: "completed",
			}),
		)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "parent-rpd02",
				status: "active",
				completedByChildId: "child-rpd02",
			}),
			{ startTask: false },
		)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)
	})

	it("reopenParentFromDelegation logs child status persistence failure and continues reopen flow (RPD-04)", async () => {
		const logSpy = vi.fn()
		const emitSpy = vi.fn()
		const parentInstance = {
			resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const updateTaskHistory = vi.fn().mockImplementation(async (historyItem: { id?: string }) => {
			if (historyItem.id === "child-rpd04") {
				throw new Error("child status persist failed")
			}
			return []
		})

		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockImplementation(async (id: string) => {
				if (id === "parent-rpd04") {
					return {
						historyItem: {
							id: "parent-rpd04",
							status: "delegated",
							awaitingChildId: "child-rpd04",
							childIds: ["child-rpd04"],
							ts: 700,
							task: "Parent RPD-04",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
					}
				}
				return {
					historyItem: {
						id: "child-rpd04",
						status: "active",
						ts: 701,
						task: "Child RPD-04",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				}
			}),
			emit: emitSpy,
			log: logSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "child-rpd04" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(parentInstance),
			updateTaskHistory,
		} as unknown as ClineProvider

		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			makeDelegationController(provider).reopenParentFromDelegation({
				parentTaskId: "parent-rpd04",
				childTaskId: "child-rpd04",
				completionResultSummary: "Child completion with persistence failure",
			}),
		).resolves.toBeUndefined()

		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"[reopenParentFromDelegation] Failed to persist child completed status for child-rpd04:",
			),
		)
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "parent-rpd04",
				status: "active",
				completedByChildId: "child-rpd04",
			}),
		)
		expect(parentInstance.resumeAfterDelegation).toHaveBeenCalledTimes(1)
		expect(emitSpy).toHaveBeenCalledWith(AgentEventName.TaskDelegationResumed, "parent-rpd04", "child-rpd04")
	})

	it("handles empty history gracefully when injecting synthetic messages", async () => {
		const provider = {
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					id: "p5",
					status: "delegated",
					awaitingChildId: "c5",
					childIds: [],
					ts: 500,
					task: "P5",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "c5" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				resumeAfterDelegation: vi.fn().mockResolvedValue(undefined),
				overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
				overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			}),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
		} as unknown as ClineProvider

		// Mock read failures or empty returns
		vi.mocked(readTaskMessages).mockResolvedValue([])
		vi.mocked(readApiMessages).mockResolvedValue([])

		await expect(
			makeDelegationController(provider).reopenParentFromDelegation({
				parentTaskId: "p5",
				childTaskId: "c5",
				completionResultSummary: "Result",
			}),
		).resolves.toBeUndefined()

		// Verify saves still occurred with just the injected message
		expect(saveTaskMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						type: "say",
						say: "subtask_result",
					}),
				],
			}),
		)

		expect(saveApiMessages).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						type: "message",
						role: "user",
					}),
				],
			}),
		)
	})
})
