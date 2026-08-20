// npx vitest run core/task/__tests__/Task.collaborator-injection.spec.ts

import type { ProviderSettings } from "@openai-agent/types"

import { AgentIgnoreController } from "../../ignore/AgentIgnoreController"
import type { ClineProvider } from "../../webview/ClineProvider"
import { Task } from "../Task"
import { makeFakeCollaborators } from "./makeFakeCollaborators"

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }

	return {
		TabInputTextDiff: vi.fn(),
		TabInputText: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [],
			tabGroups: {
				all: [],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => mockDisposable),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			getConfiguration: vi.fn(() => ({ get: (_k: string, d: any) => d })),
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace/path" }, name: "mock-workspace", index: 0 }],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: { stat: vi.fn().mockResolvedValue({ type: 1 }) },
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
		},
		env: { uriScheme: "vscode", language: "en" },
		EventEmitter: vi.fn().mockImplementation(() => mockEventEmitter),
		Disposable: { from: vi.fn() },
		// 注入なしの経路（実 AgentIgnoreController）でのみ必要になる surface。
		RelativePattern: vi.fn().mockImplementation((base: unknown, pattern: string) => ({ base, pattern })),
		version: "1.85.0",
	}
})

const apiConfiguration = {
	apiProvider: "openai",
	apiModelId: "claude-3-5-sonnet-20241022",
	openAiApiKey: "test-api-key",
} as unknown as ProviderSettings

function makeProvider(): ClineProvider {
	return {
		context: { globalStorageUri: { fsPath: "/test/storage" } },
		getState: vi.fn().mockResolvedValue({}),
		log: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue(undefined),
	} as unknown as ClineProvider
}

describe("Task collaborator injection", () => {
	it("uses injected collaborators verbatim instead of building real ones", () => {
		const collaborators = makeFakeCollaborators()

		const task = new Task({
			provider: makeProvider(),
			apiConfiguration,
			task: "test task",
			startTask: false,
			collaborators,
		})

		expect(task.rooIgnoreController).toBe(collaborators.rooIgnoreController)
		expect(task.rooProtectedController).toBe(collaborators.rooProtectedController)
		expect(task.fileContextTracker).toBe(collaborators.fileContextTracker)
		expect(task.messageStore).toBe(collaborators.messageStore)
		expect(task.messageQueueService).toBe(collaborators.messageQueueService)
		expect(task.mistakeTracker).toBe(collaborators.mistakeTracker)
		expect(task.api).toBe(collaborators.api)
		expect(task.apiConfiguration).toBe(collaborators.apiConfiguration)

		// factory を経由していない証拠: 実 collaborator の初期化 I/O が走らない。
		expect(collaborators.rooIgnoreController.initialize).not.toHaveBeenCalled()
	})

	it("still builds production collaborators when none are injected", () => {
		const task = new Task({
			provider: makeProvider(),
			apiConfiguration,
			task: "test task",
			startTask: false,
		})

		expect(task.rooIgnoreController).toBeInstanceOf(AgentIgnoreController)
		expect(task.api.getModel().id).toBeDefined()
	})

	it("lets a test override a single collaborator without touching the rest", () => {
		const messageStore = { apiConversationHistory: [], clineMessages: [] }
		const collaborators = makeFakeCollaborators({ messageStore: messageStore as any })

		const task = new Task({
			provider: makeProvider(),
			apiConfiguration,
			task: "test task",
			startTask: false,
			collaborators,
		})

		expect(task.messageStore).toBe(messageStore)
		expect(task.mistakeTracker.limit).toBe(3)
	})
})
