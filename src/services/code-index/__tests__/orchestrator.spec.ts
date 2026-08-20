import { describe, it, expect, beforeEach, vi } from "vitest"
import { CodeIndexOrchestrator } from "../orchestrator"

// Mock vscode workspace so startIndexing passes workspace check
vi.mock("vscode", () => {
	// vi.mock ファクトリは Vitest によって巻き上げられるため、
	// トップレベル import は使えない（TDZ）。動的 require で回避する。
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const path = require("path")
	const testWorkspacePath = path.join(path.sep, "test", "workspace")
	return {
		window: {
			activeTextEditor: null,
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: testWorkspacePath },
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
		},
		RelativePattern: vi.fn().mockImplementation((base: string, pattern: string) => ({ base, pattern })),
	}
})

// Mock i18n translator used in orchestrator messages
vi.mock("../../i18n", () => ({
	t: (key: string, params?: any) => {
		if (key === "embeddings:orchestrator.failedDuringInitialScan" && params?.errorMessage) {
			return `Failed during initial scan: ${params.errorMessage}`
		}
		return key
	},
}))

describe("CodeIndexOrchestrator - error path cleanup gating", () => {
	const workspacePath = "/test/workspace"

	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let scanner: any
	let fileWatcher: any

	beforeEach(() => {
		vi.clearAllMocks()

		configManager = {
			isFeatureConfigured: true,
		}

		// Minimal state manager that tracks state transitions
		let currentState = "Standby"
		stateManager = {
			get state() {
				return currentState
			},
			setSystemState: vi.fn().mockImplementation((state: string, _msg: string) => {
				currentState = state
			}),
			reportFileQueueProgress: vi.fn(),
			reportBlockIndexingProgress: vi.fn(),
		}

		cacheManager = {
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
		}

		vectorStore = {
			initialize: vi.fn(),
			hasIndexedData: vi.fn(),
			markIndexingIncomplete: vi.fn(),
			markIndexingComplete: vi.fn(),
			clearCollection: vi.fn().mockResolvedValue(undefined),
		}

		scanner = {
			scanDirectory: vi.fn(),
		}

		fileWatcher = {
			initialize: vi.fn().mockResolvedValue(undefined),
			onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			dispose: vi.fn(),
		}
	})

	it("should not call clearCollection() or clear cache when initialize() fails (indexing not started)", async () => {
		// Arrange: fail at initialize()
		vectorStore.initialize.mockRejectedValue(new Error("Qdrant unreachable"))

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		// Act
		await orchestrator.startIndexing()

		// Assert
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()

		// Error state should be set
		expect(stateManager.setSystemState).toHaveBeenCalled()
		const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
		expect(lastCall[0]).toBe("Error")
	})

	it("should call clearCollection() and clear cache when an error occurs after initialize() succeeds (indexing started)", async () => {
		// Arrange: initialize succeeds; fail soon after to enter error path with indexingStarted=true
		vectorStore.initialize.mockResolvedValue(false) // existing collection
		vectorStore.hasIndexedData.mockResolvedValue(false) // force full scan path
		vectorStore.markIndexingIncomplete.mockRejectedValue(new Error("mark incomplete failure"))

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		// Act
		await orchestrator.startIndexing()

		// Assert: cleanup gated behind indexingStarted should have happened
		expect(vectorStore.clearCollection).toHaveBeenCalledTimes(1)
		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)

		// Error state should be set
		expect(stateManager.setSystemState).toHaveBeenCalled()
		const lastCall = stateManager.setSystemState.mock.calls[stateManager.setSystemState.mock.calls.length - 1]
		expect(lastCall[0]).toBe("Error")
	})
})

describe("CodeIndexOrchestrator - stopIndexing", () => {
	const workspacePath = "/test/workspace"

	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let scanner: any
	let fileWatcher: any

	beforeEach(() => {
		vi.clearAllMocks()

		configManager = {
			isFeatureConfigured: true,
		}

		let currentState = "Standby"
		stateManager = {
			get state() {
				return currentState
			},
			setSystemState: vi.fn().mockImplementation((state: string, _msg: string) => {
				currentState = state
			}),
			reportFileQueueProgress: vi.fn(),
			reportBlockIndexingProgress: vi.fn(),
		}

		cacheManager = {
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
		}

		vectorStore = {
			initialize: vi.fn().mockResolvedValue(false),
			hasIndexedData: vi.fn().mockResolvedValue(false),
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
		}

		scanner = {
			scanDirectory: vi.fn(),
		}

		fileWatcher = {
			initialize: vi.fn().mockResolvedValue(undefined),
			onDidStartBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onBatchProgressUpdate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidFinishBatchProcessing: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			dispose: vi.fn(),
		}
	})

	it("should abort indexing when stopIndexing() is called", async () => {
		// Make scanner hang until aborted
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				// Wait for abort signal
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve())
				})
				return { stats: { processed: 0, skipped: 0 }, totalBlockCount: 0 }
			},
		)

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		// Start indexing (async, don't await)
		const indexingPromise = orchestrator.startIndexing()

		// Give it a tick to begin
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Stop indexing
		orchestrator.stopIndexing()

		// Wait for indexing to complete
		await indexingPromise

		// State should be Standby (not Error)
		const setStateCalls = stateManager.setSystemState.mock.calls
		const lastCall = setStateCalls[setStateCalls.length - 1]
		expect(lastCall[0]).toBe("Standby")
	})

	it("should set state to Standby after abort, not Error", async () => {
		// Make scanner throw AbortError when signal is aborted
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve())
				})
				throw new DOMException("Indexing aborted", "AbortError")
			},
		)

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		const indexingPromise = orchestrator.startIndexing()
		await new Promise((resolve) => setTimeout(resolve, 10))

		orchestrator.stopIndexing()
		await indexingPromise

		// Should NOT have set Error state — abort is handled gracefully
		const errorCalls = stateManager.setSystemState.mock.calls.filter((call: any[]) => call[0] === "Error")
		expect(errorCalls).toHaveLength(0)

		// Should NOT have cleared collection on abort
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
	})

	it("should preserve partial index data after stop", async () => {
		scanner.scanDirectory.mockImplementation(
			async (_dir: string, _onError?: any, _onBlocksIndexed?: any, _onFileParsed?: any, signal?: AbortSignal) => {
				await new Promise<void>((resolve) => {
					if (signal?.aborted) {
						resolve()
						return
					}
					signal?.addEventListener("abort", () => resolve())
				})
				return { stats: { processed: 5, skipped: 0 }, totalBlockCount: 5 }
			},
		)

		const orchestrator = new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fileWatcher,
		)

		const indexingPromise = orchestrator.startIndexing()
		await new Promise((resolve) => setTimeout(resolve, 10))

		orchestrator.stopIndexing()
		await indexingPromise

		// Cache should NOT be cleared on user-initiated stop
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		// Collection should NOT be cleared on user-initiated stop
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
	})
})

// --- 追加: startIndexing の主要フロー / _startWatcher / clearIndexData を網羅 ---

/** 状態遷移を追跡する簡易 stateManager を作る */
function makeStateManager() {
	let currentState = "Standby"
	return {
		get state() {
			return currentState
		},
		setSystemState: vi.fn((state: string, _msg?: string) => {
			currentState = state
		}),
		reportFileQueueProgress: vi.fn(),
		reportBlockIndexingProgress: vi.fn(),
	}
}

/** fileWatcher のコールバックを捕捉して後から発火できるモック */
function makeFileWatcher() {
	const cbs: {
		start?: (p: string[]) => void
		progress?: (e: { processedInBatch: number; totalInBatch: number; currentFile?: string }) => void
		finish?: (s: any) => void
	} = {}
	const watcher = {
		initialize: vi.fn().mockResolvedValue(undefined),
		onDidStartBatchProcessing: vi.fn((cb: any) => {
			cbs.start = cb
			return { dispose: vi.fn() }
		}),
		onBatchProgressUpdate: vi.fn((cb: any) => {
			cbs.progress = cb
			return { dispose: vi.fn() }
		}),
		onDidFinishBatchProcessing: vi.fn((cb: any) => {
			cbs.finish = cb
			return { dispose: vi.fn() }
		}),
		dispose: vi.fn(),
	}
	return { watcher, cbs }
}

describe("CodeIndexOrchestrator - startIndexing 主要フロー", () => {
	const workspacePath = "/test/workspace"
	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let scanner: any
	let fw: ReturnType<typeof makeFileWatcher>

	beforeEach(() => {
		vi.clearAllMocks()
		configManager = { isFeatureConfigured: true }
		stateManager = makeStateManager()
		cacheManager = {
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
		}
		vectorStore = {
			initialize: vi.fn().mockResolvedValue(false),
			hasIndexedData: vi.fn().mockResolvedValue(false),
			markIndexingIncomplete: vi.fn().mockResolvedValue(undefined),
			markIndexingComplete: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
			deleteCollection: vi.fn().mockResolvedValue(undefined),
		}
		// 既定: 5 ブロック検出＆全件インデックス成功
		scanner = {
			scanDirectory: vi.fn(
				async (_p: string, _onError: any, onBlocksIndexed: any, onFileParsed: any, _signal: AbortSignal) => {
					onFileParsed(5)
					onBlocksIndexed(5)
					return { stats: { processed: 5, skipped: 0 }, totalBlockCount: 5 }
				},
			),
		}
		fw = makeFileWatcher()
	})

	function makeOrchestrator() {
		return new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fw.watcher as any,
		)
	}

	it("フルスキャン成功: collection 新規作成時はキャッシュを消し、完了で Indexed", async () => {
		vectorStore.initialize.mockResolvedValue(true) // 新規作成
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1) // collectionCreated
		expect(vectorStore.markIndexingIncomplete).toHaveBeenCalled()
		expect(scanner.scanDirectory).toHaveBeenCalledWith(
			workspacePath,
			expect.any(Function),
			expect.any(Function),
			expect.any(Function),
			expect.any(Object),
		)
		expect(fw.watcher.initialize).toHaveBeenCalled()
		expect(vectorStore.markIndexingComplete).toHaveBeenCalled()
		expect(orch.state).toBe("Indexed")
	})

	it("増分スキャン: 既存データありなら full scan を省いて incremental 実行、Indexed", async () => {
		vectorStore.initialize.mockResolvedValue(false) // 既存 collection
		vectorStore.hasIndexedData.mockResolvedValue(true) // データあり → incremental
		const orch = makeOrchestrator()

		await orch.startIndexing()

		// collectionCreated=false なので開始時のキャッシュ消去はしない
		expect(cacheManager.clearCacheFile).not.toHaveBeenCalled()
		expect(vectorStore.markIndexingIncomplete).toHaveBeenCalled()
		expect(scanner.scanDirectory).toHaveBeenCalled()
		expect(vectorStore.markIndexingComplete).toHaveBeenCalled()
		expect(orch.state).toBe("Indexed")
	})

	it("増分スキャンで新規/変更ファイルが 0 でも完了する", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(true)
		// 何も検出しない（found=0, indexed=0）
		scanner.scanDirectory = vi.fn(async () => ({ stats: {}, totalBlockCount: 0 }))
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Indexed")
		expect(vectorStore.markIndexingComplete).toHaveBeenCalled()
	})

	it("ワークスペース未オープンなら Error（外部接続へ進まない）", async () => {
		const vscode = await import("vscode")
		const saved = (vscode.workspace as any).workspaceFolders
		;(vscode.workspace as any).workspaceFolders = []
		try {
			const orch = makeOrchestrator()
			await orch.startIndexing()
			expect(vectorStore.initialize).not.toHaveBeenCalled()
			expect(orch.state).toBe("Error")
		} finally {
			;(vscode.workspace as any).workspaceFolders = saved
		}
	})

	it("未設定なら Standby で止まり Qdrant へ接続しない（不変条件）", async () => {
		configManager.isFeatureConfigured = false
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(vectorStore.initialize).not.toHaveBeenCalled()
		expect(orch.state).toBe("Standby")
	})

	it("既に Indexing 状態なら二重起動を拒否する", async () => {
		stateManager.setSystemState("Indexing", "busy")
		stateManager.setSystemState.mockClear()
		const orch = makeOrchestrator()

		await orch.startIndexing()

		// Indexing への再設定（初期化開始）は行われない
		expect(vectorStore.initialize).not.toHaveBeenCalled()
	})

	it("フルスキャンで検出はあるがインデックス 0 かつ batchError あり → Error", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		scanner.scanDirectory = vi.fn(async (_p, onError: any, _bi: any, onFileParsed: any) => {
			onFileParsed(5) // found=5
			onError(new Error("embed failed")) // batchError, indexed=0
			return { stats: {}, totalBlockCount: 5 }
		})
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Error")
		// indexing 開始済みなので後始末が走る
		expect(vectorStore.clearCollection).toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).toHaveBeenCalled()
	})

	it("フルスキャンで検出はあるがインデックス 0 かつ batchError なし → Error(no blocks)", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		scanner.scanDirectory = vi.fn(async (_p, _onError: any, _bi: any, onFileParsed: any) => {
			onFileParsed(5) // found=5, indexed=0, no error
			return { stats: {}, totalBlockCount: 5 }
		})
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Error")
	})

	it("フルスキャンで失敗率 >10% なら部分失敗として Error", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		scanner.scanDirectory = vi.fn(async (_p, onError: any, onBlocksIndexed: any, onFileParsed: any) => {
			onFileParsed(10) // found=10
			onBlocksIndexed(5) // indexed=5 → failureRate=0.5 > 0.1
			onError(new Error("some batch failed"))
			return { stats: {}, totalBlockCount: 10 }
		})
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Error")
	})

	it("フルスキャンで found=0 かつ batchError あり・indexed=0 → 完全失敗で Error", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		scanner.scanDirectory = vi.fn(async (_p, onError: any) => {
			onError(new Error("total failure")) // found=0, indexed=0, batchError
			return { stats: {}, totalBlockCount: 0 }
		})
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Error")
	})

	it("scanner が falsy を返したら scan 失敗として Error（フル）", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		scanner.scanDirectory = vi.fn(async () => undefined)
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Error")
	})

	it("scanner が falsy を返したら scan 失敗として Error（増分）", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(true)
		scanner.scanDirectory = vi.fn(async () => undefined)
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Error")
	})

	it("増分スキャン中の abort は Standby でキャッシュを flush、collection は消さない", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(true)
		scanner.scanDirectory = vi.fn(async (_p, _onError: any, _bi: any, _fp: any, signal: AbortSignal) => {
			await new Promise<void>((resolve) => {
				if (signal.aborted) return resolve()
				signal.addEventListener("abort", () => resolve())
			})
			return { stats: {}, totalBlockCount: 0 }
		})
		const orch = makeOrchestrator()
		const p = orch.startIndexing()
		await new Promise((r) => setTimeout(r, 10))
		orch.stopIndexing()
		await p

		expect(cacheManager.flush).toHaveBeenCalled()
		expect(vectorStore.clearCollection).not.toHaveBeenCalled()
		expect(orch.state).toBe("Standby")
	})

	it("_startWatcher: fileWatcher.initialize 失敗は catch で再送出され Error＆後始末", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		fw.watcher.initialize.mockRejectedValue(new Error("watcher boom"))
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Error")
		// indexingStarted=true なので clearCollection / clearCacheFile が走る
		expect(vectorStore.clearCollection).toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).toHaveBeenCalled()
	})

	it("増分スキャンの batchError コールバックはログして継続（完了は Indexed）", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(true)
		scanner.scanDirectory = vi.fn(async (_p, onError: any, onBlocksIndexed: any, onFileParsed: any) => {
			onFileParsed(3)
			onError(new Error("incremental batch error"))
			onBlocksIndexed(3)
			return { stats: {}, totalBlockCount: 3 }
		})
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(errSpy).toHaveBeenCalled()
		expect(orch.state).toBe("Indexed")
		errSpy.mockRestore()
	})

	it("エラー後始末で clearCollection が失敗しても内側 catch で握って続行", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		// indexingStarted=true にした上で mark 失敗 → error 分岐へ
		vectorStore.markIndexingIncomplete.mockRejectedValue(new Error("mark failed"))
		vectorStore.clearCollection.mockRejectedValue(new Error("cleanup failed"))
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(vectorStore.clearCollection).toHaveBeenCalled()
		expect(cacheManager.clearCacheFile).toHaveBeenCalled()
		expect(orch.state).toBe("Error")
		errSpy.mockRestore()
	})

	it("エラーメッセージが空なら unknownError にフォールバックして Error", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		// message 空文字 → error.message || t(unknownError) の右辺を通る
		vectorStore.markIndexingIncomplete.mockRejectedValue(new Error(""))
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Error")
	})

	it("_startWatcher: 設定が途中で外れると 'not configured' で失敗し Error＆後始末", async () => {
		vectorStore.initialize.mockResolvedValue(false)
		vectorStore.hasIndexedData.mockResolvedValue(false)
		// isFeatureConfigured を「1回目 true（startIndexing 冒頭）→以降 false（_startWatcher）」に切替
		let n = 0
		Object.defineProperty(configManager, "isFeatureConfigured", {
			get() {
				n += 1
				return n === 1
			},
			configurable: true,
		})
		const orch = makeOrchestrator()

		await orch.startIndexing()

		expect(orch.state).toBe("Error")
		expect(vectorStore.clearCollection).toHaveBeenCalled()
	})

	describe("fileWatcher コールバック（_startWatcher 内）", () => {
		async function startAndGetCbs() {
			vectorStore.initialize.mockResolvedValue(false)
			vectorStore.hasIndexedData.mockResolvedValue(false)
			const orch = makeOrchestrator()
			await orch.startIndexing()
			return orch
		}

		it("バッチ進捗: totalInBatch>0 かつ非 Indexing 状態なら Indexing に戻し進捗報告", async () => {
			const orch = await startAndGetCbs()
			expect(orch.state).toBe("Indexed") // 成功後は Indexed
			stateManager.setSystemState.mockClear()
			stateManager.reportFileQueueProgress.mockClear()

			fw.cbs.progress!({ processedInBatch: 1, totalInBatch: 3, currentFile: "/a/b/foo.ts" })

			expect(stateManager.setSystemState).toHaveBeenCalledWith("Indexing", "Processing file changes...")
			expect(stateManager.reportFileQueueProgress).toHaveBeenCalledWith(1, 3, "foo.ts")
		})

		it("バッチ完了(N/N, N>0): Indexed に遷移", async () => {
			await startAndGetCbs()
			stateManager.setSystemState.mockClear()

			fw.cbs.progress!({ processedInBatch: 2, totalInBatch: 2, currentFile: undefined })

			expect(stateManager.setSystemState).toHaveBeenCalledWith(
				"Indexed",
				"File changes processed. Index up-to-date.",
			)
		})

		it("バッチ空(0/0) かつ Indexing 中なら queue empty で Indexed", async () => {
			await startAndGetCbs()
			// 状態を Indexing にしておく
			stateManager.setSystemState("Indexing", "processing")
			stateManager.setSystemState.mockClear()

			fw.cbs.progress!({ processedInBatch: 0, totalInBatch: 0, currentFile: undefined })

			expect(stateManager.setSystemState).toHaveBeenCalledWith("Indexed", "Index up-to-date. File queue empty.")
		})

		it("バッチ空(0/0) かつ非 Indexing なら何もしない", async () => {
			await startAndGetCbs() // 成功後は Indexed
			stateManager.setSystemState.mockClear()

			fw.cbs.progress!({ processedInBatch: 0, totalInBatch: 0, currentFile: undefined })

			expect(stateManager.setSystemState).not.toHaveBeenCalled()
		})

		it("バッチ完了通知: batchError ありならログ出力（例外は投げない）", async () => {
			await startAndGetCbs()
			const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			expect(() => fw.cbs.finish!({ batchError: new Error("boom") })).not.toThrow()
			expect(errSpy).toHaveBeenCalled()
			// batchError なしの経路も踏む
			errSpy.mockClear()
			fw.cbs.finish!({})
			expect(errSpy).not.toHaveBeenCalled()

			errSpy.mockRestore()
		})

		it("開始通知コールバックは無害（本体は空）", async () => {
			await startAndGetCbs()
			expect(() => fw.cbs.start!(["/x.ts"])).not.toThrow()
		})
	})
})

describe("CodeIndexOrchestrator - clearIndexData / stopWatcher / state", () => {
	const workspacePath = "/test/workspace"
	let configManager: any
	let stateManager: any
	let cacheManager: any
	let vectorStore: any
	let scanner: any
	let fw: ReturnType<typeof makeFileWatcher>

	beforeEach(() => {
		vi.clearAllMocks()
		configManager = { isFeatureConfigured: true }
		stateManager = makeStateManager()
		cacheManager = {
			clearCacheFile: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
		}
		vectorStore = {
			deleteCollection: vi.fn().mockResolvedValue(undefined),
			clearCollection: vi.fn().mockResolvedValue(undefined),
		}
		scanner = { scanDirectory: vi.fn() }
		fw = makeFileWatcher()
	})

	function makeOrchestrator() {
		return new CodeIndexOrchestrator(
			configManager,
			stateManager,
			workspacePath,
			cacheManager,
			vectorStore,
			scanner,
			fw.watcher as any,
		)
	}

	it("設定済みなら collection を削除しキャッシュを消して Standby", async () => {
		const orch = makeOrchestrator()
		await orch.clearIndexData()

		expect(vectorStore.deleteCollection).toHaveBeenCalledTimes(1)
		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)
		expect(stateManager.setSystemState).toHaveBeenLastCalledWith("Standby", "Index data cleared successfully.")
	})

	it("未設定なら collection 削除をスキップ（意図した対象以外に及ばない）", async () => {
		configManager.isFeatureConfigured = false
		const orch = makeOrchestrator()
		await orch.clearIndexData()

		expect(vectorStore.deleteCollection).not.toHaveBeenCalled()
		// キャッシュ消去は行う
		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)
		expect(orch.state).toBe("Standby")
	})

	it("collection 削除が失敗しても Error 状態にしキャッシュ消去は継続", async () => {
		vectorStore.deleteCollection.mockRejectedValue(new Error("qdrant down"))
		const orch = makeOrchestrator()
		await orch.clearIndexData()

		expect(cacheManager.clearCacheFile).toHaveBeenCalledTimes(1)
		expect(orch.state).toBe("Error")
		// Error のときは success メッセージを出さない
		expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Standby", "Index data cleared successfully.")
	})

	it("stopWatcher: Error 状態のときは Standby に上書きしない", () => {
		stateManager.setSystemState("Error", "boom")
		stateManager.setSystemState.mockClear()
		const orch = makeOrchestrator()

		orch.stopWatcher()

		expect(fw.watcher.dispose).toHaveBeenCalled()
		expect(stateManager.setSystemState).not.toHaveBeenCalled()
	})

	it("stopWatcher: 通常状態なら Standby にする", () => {
		const orch = makeOrchestrator()
		orch.stopWatcher()
		expect(stateManager.setSystemState).toHaveBeenCalledWith("Standby", expect.any(String))
	})

	it("stopIndexing: 進行中でなければ watcher 停止のみ（abort しない）", () => {
		const orch = makeOrchestrator()
		orch.stopIndexing()
		// Stopping への遷移は起きない（_abortController が無い）
		expect(stateManager.setSystemState).not.toHaveBeenCalledWith("Stopping", expect.any(String))
		expect(fw.watcher.dispose).toHaveBeenCalled()
	})

	it("state ゲッターは stateManager.state を返す", () => {
		const orch = makeOrchestrator()
		expect(orch.state).toBe("Standby")
		stateManager.setSystemState("Indexing", "x")
		expect(orch.state).toBe("Indexing")
	})
})
