import { CodeIndexManager } from "../manager"
import { CodeIndexServiceFactory } from "../service-factory"
import type { MockedClass } from "vitest"
import * as path from "path"

// Helper: create a mock vscode.Uri from an fsPath
function mockUri(fsPath: string, scheme = "file") {
	return {
		fsPath,
		scheme,
		authority: "",
		path: fsPath,
		toString: (_skipEncoding?: boolean) => `${scheme}://${fsPath}`,
	}
}

// Mock vscode module
vi.mock("vscode", () => {
	// vi.mock ファクトリは Vitest によって巻き上げられるため、
	// トップレベル import は使えない（TDZ）。動的 require で回避する。
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const testPath = require("path")
	const testWorkspacePath = testPath.join(testPath.sep, "test", "workspace")
	return {
		Uri: {
			file: (p: string) => ({
				fsPath: p,
				scheme: "file",
				authority: "",
				path: p,
				toString: (_skipEncoding?: boolean) => `file://${p}`,
			}),
			joinPath: vi.fn((...args: any[]) => ({ fsPath: args.join("/") })),
		},
		window: {
			activeTextEditor: null,
		},
		workspace: {
			workspaceFolders: [
				{
					uri: {
						fsPath: testWorkspacePath,
						scheme: "file",
						authority: "",
						path: testWorkspacePath,
						toString: (_skipEncoding?: boolean) => `file://${testWorkspacePath}`,
					},
					name: "test",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn().mockReturnValue({
				onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				dispose: vi.fn(),
			}),
			getWorkspaceFolder: vi.fn(),
		},
		RelativePattern: vi.fn().mockImplementation((base: any, pattern: any) => ({ base, pattern })),
	}
})

// Mock only the essential dependencies
vi.mock("../../../utils/path", () => {
	// vi.mock ファクトリは Vitest によって巻き上げられるため、
	// トップレベル import は使えない（TDZ）。動的 require で回避する。
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const testPath = require("path")
	const testWorkspacePath = testPath.join(testPath.sep, "test", "workspace")
	return {
		getWorkspacePath: vi.fn(() => testWorkspacePath),
	}
})

// Mock fs/promises for AgentIgnoreController
vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockRejectedValue(new Error("File not found")),
	},
}))

// Mock file utils for AgentIgnoreController
vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(false),
}))

// Mock ignore module
vi.mock("ignore", () => ({
	default: vi.fn().mockReturnValue({
		add: vi.fn(),
		ignores: vi.fn().mockReturnValue(false),
	}),
}))

vi.mock("../state-manager", () => ({
	CodeIndexStateManager: vi.fn().mockImplementation(() => ({
		onProgressUpdate: vi.fn(),
		getCurrentStatus: vi.fn(),
		dispose: vi.fn(),
		setSystemState: vi.fn(),
	})),
}))

vi.mock("../service-factory")
const MockedCodeIndexServiceFactory = CodeIndexServiceFactory as MockedClass<typeof CodeIndexServiceFactory>

describe("CodeIndexManager - handleSettingsChange regression", () => {
	let mockContext: any
	let manager: CodeIndexManager

	// Define test paths for use in tests
	const testWorkspacePath = path.join(path.sep, "test", "workspace")
	const testExtensionPath = path.join(path.sep, "test", "extension")
	const testStoragePath = path.join(path.sep, "test", "storage")
	const testGlobalStoragePath = path.join(path.sep, "test", "global-storage")
	const testLogPath = path.join(path.sep, "test", "log")

	beforeEach(() => {
		// Clear all instances before each test
		CodeIndexManager.disposeAll()

		const workspaceStateStore: Record<string, any> = {}
		const globalStateStore: Record<string, any> = {}
		mockContext = {
			subscriptions: [],
			workspaceState: {
				get: vi.fn((key: string, defaultValue?: any) => workspaceStateStore[key] ?? defaultValue),
				update: vi.fn(async (key: string, value: any) => {
					workspaceStateStore[key] = value
				}),
			} as any,
			globalState: {
				get: vi.fn((key: string, defaultValue?: any) => globalStateStore[key] ?? defaultValue),
				update: vi.fn(async (key: string, value: any) => {
					globalStateStore[key] = value
				}),
			} as any,
			extensionUri: {} as any,
			extensionPath: testExtensionPath,
			asAbsolutePath: vi.fn(),
			storageUri: {} as any,
			storagePath: testStoragePath,
			globalStorageUri: {} as any,
			globalStoragePath: testGlobalStoragePath,
			logUri: {} as any,
			logPath: testLogPath,
			extensionMode: 3, // vscode.ExtensionMode.Test
			secrets: {} as any,
			environmentVariableCollection: {} as any,
			extension: {} as any,
			languageModelAccessInformation: {} as any,
		}

		manager = CodeIndexManager.getInstance(mockContext)!
	})

	afterEach(() => {
		CodeIndexManager.disposeAll()
	})

	describe("handleSettingsChange", () => {
		it("should not throw when called on uninitialized manager (regression test)", async () => {
			// This is the core regression test: handleSettingsChange() should not throw
			// when called before the manager is initialized (during first-time configuration)

			// Ensure manager is not initialized
			expect(manager.isInitialized).toBe(false)

			// Mock a minimal config manager that simulates first-time configuration
			const mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: true }),
				isFeatureConfigured: true,
				isFeatureEnabled: true,
				getConfig: vi.fn().mockReturnValue({
					isConfigured: true,
					embedderProvider: "openai-compatible",
					modelId: "text-embedding-3-small",
					openAiOptions: { openAiNativeApiKey: "test-key" },
					qdrantUrl: "http://localhost:6333",
					qdrantApiKey: "test-key",
					searchMinScore: 0.4,
				}),
			}
			;(manager as any)._configManager = mockConfigManager

			// Mock cache manager
			const mockCacheManager = {
				initialize: vi.fn(),
				clearCacheFile: vi.fn(),
			}
			;(manager as any)._cacheManager = mockCacheManager

			// Mock the feature state to simulate valid configuration that would normally trigger restart
			vi.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)
			vi.spyOn(manager, "isFeatureConfigured", "get").mockReturnValue(true)

			// Mock service factory to handle _recreateServices call
			const mockServiceFactoryInstance = {
				configManager: mockConfigManager,
				workspacePath: testWorkspacePath,
				cacheManager: mockCacheManager,
				createEmbedder: vi.fn().mockReturnValue({ embedderInfo: { name: "openai" } }),
				createVectorStore: vi.fn().mockReturnValue({}),
				createDirectoryScanner: vi.fn().mockReturnValue({}),
				createFileWatcher: vi.fn().mockReturnValue({
					onDidStartBatchProcessing: vi.fn(),
					onBatchProgressUpdate: vi.fn(),
					watch: vi.fn(),
					stopWatcher: vi.fn(),
					dispose: vi.fn(),
				}),
				createServices: vi.fn().mockReturnValue({
					embedder: { embedderInfo: { name: "openai" } },
					vectorStore: {},
					scanner: {},
					fileWatcher: {
						onDidStartBatchProcessing: vi.fn(),
						onBatchProgressUpdate: vi.fn(),
						watch: vi.fn(),
						stopWatcher: vi.fn(),
						dispose: vi.fn(),
					},
				}),
				validateEmbedder: vi.fn().mockResolvedValue({ valid: true }),
			}
			MockedCodeIndexServiceFactory.mockImplementation(() => mockServiceFactoryInstance as any)

			// The key test: this should NOT throw "CodeIndexManager not initialized" error
			await expect(manager.handleSettingsChange()).resolves.not.toThrow()

			// Verify that loadConfiguration was called (the method should still work)
			expect(mockConfigManager.loadConfiguration).toHaveBeenCalled()
		})

		it("should work normally when manager is initialized", async () => {
			// Mock a complete config manager with all required properties
			const mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: true }),
				isFeatureConfigured: true,
				isFeatureEnabled: true,
				getConfig: vi.fn().mockReturnValue({
					isConfigured: true,
					embedderProvider: "openai-compatible",
					modelId: "text-embedding-3-small",
					openAiOptions: { openAiNativeApiKey: "test-key" },
					qdrantUrl: "http://localhost:6333",
					qdrantApiKey: "test-key",
					searchMinScore: 0.4,
				}),
			}
			;(manager as any)._configManager = mockConfigManager

			// Mock cache manager
			const mockCacheManager = {
				initialize: vi.fn(),
				clearCacheFile: vi.fn(),
			}
			;(manager as any)._cacheManager = mockCacheManager

			// Simulate an initialized manager by setting the required properties
			;(manager as any)._orchestrator = { stopWatcher: vi.fn(), stopIndexing: vi.fn() }
			;(manager as any)._searchService = {}

			// Verify manager is considered initialized
			expect(manager.isInitialized).toBe(true)

			// Mock the feature state
			vi.spyOn(manager, "isFeatureEnabled", "get").mockReturnValue(true)
			vi.spyOn(manager, "isFeatureConfigured", "get").mockReturnValue(true)

			// Mock service factory to handle _recreateServices call
			const mockServiceFactoryInstance = {
				configManager: mockConfigManager,
				workspacePath: testWorkspacePath,
				cacheManager: mockCacheManager,
				createEmbedder: vi.fn().mockReturnValue({ embedderInfo: { name: "openai" } }),
				createVectorStore: vi.fn().mockReturnValue({}),
				createDirectoryScanner: vi.fn().mockReturnValue({}),
				createFileWatcher: vi.fn().mockReturnValue({
					onDidStartBatchProcessing: vi.fn(),
					onBatchProgressUpdate: vi.fn(),
					watch: vi.fn(),
					stopWatcher: vi.fn(),
					dispose: vi.fn(),
				}),
				createServices: vi.fn().mockReturnValue({
					embedder: { embedderInfo: { name: "openai" } },
					vectorStore: {},
					scanner: {},
					fileWatcher: {
						onDidStartBatchProcessing: vi.fn(),
						onBatchProgressUpdate: vi.fn(),
						watch: vi.fn(),
						stopWatcher: vi.fn(),
						dispose: vi.fn(),
					},
				}),
				validateEmbedder: vi.fn().mockResolvedValue({ valid: true }),
			}
			MockedCodeIndexServiceFactory.mockImplementation(() => mockServiceFactoryInstance as any)

			// Mock the methods that would be called during restart
			const recreateServicesSpy = vi.spyOn(manager as any, "_recreateServices")

			await manager.handleSettingsChange()

			// Verify that the restart sequence was called
			expect(mockConfigManager.loadConfiguration).toHaveBeenCalled()
			// _recreateServices should be called when requiresRestart is true
			expect(recreateServicesSpy).toHaveBeenCalled()
			// Note: startIndexing is NOT called by handleSettingsChange - it's only called by initialize()
		})

		it("should handle case when config manager is not set", async () => {
			// Ensure config manager is not set (edge case)
			;(manager as any)._configManager = undefined

			// This should not throw an error
			await expect(manager.handleSettingsChange()).resolves.not.toThrow()
		})
	})

	describe("embedder validation integration", () => {
		let mockServiceFactoryInstance: any
		let mockStateManager: any
		let mockEmbedder: any
		let mockVectorStore: any
		let mockScanner: any
		let mockFileWatcher: any

		beforeEach(() => {
			// Mock service factory objects
			mockEmbedder = { embedderInfo: { name: "openai" } }
			mockVectorStore = {}
			mockScanner = {}
			mockFileWatcher = {
				onDidStartBatchProcessing: vi.fn(),
				onBatchProgressUpdate: vi.fn(),
				watch: vi.fn(),
				stopWatcher: vi.fn(),
				dispose: vi.fn(),
			}

			// Mock service factory instance
			mockServiceFactoryInstance = {
				createServices: vi.fn().mockReturnValue({
					embedder: mockEmbedder,
					vectorStore: mockVectorStore,
					scanner: mockScanner,
					fileWatcher: mockFileWatcher,
				}),
				validateEmbedder: vi.fn(),
			}

			// Mock the ServiceFactory constructor
			MockedCodeIndexServiceFactory.mockImplementation(() => mockServiceFactoryInstance)

			// Mock state manager methods directly on the existing instance
			mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()

			// Mock config manager
			const mockConfigManager = {
				loadConfiguration: vitest.fn().mockResolvedValue({ requiresRestart: false }),
				isFeatureConfigured: true,
				isFeatureEnabled: true,
				getConfig: vitest.fn().mockReturnValue({
					isConfigured: true,
					embedderProvider: "openai-compatible",
					modelId: "text-embedding-3-small",
					openAiOptions: { openAiNativeApiKey: "test-key" },
					qdrantUrl: "http://localhost:6333",
					qdrantApiKey: "test-key",
					searchMinScore: 0.4,
				}),
			}
			;(manager as any)._configManager = mockConfigManager
		})

		it("should validate embedder during _recreateServices when validation succeeds", async () => {
			// Arrange
			mockServiceFactoryInstance.validateEmbedder.mockResolvedValue({ valid: true })

			// Act - directly call the private method for testing
			await (manager as any)._recreateServices()

			// Assert
			expect(mockServiceFactoryInstance.createServices).toHaveBeenCalled()
			const createdEmbedder = mockServiceFactoryInstance.createServices.mock.results[0].value.embedder
			expect(mockServiceFactoryInstance.validateEmbedder).toHaveBeenCalledWith(createdEmbedder)
			expect(mockStateManager.setSystemState).not.toHaveBeenCalledWith("Error", expect.any(String))
		})

		it("should set error state when embedder validation fails", async () => {
			// Arrange
			mockServiceFactoryInstance.validateEmbedder.mockResolvedValue({
				valid: false,
				error: "embeddings:validation.authenticationFailed",
			})

			// Act & Assert
			await expect((manager as any)._recreateServices()).rejects.toThrow(
				"embeddings:validation.authenticationFailed",
			)

			// Assert other expectations
			expect(mockServiceFactoryInstance.createServices).toHaveBeenCalled()
			const createdEmbedder = mockServiceFactoryInstance.createServices.mock.results[0].value.embedder
			expect(mockServiceFactoryInstance.validateEmbedder).toHaveBeenCalledWith(createdEmbedder)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				"embeddings:validation.authenticationFailed",
			)
		})

		it("should set generic error state when embedder validation throws", async () => {
			// Arrange
			// Since the real service factory catches exceptions, we should mock it to resolve with an error
			mockServiceFactoryInstance.validateEmbedder.mockResolvedValue({
				valid: false,
				error: "embeddings:validation.configurationError",
			})

			// Act & Assert
			await expect((manager as any)._recreateServices()).rejects.toThrow(
				"embeddings:validation.configurationError",
			)

			// Assert other expectations
			expect(mockServiceFactoryInstance.createServices).toHaveBeenCalled()
			const createdEmbedder = mockServiceFactoryInstance.createServices.mock.results[0].value.embedder
			expect(mockServiceFactoryInstance.validateEmbedder).toHaveBeenCalledWith(createdEmbedder)
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith(
				"Error",
				"embeddings:validation.configurationError",
			)
		})

		it("should handle embedder creation failure", async () => {
			// Arrange
			mockServiceFactoryInstance.createServices.mockImplementation(() => {
				throw new Error("Invalid configuration")
			})

			// Act & Assert - should throw the error
			await expect((manager as any)._recreateServices()).rejects.toThrow("Invalid configuration")

			// Should not attempt validation if embedder creation fails
			expect(mockServiceFactoryInstance.validateEmbedder).not.toHaveBeenCalled()
		})
	})

	describe("recoverFromError", () => {
		let mockConfigManager: any
		let mockCacheManager: any
		let mockStateManager: any

		beforeEach(() => {
			// Mock config manager
			mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
				isFeatureConfigured: true,
				isFeatureEnabled: true,
				getConfig: vi.fn().mockReturnValue({
					isConfigured: true,
					embedderProvider: "openai-compatible",
					modelId: "text-embedding-3-small",
					openAiOptions: { openAiNativeApiKey: "test-key" },
					qdrantUrl: "http://localhost:6333",
					qdrantApiKey: "test-key",
					searchMinScore: 0.4,
				}),
			}
			;(manager as any)._configManager = mockConfigManager

			// Mock cache manager
			mockCacheManager = {
				initialize: vi.fn(),
				clearCacheFile: vi.fn(),
			}
			;(manager as any)._cacheManager = mockCacheManager

			// Mock state manager
			mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()
			mockStateManager.getCurrentStatus = vi.fn().mockReturnValue({
				systemStatus: "Error",
				message: "Failed during initial scan: fetch failed",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			})

			// Mock orchestrator and search service to simulate initialized state
			;(manager as any)._orchestrator = { stopWatcher: vi.fn(), stopIndexing: vi.fn(), state: "Error" }
			;(manager as any)._searchService = {}
			;(manager as any)._serviceFactory = {}
		})

		it("should clear error state when recoverFromError is called", async () => {
			// Act
			await manager.recoverFromError()

			// Assert
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "")
		})

		it("should reset internal service instances", async () => {
			// Verify initial state
			expect((manager as any)._configManager).toBeDefined()
			expect((manager as any)._serviceFactory).toBeDefined()
			expect((manager as any)._orchestrator).toBeDefined()
			expect((manager as any)._searchService).toBeDefined()

			// Act
			await manager.recoverFromError()

			// Assert - all service instances should be undefined
			expect((manager as any)._configManager).toBeUndefined()
			expect((manager as any)._serviceFactory).toBeUndefined()
			expect((manager as any)._orchestrator).toBeUndefined()
			expect((manager as any)._searchService).toBeUndefined()
		})

		it("should make manager report as not initialized after recovery", async () => {
			// Verify initial state
			expect(manager.isInitialized).toBe(true)

			// Act
			await manager.recoverFromError()

			// Assert
			expect(manager.isInitialized).toBe(false)
		})

		it("should allow re-initialization after recovery", async () => {
			// Setup mock for re-initialization
			const mockServiceFactoryInstance = {
				createServices: vi.fn().mockReturnValue({
					embedder: { embedderInfo: { name: "openai" } },
					vectorStore: {},
					scanner: {},
					fileWatcher: {
						onDidStartBatchProcessing: vi.fn(),
						onBatchProgressUpdate: vi.fn(),
						watch: vi.fn(),
						stopWatcher: vi.fn(),
						dispose: vi.fn(),
					},
				}),
				validateEmbedder: vi.fn().mockResolvedValue({ valid: true }),
			}
			MockedCodeIndexServiceFactory.mockImplementation(() => mockServiceFactoryInstance as any)

			// Act - recover from error
			await manager.recoverFromError()

			// Verify manager is not initialized
			expect(manager.isInitialized).toBe(false)

			// Mock context proxy for initialization
			const mockContextProxy = {
				getValue: vi.fn(),
				setValue: vi.fn(),
				storeSecret: vi.fn(),
				getSecret: vi.fn(),
				refreshSecrets: vi.fn().mockResolvedValue(undefined),
				getGlobalState: vi.fn().mockReturnValue({
					codebaseIndexEnabled: true,
					codebaseIndexQdrantUrl: "http://localhost:6333",
					codebaseIndexEmbedderProvider: "openai-compatible",
					codebaseIndexEmbedderModelId: "text-embedding-3-small",
					codebaseIndexEmbedderModelDimension: 1536,
					codebaseIndexSearchMaxResults: 10,
					codebaseIndexSearchMinScore: 0.4,
				}),
			}

			// Enable workspace indexing before re-initialization
			await manager.setWorkspaceEnabled(true)

			// Re-initialize
			await manager.initialize(mockContextProxy as any)

			// Assert - manager should be initialized again
			expect(manager.isInitialized).toBe(true)
			expect(mockServiceFactoryInstance.createServices).toHaveBeenCalled()
			expect(mockServiceFactoryInstance.validateEmbedder).toHaveBeenCalled()
		})

		it("should be safe to call when not in error state (idempotent)", async () => {
			// Setup manager in non-error state
			mockStateManager.getCurrentStatus.mockReturnValue({
				systemStatus: "Standby",
				message: "",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			})

			// Verify initial state is not error
			const initialStatus = manager.getCurrentStatus()
			expect(initialStatus.systemStatus).not.toBe("Error")

			// Act - call recoverFromError when not in error state
			await expect(manager.recoverFromError()).resolves.not.toThrow()

			// Assert - should still clear state and service instances
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "")
			expect((manager as any)._configManager).toBeUndefined()
			expect((manager as any)._serviceFactory).toBeUndefined()
			expect((manager as any)._orchestrator).toBeUndefined()
			expect((manager as any)._searchService).toBeUndefined()
		})

		it("should continue recovery even if setSystemState throws", async () => {
			// Setup state manager to throw on setSystemState
			mockStateManager.setSystemState.mockImplementation(() => {
				throw new Error("State update failed")
			})

			// Setup manager with service instances
			;(manager as any)._configManager = mockConfigManager
			;(manager as any)._serviceFactory = {}
			;(manager as any)._orchestrator = { stopWatcher: vi.fn(), stopIndexing: vi.fn() }
			;(manager as any)._searchService = {}

			// Spy on console.error
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			// Act - should not throw despite setSystemState error
			await expect(manager.recoverFromError()).resolves.not.toThrow()

			// Assert - error should be logged
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Failed to clear error state during recovery:",
				expect.any(Error),
			)

			// Assert - service instances should still be cleared
			expect((manager as any)._configManager).toBeUndefined()
			expect((manager as any)._serviceFactory).toBeUndefined()
			expect((manager as any)._orchestrator).toBeUndefined()
			expect((manager as any)._searchService).toBeUndefined()

			// Cleanup
			consoleErrorSpy.mockRestore()
		})
	})

	describe("workspace-enabled gating", () => {
		it("should not start indexing when workspace is not enabled", async () => {
			await manager.setAutoEnableDefault(false)

			const mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()
			mockStateManager.getCurrentStatus = vi.fn().mockReturnValue({
				systemStatus: "Standby",
				message: "",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			})

			expect(manager.isWorkspaceEnabled).toBe(false)

			await manager.startIndexing()

			expect(mockStateManager.setSystemState).not.toHaveBeenCalledWith("Indexing", expect.any(String))
		})

		it("should include workspaceEnabled in getCurrentStatus", async () => {
			await manager.setAutoEnableDefault(false)

			const mockStateManager = (manager as any)._stateManager
			mockStateManager.getCurrentStatus = vi.fn().mockReturnValue({
				systemStatus: "Standby",
				message: "",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "items",
			})

			const status = manager.getCurrentStatus()
			expect(status.workspaceEnabled).toBe(false)
		})

		it("should persist workspace enabled state", async () => {
			await manager.setAutoEnableDefault(false)
			expect(manager.isWorkspaceEnabled).toBe(false)

			await manager.setWorkspaceEnabled(true)
			expect(manager.isWorkspaceEnabled).toBe(true)

			await manager.setWorkspaceEnabled(false)
			expect(manager.isWorkspaceEnabled).toBe(false)
		})

		it("should store enablement per folder URI, not per window", async () => {
			CodeIndexManager.disposeAll()

			const vscode = await import("vscode")

			const folderAPath = path.join(path.sep, "test", "folderA")
			const folderBPath = path.join(path.sep, "test", "folderB")
			const folderAUri = mockUri(folderAPath)
			const folderBUri = mockUri(folderBPath)

			// Both folders share the same workspaceState (same window)
			const sharedStore: Record<string, any> = {}
			const sharedContext = {
				...mockContext,
				workspaceState: {
					get: vi.fn((key: string, defaultValue?: any) => sharedStore[key] ?? defaultValue),
					update: vi.fn(async (key: string, value: any) => {
						sharedStore[key] = value
					}),
				} as any,
				globalState: {
					get: vi.fn((_key: string, _defaultValue?: any) => false),
					update: vi.fn(),
				} as any,
			}

			// Patch workspaceFolders to include both folders
			;(vscode.workspace as any).workspaceFolders = [
				{ uri: folderAUri, name: "folderA", index: 0 },
				{ uri: folderBUri, name: "folderB", index: 1 },
			]

			const managerA = CodeIndexManager.getInstance(sharedContext as any, folderAPath)!
			const managerB = CodeIndexManager.getInstance(sharedContext as any, folderBPath)!

			// Both start disabled (autoEnableDefault is false via globalState mock)
			expect(managerA.isWorkspaceEnabled).toBe(false)
			expect(managerB.isWorkspaceEnabled).toBe(false)

			// Enable A only
			await managerA.setWorkspaceEnabled(true)

			expect(managerA.isWorkspaceEnabled).toBe(true)
			expect(managerB.isWorkspaceEnabled).toBe(false)

			// Enable B, disable A
			await managerB.setWorkspaceEnabled(true)
			await managerA.setWorkspaceEnabled(false)

			expect(managerA.isWorkspaceEnabled).toBe(false)
			expect(managerB.isWorkspaceEnabled).toBe(true)

			CodeIndexManager.disposeAll()
		})
	})

	describe("stopIndexing", () => {
		it("should delegate to orchestrator.stopIndexing()", () => {
			const mockOrchestrator = {
				stopIndexing: vi.fn(),
				stopWatcher: vi.fn(),
				state: "Indexing",
			}
			;(manager as any)._orchestrator = mockOrchestrator

			manager.stopIndexing()

			expect(mockOrchestrator.stopIndexing).toHaveBeenCalled()
		})

		it("should be safe to call when orchestrator is not set", () => {
			;(manager as any)._orchestrator = undefined

			expect(() => manager.stopIndexing()).not.toThrow()
		})
	})

	describe("handleSettingsChange - disable toggle bug fix", () => {
		it("should abort active indexing when feature is disabled", async () => {
			const mockOrchestrator = {
				stopIndexing: vi.fn(),
				stopWatcher: vi.fn(),
				state: "Indexing",
			}
			;(manager as any)._orchestrator = mockOrchestrator

			const mockConfigManager = {
				loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
				isFeatureConfigured: true,
				isFeatureEnabled: false,
			}
			;(manager as any)._configManager = mockConfigManager

			const mockStateManager = (manager as any)._stateManager
			mockStateManager.setSystemState = vi.fn()

			await manager.handleSettingsChange()

			expect(mockOrchestrator.stopIndexing).toHaveBeenCalled()
			expect(mockStateManager.setSystemState).toHaveBeenCalledWith("Standby", "Code indexing is disabled")
		})
	})
})

// --- 追加: getInstance 分岐 / 単純ゲッター / initialize フロー / clearIndexData 等の網羅 ---

function makeMockContext() {
	const workspaceStateStore: Record<string, any> = {}
	const globalStateStore: Record<string, any> = {}
	return {
		subscriptions: [],
		workspaceState: {
			get: vi.fn((key: string, defaultValue?: any) =>
				key in workspaceStateStore ? workspaceStateStore[key] : defaultValue,
			),
			update: vi.fn(async (key: string, value: any) => {
				workspaceStateStore[key] = value
			}),
		},
		globalState: {
			get: vi.fn((key: string, defaultValue?: any) =>
				key in globalStateStore ? globalStateStore[key] : defaultValue,
			),
			update: vi.fn(async (key: string, value: any) => {
				globalStateStore[key] = value
			}),
		},
		globalStorageUri: { fsPath: "/test/global-storage" },
	} as any
}

/** 初期化済み相当に private フィールドを注入する */
function injectReady(manager: any, opts: { orchState?: string } = {}) {
	const orchestrator = {
		state: opts.orchState ?? "Indexed",
		startIndexing: vi.fn().mockResolvedValue(undefined),
		stopIndexing: vi.fn(),
		stopWatcher: vi.fn(),
		clearIndexData: vi.fn().mockResolvedValue(undefined),
	}
	const searchService = { searchIndex: vi.fn().mockResolvedValue([{ id: "r1" }]) }
	const cacheManager = { clearCacheFile: vi.fn().mockResolvedValue(undefined), initialize: vi.fn() }
	const configManager = { isFeatureEnabled: true, isFeatureConfigured: true }
	manager._configManager = configManager
	manager._orchestrator = orchestrator
	manager._searchService = searchService
	manager._cacheManager = cacheManager
	manager._serviceFactory = {}
	return { orchestrator, searchService, cacheManager, configManager }
}

describe("CodeIndexManager - getInstance の分岐", () => {
	beforeEach(() => CodeIndexManager.disposeAll())
	afterEach(() => CodeIndexManager.disposeAll())

	it("getAllInstances は生成済みの全インスタンスを返す", () => {
		const ctx = makeMockContext()
		const m = CodeIndexManager.getInstance(ctx)!
		expect(CodeIndexManager.getAllInstances()).toContain(m)
	})

	it("activeTextEditor があればそのワークスペースフォルダを使う", async () => {
		const vscode = await import("vscode")
		const savedEditor = (vscode.window as any).activeTextEditor
		const savedGWF = (vscode.workspace as any).getWorkspaceFolder
		const folder = (vscode.workspace as any).workspaceFolders[0]
		;(vscode.window as any).activeTextEditor = { document: { uri: folder.uri } }
		;(vscode.workspace as any).getWorkspaceFolder = vi.fn().mockReturnValue(folder)
		try {
			const m = CodeIndexManager.getInstance(makeMockContext())
			expect(m).toBeDefined()
			expect((vscode.workspace as any).getWorkspaceFolder).toHaveBeenCalled()
		} finally {
			;(vscode.window as any).activeTextEditor = savedEditor
			;(vscode.workspace as any).getWorkspaceFolder = savedGWF
		}
	})

	it("ワークスペースフォルダが無く activeEditor も無ければ undefined を返す", async () => {
		const vscode = await import("vscode")
		const saved = (vscode.workspace as any).workspaceFolders
		;(vscode.workspace as any).workspaceFolders = []
		try {
			expect(CodeIndexManager.getInstance(makeMockContext())).toBeUndefined()
		} finally {
			;(vscode.workspace as any).workspaceFolders = saved
		}
	})

	it("workspacePath 指定がフォルダに一致しない場合は file:// フォールバック URI を使う", () => {
		const ctx = makeMockContext()
		const m = CodeIndexManager.getInstance(ctx, "/not/in/workspace")!
		expect(m).toBeDefined()
		// フォールバック URI の toString() は isWorkspaceEnabled 経由で呼ばれる（例外なし）
		expect(typeof m.isWorkspaceEnabled).toBe("boolean")
	})
})

describe("CodeIndexManager - 単純ゲッター / メソッド委譲", () => {
	let manager: any
	beforeEach(() => {
		CodeIndexManager.disposeAll()
		manager = CodeIndexManager.getInstance(makeMockContext())!
	})
	afterEach(() => CodeIndexManager.disposeAll())

	it("onProgressUpdate は stateManager のイベントを返す", () => {
		expect(manager.onProgressUpdate).toBe(manager._stateManager.onProgressUpdate)
	})

	it("state: 機能無効なら Standby", () => {
		manager._configManager = { isFeatureEnabled: false }
		expect(manager.state).toBe("Standby")
	})

	it("state: 機能有効かつ初期化済みなら orchestrator.state", () => {
		injectReady(manager, { orchState: "Indexing" })
		expect(manager.state).toBe("Indexing")
	})

	it("searchIndex: 機能無効なら空配列（外部接続しない）", async () => {
		manager._configManager = { isFeatureEnabled: false }
		await expect(manager.searchIndex("q")).resolves.toEqual([])
	})

	it("searchIndex: 有効なら searchService に委譲", async () => {
		const { searchService } = injectReady(manager)
		const res = await manager.searchIndex("hello", "src/")
		expect(searchService.searchIndex).toHaveBeenCalledWith("hello", "src/")
		expect(res).toEqual([{ id: "r1" }])
	})

	it("clearIndexData: 機能無効なら何もしない", async () => {
		manager._configManager = { isFeatureEnabled: false }
		manager._orchestrator = { clearIndexData: vi.fn(), stopIndexing: vi.fn() }
		await manager.clearIndexData()
		expect(manager._orchestrator.clearIndexData).not.toHaveBeenCalled()
	})

	it("clearIndexData: 有効なら orchestrator とキャッシュを消す（意図した対象のみ）", async () => {
		const { orchestrator, cacheManager } = injectReady(manager)
		await manager.clearIndexData()
		expect(orchestrator.clearIndexData).toHaveBeenCalledTimes(1)
		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)
	})

	it("stopWatcher: 機能無効なら早期 return", () => {
		manager._configManager = { isFeatureEnabled: false }
		const orch = { stopWatcher: vi.fn(), stopIndexing: vi.fn() }
		manager._orchestrator = orch
		manager.stopWatcher()
		expect(orch.stopWatcher).not.toHaveBeenCalled()
	})

	it("stopWatcher: 有効なら orchestrator.stopWatcher に委譲", () => {
		const { orchestrator } = injectReady(manager)
		manager.stopWatcher()
		expect(orchestrator.stopWatcher).toHaveBeenCalled()
	})

	it("recoverFromError: 既に回復中なら二重実行しない（レース防止）", async () => {
		manager._isRecoveringFromError = true
		manager._stateManager.setSystemState = vi.fn()
		await manager.recoverFromError()
		// 早期 return: 状態変更もサービスクリアもしない
		expect(manager._stateManager.setSystemState).not.toHaveBeenCalled()
	})
})

describe("CodeIndexManager - startIndexing の分岐", () => {
	let manager: any
	beforeEach(() => {
		CodeIndexManager.disposeAll()
		manager = CodeIndexManager.getInstance(makeMockContext())!
	})
	afterEach(() => CodeIndexManager.disposeAll())

	it("Error 状態なら recoverFromError を呼んで早期 return（再初期化は呼び出し側に委ねる）", async () => {
		injectReady(manager)
		manager._stateManager.getCurrentStatus = vi.fn().mockReturnValue({ systemStatus: "Error" })
		const recoverSpy = vi.spyOn(manager, "recoverFromError")
		await manager.startIndexing()
		expect(recoverSpy).toHaveBeenCalled()
		// orchestrator.startIndexing は呼ばれない（回復後は再初期化待ち）
		expect(manager._orchestrator).toBeUndefined()
	})

	it("通常状態なら orchestrator.startIndexing に委譲", async () => {
		const { orchestrator } = injectReady(manager)
		manager._stateManager.getCurrentStatus = vi.fn().mockReturnValue({ systemStatus: "Standby" })
		await manager.startIndexing()
		expect(orchestrator.startIndexing).toHaveBeenCalled()
	})

	it("機能無効なら何もしない（外部接続しない）", async () => {
		manager._configManager = { isFeatureEnabled: false }
		const orch = { startIndexing: vi.fn(), stopIndexing: vi.fn() }
		manager._orchestrator = orch
		await manager.startIndexing()
		expect(orch.startIndexing).not.toHaveBeenCalled()
	})
})

describe("CodeIndexManager - initialize / _recreateServices / handleSettingsChange の残経路", () => {
	let manager: any
	beforeEach(() => {
		CodeIndexManager.disposeAll()
		manager = CodeIndexManager.getInstance(makeMockContext())!
	})
	afterEach(() => CodeIndexManager.disposeAll())

	/** _recreateServices を通過できる最小のサービスファクトリを設定 */
	function setValidFactory(validate: any = { valid: true }) {
		const instance = {
			createServices: vi.fn().mockReturnValue({
				embedder: { embedderInfo: { name: "openai" } },
				vectorStore: {},
				scanner: {},
				fileWatcher: {
					onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
					onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
					onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
					dispose: vi.fn(),
				},
			}),
			validateEmbedder: vi.fn().mockResolvedValue(validate),
		}
		MockedCodeIndexServiceFactory.mockImplementation(() => instance as any)
		return instance
	}

	it("機能無効なら watcher を止めて early return", async () => {
		manager._configManager = {
			loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
			isFeatureEnabled: false,
			isFeatureConfigured: false,
		}
		const orch = { stopWatcher: vi.fn(), stopIndexing: vi.fn() }
		manager._orchestrator = orch

		const res = await manager.initialize({} as any)

		expect(orch.stopWatcher).toHaveBeenCalled()
		expect(res).toEqual({ requiresRestart: false })
	})

	it("workspacePath が空なら 'No workspace folder open' で Standby", async () => {
		manager._configManager = {
			loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
		}
		manager.workspacePath = "" // 防御分岐を踏む
		manager._stateManager.setSystemState = vi.fn()

		await manager.initialize({} as any)

		expect(manager._stateManager.setSystemState).toHaveBeenCalledWith("Standby", "No workspace folder open")
	})

	it("ワークスペース未有効なら Standby で止まりサービスを作らない（外部接続しない）", async () => {
		manager._configManager = {
			loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
		}
		await manager.setAutoEnableDefault(false) // isWorkspaceEnabled=false
		manager._stateManager.setSystemState = vi.fn()
		const factory = setValidFactory()

		await manager.initialize({} as any)

		expect(manager._stateManager.setSystemState).toHaveBeenCalledWith(
			"Standby",
			"Indexing not enabled for this workspace",
		)
		expect(factory.createServices).not.toHaveBeenCalled()
	})

	it("有効かつ workspace 有効・cacheManager 未生成なら CacheManager を作って再構築する", async () => {
		manager._configManager = {
			loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: true }),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
		}
		manager._cacheManager = undefined
		// _recreateServices は別テストで実体検証済み。ここは cacheManager 生成経路の確認に絞る。
		const recreateSpy = vi.spyOn(manager, "_recreateServices").mockResolvedValue(undefined)

		const res = await manager.initialize({} as any)

		expect(manager._cacheManager).toBeDefined()
		expect(recreateSpy).toHaveBeenCalled()
		expect(res).toEqual({ requiresRestart: true })
	})

	it("_recreateServices: .gitignore 読み込み成功時は ignore ルールを追加する", async () => {
		manager._configManager = { isFeatureConfigured: true, isFeatureEnabled: true }
		manager._cacheManager = { clearCacheFile: vi.fn(), initialize: vi.fn() }
		manager._stateManager.setSystemState = vi.fn()
		setValidFactory()

		const ignoreMod: any = await import("ignore")
		const ignoreInstance = { add: vi.fn(), ignores: vi.fn().mockReturnValue(false) }
		ignoreMod.default.mockReturnValueOnce(ignoreInstance)

		const fsMod: any = await import("fs/promises")
		fsMod.default.readFile.mockResolvedValueOnce("*.log\nnode_modules/\n")

		await manager._recreateServices()

		// .gitignore の内容と ".gitignore" 自身が追加される
		expect(ignoreInstance.add).toHaveBeenCalledWith("*.log\nnode_modules/\n")
		expect(ignoreInstance.add).toHaveBeenCalledWith(".gitignore")
	})

	it("_recreateServices: workspacePath が空なら Standby で早期 return", async () => {
		manager._configManager = { isFeatureConfigured: true, isFeatureEnabled: true }
		manager._cacheManager = { clearCacheFile: vi.fn(), initialize: vi.fn() }
		manager._stateManager.setSystemState = vi.fn()
		const factory = setValidFactory()
		manager.workspacePath = ""

		await manager._recreateServices()

		expect(manager._stateManager.setSystemState).toHaveBeenCalledWith("Standby", "")
		// createServices まで到達しない
		expect(factory.createServices).not.toHaveBeenCalled()
	})

	it("handleSettingsChange: cacheManager 未生成でも生成してから再構築する", async () => {
		manager._configManager = {
			loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: true }),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
		}
		manager._cacheManager = undefined
		manager._stateManager.setSystemState = vi.fn()
		setValidFactory()

		const fsMod: any = await import("fs/promises")
		fsMod.default.readFile.mockRejectedValue(new Error("no gitignore"))

		await manager.handleSettingsChange()

		expect(manager._cacheManager).toBeDefined()
	})

	it("isFeatureConfigured: configManager 未生成なら false", () => {
		manager._configManager = undefined
		expect(manager.isFeatureConfigured).toBe(false)
	})

	it("既存 serviceFactory があり requiresRestart=false なら再構築しない", async () => {
		manager._configManager = {
			loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: false }),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
		}
		manager._cacheManager = { clearCacheFile: vi.fn(), initialize: vi.fn() }
		manager._serviceFactory = {} // 既存 → !_serviceFactory は false 側
		const recreateSpy = vi.spyOn(manager, "_recreateServices").mockResolvedValue(undefined)

		const res = await manager.initialize({} as any)

		expect(recreateSpy).not.toHaveBeenCalled()
		expect(res).toEqual({ requiresRestart: false })
	})

	it("_recreateServices: validateEmbedder が error 未指定で失敗なら既定メッセージで Error", async () => {
		manager._configManager = { isFeatureConfigured: true, isFeatureEnabled: true }
		manager._cacheManager = { clearCacheFile: vi.fn(), initialize: vi.fn() }
		manager._stateManager.setSystemState = vi.fn()
		setValidFactory({ valid: false }) // error フィールドなし

		const fsMod: any = await import("fs/promises")
		fsMod.default.readFile.mockRejectedValue(new Error("no gitignore"))

		await expect(manager._recreateServices()).rejects.toThrow("Embedder configuration validation failed")
		expect(manager._stateManager.setSystemState).toHaveBeenCalledWith(
			"Error",
			"Embedder configuration validation failed",
		)
	})

	it("handleSettingsChange: 再構築が失敗したら Error 状態のまま再送出する", async () => {
		manager._configManager = {
			loadConfiguration: vi.fn().mockResolvedValue({ requiresRestart: true }),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
		}
		manager._cacheManager = { clearCacheFile: vi.fn(), initialize: vi.fn() }
		manager._stateManager.setSystemState = vi.fn()
		// validateEmbedder 失敗 → _recreateServices が throw
		setValidFactory({ valid: false, error: "embeddings:validation.authenticationFailed" })
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(manager.handleSettingsChange()).rejects.toThrow("embeddings:validation.authenticationFailed")
		expect(errSpy).toHaveBeenCalledWith("Failed to recreate services:", expect.any(Error))
		errSpy.mockRestore()
	})
})
