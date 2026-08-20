// npx vitest run core/task/__tests__/flushPendingToolResultsToHistory.spec.ts

import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { GlobalState, ProviderSettings } from "@openai-agent/types"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { makeFakeCollaborators } from "./makeFakeCollaborators"

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

const { mockPWaitFor } = vi.hoisted(() => {
	return { mockPWaitFor: vi.fn().mockImplementation(async () => Promise.resolve()) }
})

vi.mock("p-wait-for", () => ({
	default: mockPWaitFor,
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (key: string, defaultValue: any) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(() => mockEventEmitter),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../condense", async (importOriginal) => {
	const actual = (await importOriginal()) as any
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "continued" }], ts: Date.now() },
			],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockReturnValue(false),
}))

describe("flushPendingToolResultsToHistory", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: any
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		mockApiConfig = {
			apiProvider: "openai",
			apiModelId: "claude-3-5-sonnet-20241022",
			openAiApiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.updateTaskHistory = vi.fn().mockResolvedValue(undefined)
	})

	it("should not save anything when userMessageContent is empty", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		// Ensure userMessageContent is empty
		task.stream.userMessageContent = []
		const initialHistoryLength = task.messageStore.apiConversationHistory.length

		// Call flush
		await task.flushPendingToolResultsToHistory()

		// History should not have changed since userMessageContent was empty
		expect(task.messageStore.apiConversationHistory.length).toBe(initialHistoryLength)
	})

	it("should save user message when userMessageContent has pending tool results", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		// Set up pending tool result in userMessageContent
		task.stream.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-123",
				content: "File written successfully",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// 履歴は AgentMessage の item 列になったので、tool_result ブロックは user メッセージの
		// content ではなく独立した function_call_output item として積まれる。
		expect(task.messageStore.apiConversationHistory).toHaveLength(1)
		expect(task.messageStore.apiConversationHistory[0]).toMatchObject({
			type: "function_call_output",
			call_id: "tool-123",
			output: "File written successfully",
		})
	})

	it("should clear userMessageContent after flushing", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		// Set up pending tool result
		task.stream.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-456",
				content: "Command executed",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// userMessageContent should be cleared
		expect(task.stream.userMessageContent.length).toBe(0)
	})

	it("should handle multiple tool results in a single flush", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		// Set up multiple pending tool results
		task.stream.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-1",
				content: "First result",
			},
			{
				type: "tool_result",
				tool_use_id: "tool-2",
				content: "Second result",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// tool_result 1 件につき 1 item に割れるので、履歴は 2 件になる（順序は保たれる）
		const items = task.messageStore.apiConversationHistory
		expect(items).toHaveLength(2)
		expect(items[0]).toMatchObject({ type: "function_call_output", call_id: "tool-1", output: "First result" })
		expect(items[1]).toMatchObject({ type: "function_call_output", call_id: "tool-2", output: "Second result" })
	})

	it("should add timestamp to saved messages", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		const beforeTs = Date.now()

		task.stream.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-ts",
				content: "Result",
			},
		]

		await task.flushPendingToolResultsToHistory()

		const afterTs = Date.now()

		// Message should have timestamp
		expect((task.messageStore.apiConversationHistory[0] as any).ts).toBeGreaterThanOrEqual(beforeTs)
		expect((task.messageStore.apiConversationHistory[0] as any).ts).toBeLessThanOrEqual(afterTs)
	})

	it("should skip waiting for assistantMessageSavedToHistory when flag is already true", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		// Set flag to true (assistant message already saved)
		task.stream.assistantMessageSavedToHistory = true

		// Set up pending tool result
		task.stream.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-skip-wait",
				content: "Result when flag is true",
			},
		]

		// Clear mock call history
		mockPWaitFor.mockClear()

		await task.flushPendingToolResultsToHistory()

		// Should not have called pWaitFor since flag was already true
		expect(mockPWaitFor).not.toHaveBeenCalled()

		// Should still save the message
		expect(task.messageStore.apiConversationHistory).toHaveLength(1)
		expect(task.messageStore.apiConversationHistory[0]).toMatchObject({
			type: "function_call_output",
			call_id: "tool-skip-wait",
		})
	})

	it("should wait for assistantMessageSavedToHistory when flag is false", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		// Flag is false by default - assistant message not yet saved
		expect(task.stream.assistantMessageSavedToHistory).toBe(false)

		// Set up pending tool result
		task.stream.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-wait",
				content: "Result when flag is false",
			},
		]

		// Clear mock call history
		mockPWaitFor.mockClear()

		await task.flushPendingToolResultsToHistory()

		// Should have called pWaitFor since flag was false
		expect(mockPWaitFor).toHaveBeenCalled()

		// Should still save the message (mock resolves immediately)
		expect(task.messageStore.apiConversationHistory.length).toBe(1)
	})

	it("pWaitFor の predicate は saved フラグ or abort を評価する", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		task.stream.assistantMessageSavedToHistory = false
		task.stream.userMessageContent = [{ type: "tool_result", tool_use_id: "tool-pred", content: "x" }]

		// pWaitFor に渡る predicate を実際に呼び、interval コールバックを踏ませる
		let predResult: unknown
		mockPWaitFor.mockImplementationOnce(async (pred: any) => {
			predResult = pred()
		})

		await task.flushPendingToolResultsToHistory()

		expect(predResult).toBe(false) // saved=false かつ abort=false
		expect(task.messageStore.apiConversationHistory.length).toBe(1)
	})

	it("pWaitFor が timeout/reject しても warn してそのまま保存を続行する", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		task.stream.assistantMessageSavedToHistory = false
		task.stream.userMessageContent = [{ type: "tool_result", tool_use_id: "tool-timeout", content: "x" }]
		mockPWaitFor.mockRejectedValueOnce(new Error("timeout"))

		await task.flushPendingToolResultsToHistory()

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("timed out waiting for assistant message"))
		// timeout でも（abort でなければ）保存は進む
		expect(task.messageStore.apiConversationHistory.length).toBe(1)
		warnSpy.mockRestore()
	})

	it("直前の実効メッセージが assistant ターンなら tool_result ID を検証してから積む", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		// 履歴末尾を assistant ターン（function_call）にしておく → validate 経路の consequent を踏む
		task.messageStore.apiConversationHistory = [
			{ type: "function_call", call_id: "call-1", name: "read_file", arguments: "{}", ts: 1 } as never,
		]
		task.stream.assistantMessageSavedToHistory = true
		task.stream.userMessageContent = [{ type: "tool_result", tool_use_id: "call-1", content: "done" }]

		await task.flushPendingToolResultsToHistory()

		// function_call + その出力の 2 件になる
		expect(task.messageStore.apiConversationHistory).toHaveLength(2)
		expect(task.messageStore.apiConversationHistory[1]).toMatchObject({
			type: "function_call_output",
			call_id: "call-1",
			output: "done",
		})
	})

	it("should not flush when task is aborted during wait", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			collaborators: makeFakeCollaborators(),
		})

		// Flag is false - will need to wait
		task.stream.assistantMessageSavedToHistory = false

		// Set up pending tool result
		task.stream.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-aborted",
				content: "Should not be saved",
			},
		]

		// Set abort flag - this will cause the condition in pWaitFor to return true
		// AND will cause early return after the wait
		task.abort = true

		await task.flushPendingToolResultsToHistory()

		// Should not have saved anything since task was aborted
		expect(task.messageStore.apiConversationHistory.length).toBe(0)
	})
})
