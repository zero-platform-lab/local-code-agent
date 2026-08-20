import { beforeEach, describe, expect, it, vi } from "vitest"

import { ClineProvider } from "../ClineProvider"
import type { ProviderSettings, HistoryItem } from "@openai-agent/types"

// Mock dependencies
vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	return {
		workspace: {
			getConfiguration: vi.fn(() => ({
				get: vi.fn().mockReturnValue([]),
				update: vi.fn().mockResolvedValue(undefined),
			})),
			workspaceFolders: [],
			onDidChangeConfiguration: vi.fn(() => mockDisposable),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(() => ({
			event: vi.fn(),
			fire: vi.fn(),
		})),
		Disposable: {
			from: vi.fn(),
		},
		window: {
			showErrorMessage: vi.fn(),
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			onDidChangeActiveTextEditor: vi.fn(() => mockDisposable),
		},
		Uri: {
			file: vi.fn().mockReturnValue({ toString: () => "file://test" }),
		},
	}
})

vi.mock("../../config/ContextProxy")
vi.mock("../../../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		getInstance: vi.fn().mockResolvedValue({
			registerClient: vi.fn(),
		}),
		unregisterProvider: vi.fn(),
	},
}))
vi.mock("../../../integrations/workspace/WorkspaceTracker")
vi.mock("../../config/ProviderSettingsManager")
vi.mock("../../config/CustomModesManager")
vi.mock("../../../utils/path", () => ({
	getWorkspacePath: vi.fn().mockReturnValue("/test/workspace"),
}))

vi.mock("../../../shared/embeddingModels", () => ({
	EMBEDDING_MODEL_PROFILES: [],
}))

describe("ClineProvider flicker-free cancel", () => {
	let provider: ClineProvider
	let mockContext: any
	let mockOutputChannel: any
	let mockTask1: any
	let mockTask2: any

	const mockApiConfig: ProviderSettings = {
		apiProvider: "openai",
		openAiApiKey: "test-key",
	} as ProviderSettings

	beforeEach(() => {
		vi.clearAllMocks()

		// Setup mock extension context
		mockContext = {
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: "/test/storage" },
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			extensionUri: { fsPath: "/test/extension" },
		}

		// Setup mock output channel
		mockOutputChannel = {
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}

		// Setup mock context proxy
		const mockContextProxy = {
			getValues: vi.fn().mockReturnValue({}),
			getValue: vi.fn().mockReturnValue(undefined),
			setValue: vi.fn().mockResolvedValue(undefined),
			getProviderSettings: vi.fn().mockReturnValue(mockApiConfig),
			extensionUri: mockContext.extensionUri,
			globalStorageUri: mockContext.globalStorageUri,
		}

		// Create provider instance with an injected task factory so the test can control
		// what `new Task(...)` returns without vi.mock("../../task/Task").
		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", mockContextProxy as any, {
			taskFactory: () => mockTask2 as any,
		})

		// Mock provider methods
		provider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: mockApiConfig,
			mode: "code",
		})

		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		// Mock private method using any cast
		;(provider as any).updateGlobalState = vi.fn().mockResolvedValue(undefined)
		provider.activateProviderProfile = vi.fn().mockResolvedValue(undefined)
		provider.getTaskWithId = vi.fn().mockImplementation((id) =>
			Promise.resolve({
				historyItem: {
					id,
					number: 1,
					ts: Date.now(),
					task: "test task",
					tokensIn: 100,
					tokensOut: 200,
					totalCost: 0.001,
					workspace: "/test/workspace",
				},
			}),
		)

		// Setup mock tasks
		mockTask1 = {
			taskId: "task-1",
			instanceId: "instance-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			abandoned: false,
			dispose: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}

		mockTask2 = {
			taskId: "task-1", // Same ID for rehydration scenario
			instanceId: "instance-2", // Different instance
			emit: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}
	})

	it("should not remove current task from stack when rehydrating same taskId", async () => {
		// Setup: Add a task to the stack first
		const stack = (provider as any).taskStack
		await stack.add(mockTask1)

		// Mock event listeners for cleanup
		const mockCleanupFunctions = [vi.fn(), vi.fn()]
		stack.setCleanup(mockTask1, mockCleanupFunctions)

		// Spy on removeClineFromStack to verify it's NOT called
		const removeClineFromStackSpy = vi.spyOn(provider, "removeClineFromStack")

		// Create history item with same taskId as current task
		const historyItem: HistoryItem = {
			id: "task-1", // Same as mockTask1.taskId
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		// Act: Create task with history item (should rehydrate in-place)
		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: removeClineFromStack should NOT be called
		expect(removeClineFromStackSpy).not.toHaveBeenCalled()

		// Verify the task was replaced in-place
		expect(stack.items).toHaveLength(1)
		expect(stack.items[0]).toBe(mockTask2)

		// Verify old event listeners were cleaned up
		expect(mockCleanupFunctions[0]).toHaveBeenCalled()
		expect(mockCleanupFunctions[1]).toHaveBeenCalled()

		// Verify new task received focus event
		expect(mockTask2.emit).toHaveBeenCalledWith("taskFocused")
	})

	it("should remove task from stack when creating different task", async () => {
		// Setup: Add a task to the stack first
		await (provider as any).taskStack.add(mockTask1)

		// Spy on removeClineFromStack to verify it IS called
		const removeClineFromStackSpy = vi.spyOn(provider, "removeClineFromStack").mockResolvedValue(undefined)

		// Create history item with different taskId
		const historyItem: HistoryItem = {
			id: "task-2", // Different from mockTask1.taskId
			number: 2,
			task: "different task",
			ts: Date.now(),
			tokensIn: 150,
			tokensOut: 250,
			totalCost: 0.002,
			workspace: "/test/workspace",
		}

		// Act: Create task with different history item
		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: removeClineFromStack should be called
		expect(removeClineFromStackSpy).toHaveBeenCalled()
	})

	it("should handle empty stack gracefully during rehydration attempt", async () => {
		// Setup: Empty stack (controller starts empty)

		// Spy on removeClineFromStack
		const removeClineFromStackSpy = vi.spyOn(provider, "removeClineFromStack").mockResolvedValue(undefined)

		// Create history item
		const historyItem: HistoryItem = {
			id: "task-1",
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		// Act: Should not error and should call removeClineFromStack
		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: removeClineFromStack should be called (no current task to rehydrate)
		expect(removeClineFromStackSpy).toHaveBeenCalled()
	})

	it("should maintain task stack integrity during flicker-free replacement", async () => {
		// Setup: Stack with multiple tasks
		const mockParentTask = {
			taskId: "parent-task",
			instanceId: "parent-instance",
			emit: vi.fn(),
		}

		const stack = (provider as any).taskStack
		await stack.add(mockParentTask)
		await stack.add(mockTask1)
		stack.setCleanup(mockTask1, [vi.fn()])

		// Act: Rehydrate the current (top) task
		const historyItem: HistoryItem = {
			id: "task-1",
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: Stack should maintain parent task and replace current task
		expect(stack.items).toHaveLength(2)
		expect(stack.items[0]).toBe(mockParentTask)
		expect(stack.items[1]).toBe(mockTask2)
	})
})
