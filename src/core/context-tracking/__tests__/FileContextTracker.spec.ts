// npx vitest run core/context-tracking/__tests__/FileContextTracker.spec.ts

import type { TaskMetadata, FileMetadataEntry } from "../FileContextTrackerTypes"

// ─── モック（パスは FileContextTracker.ts が解決するのと同一の絶対モジュールに向ける）───
const { mockSafeWriteJson, mockGetTaskDirectoryPath, mockFileExistsAtPath, mockReadFile, vsc } = vi.hoisted(() => ({
	mockSafeWriteJson: vi.fn(),
	mockGetTaskDirectoryPath: vi.fn(),
	mockFileExistsAtPath: vi.fn(),
	mockReadFile: vi.fn(),
	vsc: {
		// テストごとに差し替える可変状態
		throwOnCreateWatcher: false,
		workspaceFolders: [{ uri: { fsPath: "/cwd" } }] as Array<{ uri: { fsPath: string } }> | undefined,
		// 生成された watcher とその onDidChange コールバックを収集
		watchers: [] as Array<{
			dispose: ReturnType<typeof vi.fn>
			trigger: () => void
		}>,
	},
}))

vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: mockSafeWriteJson }))
vi.mock("../../../utils/storage", () => ({ getTaskDirectoryPath: mockGetTaskDirectoryPath }))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: mockFileExistsAtPath }))
vi.mock("fs/promises", () => ({ default: { readFile: mockReadFile }, readFile: mockReadFile }))

vi.mock("vscode", () => ({
	get workspace() {
		return {
			get workspaceFolders() {
				return vsc.workspaceFolders
			},
			createFileSystemWatcher: vi.fn(() => {
				if (vsc.throwOnCreateWatcher) {
					throw new Error("watcher boom")
				}
				let onChangeCb: (() => void) | undefined
				const watcher = {
					onDidChange: vi.fn((cb: () => void) => {
						onChangeCb = cb
						return { dispose: vi.fn() }
					}),
					onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
					onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
					dispose: vi.fn(),
				}
				vsc.watchers.push({ dispose: watcher.dispose, trigger: () => onChangeCb?.() })
				return watcher
			}),
		}
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	RelativePattern: class {
		constructor(
			public base: unknown,
			public pattern: unknown,
		) {}
	},
}))

import { FileContextTracker, type FileContextProvider } from "../FileContextTracker"

// contextProxy を備えた provider を作る（null を渡すと contextProxy 欠如を模す。
// undefined を既定引数のトリガにしないため sentinel は null を使う）
const makeProvider = (fsPath: string | null = "/storage"): FileContextProvider =>
	({
		contextProxy: fsPath === null ? undefined : ({ globalStorageUri: { fsPath } } as any),
	}) as FileContextProvider

// getTaskMetadata が返す内容を制御
function primeMetadata(metadata: TaskMetadata, exists = true) {
	mockFileExistsAtPath.mockResolvedValue(exists)
	mockReadFile.mockResolvedValue(JSON.stringify(metadata))
}

// safeWriteJson に渡された最新の metadata を取り出す
function lastSavedMetadata(): TaskMetadata {
	const calls = mockSafeWriteJson.mock.calls
	return calls[calls.length - 1][1] as TaskMetadata
}

beforeEach(() => {
	vi.clearAllMocks()
	vsc.throwOnCreateWatcher = false
	vsc.workspaceFolders = [{ uri: { fsPath: "/cwd" } }]
	vsc.watchers.length = 0
	mockGetTaskDirectoryPath.mockResolvedValue("/storage/tasks/task-1")
	mockSafeWriteJson.mockResolvedValue(undefined)
	primeMetadata({ files_in_context: [] })
})

describe("FileContextTracker.addFileToFileContextTracker", () => {
	it("read_tool: agent_read_date を打刻した active エントリを追加保存する", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")
		const before = Date.now()

		await tracker.addFileToFileContextTracker("task-1", "src/a.ts", "read_tool")

		expect(mockSafeWriteJson).toHaveBeenCalledTimes(1)
		const saved = lastSavedMetadata()
		expect(saved.files_in_context).toHaveLength(1)
		const entry = saved.files_in_context[0]
		expect(entry.path).toBe("src/a.ts")
		expect(entry.record_state).toBe("active")
		expect(entry.record_source).toBe("read_tool")
		expect(entry.agent_read_date).toBeGreaterThanOrEqual(before)
		expect(entry.roo_edit_date).toBeNull()
		expect(entry.user_edit_date).toBeNull()
	})

	it("同一パスの既存 active エントリは stale に落とされる（古い文脈の取り違え防止）", async () => {
		primeMetadata({
			files_in_context: [
				{
					path: "src/a.ts",
					record_state: "active",
					record_source: "read_tool",
					agent_read_date: 100,
					roo_edit_date: null,
					user_edit_date: null,
				},
			],
		})
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await tracker.addFileToFileContextTracker("task-1", "src/a.ts", "read_tool")

		const saved = lastSavedMetadata()
		// 旧エントリが stale、新エントリが active
		const oldEntry = saved.files_in_context.find((e) => e.agent_read_date === 100)
		const activeEntries = saved.files_in_context.filter((e) => e.record_state === "active")
		expect(oldEntry?.record_state).toBe("stale")
		expect(activeEntries).toHaveLength(1)
	})

	it("agent_edited: roo_edit_date/agent_read_date を打刻し checkpoint 候補と agent 編集集合に登録する", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await tracker.addFileToFileContextTracker("task-1", "src/b.ts", "agent_edited")

		const entry = lastSavedMetadata().files_in_context[0]
		expect(entry.roo_edit_date).not.toBeNull()
		expect(entry.agent_read_date).not.toBeNull()
		// checkpoint 候補に入る
		expect(tracker.getAndClearCheckpointPossibleFile()).toEqual(["src/b.ts"])
	})

	it("user_edited: user_edit_date を打刻し recentlyModified に載せる", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await tracker.addFileToFileContextTracker("task-1", "src/c.ts", "user_edited")

		const entry = lastSavedMetadata().files_in_context[0]
		expect(entry.user_edit_date).not.toBeNull()
		expect(tracker.getAndClearRecentlyModifiedFiles()).toEqual(["src/c.ts"])
	})

	it("file_mentioned: agent_read_date のみ打刻する", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await tracker.addFileToFileContextTracker("task-1", "src/d.ts", "file_mentioned")

		const entry = lastSavedMetadata().files_in_context[0]
		expect(entry.agent_read_date).not.toBeNull()
		expect(entry.roo_edit_date).toBeNull()
	})

	it("過去エントリの各日付フィールドの最新値を新エントリへ引き継ぐ", async () => {
		primeMetadata({
			files_in_context: [
				{
					path: "src/e.ts",
					record_state: "stale",
					record_source: "read_tool",
					agent_read_date: 100,
					roo_edit_date: 50,
					user_edit_date: 10,
				},
				{
					path: "src/e.ts",
					record_state: "stale",
					record_source: "read_tool",
					agent_read_date: 300,
					roo_edit_date: 20,
					user_edit_date: 5,
				},
			],
		})
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await tracker.addFileToFileContextTracker("task-1", "src/e.ts", "file_mentioned")

		const saved = lastSavedMetadata()
		const newEntry = saved.files_in_context[saved.files_in_context.length - 1]
		// file_mentioned は agent_read_date を now で上書きするが、roo/user は過去最新を継ぐ
		expect(newEntry.roo_edit_date).toBe(50) // 50 > 20
		expect(newEntry.user_edit_date).toBe(10) // 10 > 5
	})

	it("保存に失敗しても例外を投げず握りつぶす", async () => {
		mockSafeWriteJson.mockRejectedValue(new Error("disk full"))
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await expect(tracker.addFileToFileContextTracker("task-1", "src/f.ts", "read_tool")).resolves.toBeUndefined()
	})

	it("metadata が壊れて files_in_context が無い場合も例外を投げない", async () => {
		// files_in_context を欠く JSON → forEach で throw → catch 経路
		mockFileExistsAtPath.mockResolvedValue(true)
		mockReadFile.mockResolvedValue("{}")
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await expect(tracker.addFileToFileContextTracker("task-1", "src/g.ts", "read_tool")).resolves.toBeUndefined()
		expect(errorSpy).toHaveBeenCalledWith("Failed to add file to metadata:", expect.anything())
		expect(mockSafeWriteJson).not.toHaveBeenCalled()
		errorSpy.mockRestore()
	})
})

describe("FileContextTracker.getTaskMetadata", () => {
	it("ファイルがあれば JSON をパースして返す", async () => {
		const meta: TaskMetadata = {
			files_in_context: [
				{
					path: "x",
					record_state: "active",
					record_source: "read_tool",
					agent_read_date: 1,
					roo_edit_date: null,
					user_edit_date: null,
				},
			],
		}
		primeMetadata(meta, true)
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		const result = await tracker.getTaskMetadata("task-1")
		expect(result.files_in_context).toHaveLength(1)
		expect(result.files_in_context[0].path).toBe("x")
	})

	it("ファイルが無ければ空の files_in_context を返す", async () => {
		mockFileExistsAtPath.mockResolvedValue(false)
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		const result = await tracker.getTaskMetadata("task-1")
		expect(result).toEqual({ files_in_context: [] })
	})

	it("読み取り/パース失敗時も空の files_in_context を返す", async () => {
		mockFileExistsAtPath.mockResolvedValue(true)
		mockReadFile.mockResolvedValue("{ not json")
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		const result = await tracker.getTaskMetadata("task-1")
		expect(result).toEqual({ files_in_context: [] })
	})

	it("contextProxy が取れなくても空文字ストレージパスで動作する", async () => {
		mockFileExistsAtPath.mockResolvedValue(false)
		const tracker = new FileContextTracker(makeProvider(null), "task-1")

		const result = await tracker.getTaskMetadata("task-1")
		// globalStoragePath は "" にフォールバックし、getTaskDirectoryPath は "" 起点で呼ばれる
		expect(mockGetTaskDirectoryPath).toHaveBeenCalledWith("", "task-1")
		expect(result).toEqual({ files_in_context: [] })
	})
})

describe("FileContextTracker.getContextProxy", () => {
	it("provider が生きていれば contextProxy を返す", () => {
		const provider = makeProvider()
		const tracker = new FileContextTracker(provider, "task-1")
		expect(tracker.getContextProxy()).toBe(provider.contextProxy)
	})

	it("provider 参照が失効していれば undefined を返す", () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")
		// WeakRef が回収された状況を模す
		;(tracker as any).providerRef = { deref: () => undefined }
		expect(tracker.getContextProxy()).toBeUndefined()
	})

	it("contextProxy が無ければ undefined を返す", () => {
		const tracker = new FileContextTracker(makeProvider(null), "task-1")
		expect(tracker.getContextProxy()).toBeUndefined()
	})
})

describe("FileContextTracker.saveTaskMetadata", () => {
	it("正常時は safeWriteJson を呼ぶ", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")
		const meta: TaskMetadata = { files_in_context: [] }

		await tracker.saveTaskMetadata("task-1", meta)
		expect(mockSafeWriteJson).toHaveBeenCalledWith("/storage/tasks/task-1/task_metadata.json", meta)
	})

	it("contextProxy が無い場合は例外を投げずに握りつぶす", async () => {
		const tracker = new FileContextTracker(makeProvider(null), "task-1")
		await expect(tracker.saveTaskMetadata("task-1", { files_in_context: [] })).resolves.toBeUndefined()
		expect(mockSafeWriteJson).not.toHaveBeenCalled()
	})
})

describe("FileContextTracker.trackFileContext & setupFileWatcher", () => {
	it("cwd があれば metadata 追加と watcher 設定を行う", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await tracker.trackFileContext("src/g.ts", "read_tool")

		expect(mockSafeWriteJson).toHaveBeenCalled()
		expect(vsc.watchers).toHaveLength(1)
	})

	it("watcher 設定が例外を投げても trackFileContext は握りつぶす", async () => {
		vsc.throwOnCreateWatcher = true
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await expect(tracker.trackFileContext("src/boom.ts", "read_tool")).resolves.toBeUndefined()
		expect(errorSpy).toHaveBeenCalledWith("Failed to track file operation:", expect.anything())
		errorSpy.mockRestore()
	})

	it("cwd が無ければ何もしない（保存も watcher も無し）", async () => {
		vsc.workspaceFolders = undefined
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await tracker.trackFileContext("src/h.ts", "read_tool")

		expect(mockSafeWriteJson).not.toHaveBeenCalled()
		expect(vsc.watchers).toHaveLength(0)
	})

	it("同じファイルには watcher を重複生成しない", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await tracker.setupFileWatcher("src/i.ts")
		await tracker.setupFileWatcher("src/i.ts")

		expect(vsc.watchers).toHaveLength(1)
	})

	it("watcher: ユーザー編集を検知すると recentlyModified に載せ user_edited として追跡する", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")
		await tracker.setupFileWatcher("src/j.ts")

		// onDidChange を発火（agent 編集ではないので user 編集扱い）
		vsc.watchers[0].trigger()
		// trigger 内の trackFileContext は非同期なので解決を待つ
		await Promise.resolve()
		await Promise.resolve()

		expect(tracker.getAndClearRecentlyModifiedFiles()).toContain("src/j.ts")
	})

	it("watcher: agent 自身の編集は user 変更として通知しない", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")
		await tracker.setupFileWatcher("src/k.ts")
		// agent が編集したと印を付ける
		tracker.markFileAsEditedByAgent("src/k.ts")

		vsc.watchers[0].trigger()
		await Promise.resolve()

		// recentlyModified には載らない
		expect(tracker.getAndClearRecentlyModifiedFiles()).not.toContain("src/k.ts")
	})

	it("cwd が無ければ watcher を作らない", async () => {
		vsc.workspaceFolders = []
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		await tracker.setupFileWatcher("src/l.ts")
		expect(vsc.watchers).toHaveLength(0)
	})
})

describe("FileContextTracker.getFilesReadByAgent", () => {
	const baseEntry = (over: Partial<FileMetadataEntry>): FileMetadataEntry => ({
		path: "p",
		record_state: "active",
		record_source: "read_tool",
		agent_read_date: null,
		roo_edit_date: null,
		user_edit_date: null,
		...over,
	})

	it("read_tool/file_mentioned のみを最新読み込み順で返し重複を排除する", async () => {
		primeMetadata({
			files_in_context: [
				baseEntry({ path: "a.ts", record_source: "read_tool", agent_read_date: 100 }),
				baseEntry({ path: "b.ts", record_source: "file_mentioned", agent_read_date: 300 }),
				baseEntry({ path: "a.ts", record_source: "read_tool", agent_read_date: 200 }),
				baseEntry({ path: "u.ts", record_source: "user_edited", user_edit_date: 999 }),
				baseEntry({ path: "e.ts", record_source: "agent_edited", roo_edit_date: 999 }),
			],
		})
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		const files = await tracker.getFilesReadByAgent()

		// user_edited / agent_edited は除外
		expect(files).not.toContain("u.ts")
		expect(files).not.toContain("e.ts")
		// agent_read_date 降順: b(300), a(200), 重複 a(100) は排除
		expect(files).toEqual(["b.ts", "a.ts"])
	})

	it("agent_read_date が無いエントリも 0 扱いで安定に整列する", async () => {
		// 日付欠落エントリを複数含め、ソート比較子の `?? 0` 両側を通す
		primeMetadata({
			files_in_context: [
				baseEntry({ path: "n1.ts", record_source: "read_tool", agent_read_date: null }),
				baseEntry({ path: "n2.ts", record_source: "file_mentioned", agent_read_date: null }),
				baseEntry({ path: "dated.ts", record_source: "read_tool", agent_read_date: 200 }),
			],
		})
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		const files = await tracker.getFilesReadByAgent()
		// 日付付きが先頭、日付なし（0 扱い）は後方。全件は残る
		expect(files[0]).toBe("dated.ts")
		expect(files).toEqual(expect.arrayContaining(["n1.ts", "n2.ts", "dated.ts"]))
		expect(files).toHaveLength(3)
	})

	it("sinceTimestamp 以降に読まれたファイルだけを返す", async () => {
		primeMetadata({
			files_in_context: [
				baseEntry({ path: "old.ts", record_source: "read_tool", agent_read_date: 100 }),
				baseEntry({ path: "new.ts", record_source: "read_tool", agent_read_date: 500 }),
			],
		})
		const tracker = new FileContextTracker(makeProvider(), "task-1")

		const files = await tracker.getFilesReadByAgent(200)
		expect(files).toEqual(["new.ts"])
	})

	it("エラー時は空配列を返す", async () => {
		mockFileExistsAtPath.mockResolvedValue(true)
		mockReadFile.mockRejectedValue(new Error("io"))
		const tracker = new FileContextTracker(makeProvider(), "task-1")
		// getTaskMetadata は内部で握りつぶし {files_in_context:[]} を返すため、
		// ここでは metadata 取得後の処理を壊してエラー経路を通す
		;(tracker as any).getTaskMetadata = vi.fn().mockRejectedValue(new Error("boom"))

		await expect(tracker.getFilesReadByAgent()).resolves.toEqual([])
	})
})

describe("FileContextTracker misc", () => {
	it("getAndClearRecentlyModifiedFiles は取得後にクリアする", () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")
		tracker.markFileAsEditedByAgent("x") // 別集合。ここでは recentlyModified を直接操作
		;(tracker as any).recentlyModifiedFiles.add("m.ts")

		expect(tracker.getAndClearRecentlyModifiedFiles()).toEqual(["m.ts"])
		expect(tracker.getAndClearRecentlyModifiedFiles()).toEqual([])
	})

	it("getAndClearCheckpointPossibleFile は取得後にクリアする", () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")
		;(tracker as any).checkpointPossibleFiles.add("c.ts")

		expect(tracker.getAndClearCheckpointPossibleFile()).toEqual(["c.ts"])
		expect(tracker.getAndClearCheckpointPossibleFile()).toEqual([])
	})

	it("dispose は全 watcher を破棄し管理表をクリアする", async () => {
		const tracker = new FileContextTracker(makeProvider(), "task-1")
		await tracker.setupFileWatcher("a.ts")
		await tracker.setupFileWatcher("b.ts")
		expect(vsc.watchers).toHaveLength(2)

		tracker.dispose()

		expect(vsc.watchers[0].dispose).toHaveBeenCalled()
		expect(vsc.watchers[1].dispose).toHaveBeenCalled()
		// dispose 後は再設定で新しい watcher が作られる（管理表がクリアされている証拠）
		await tracker.setupFileWatcher("a.ts")
		expect(vsc.watchers).toHaveLength(3)
	})
})
