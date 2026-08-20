import type { Mock } from "vitest"
import * as vscode from "vscode"
import WorkspaceTracker from "../WorkspaceTracker"
import { ClineProvider } from "../../../core/webview/ClineProvider"
import { listFiles } from "../../../services/glob/list-files"
import { getWorkspacePath } from "../../../utils/path"

// Mock functions - must be defined before vitest.mock calls
const mockOnDidCreate = vitest.fn()
const mockOnDidDelete = vitest.fn()
const mockDispose = vitest.fn()

// Store registered tab change callback
let registeredTabChangeCallback: (() => Promise<void>) | null = null

// Mock workspace path
vitest.mock("../../../utils/path", () => ({
	getWorkspacePath: vitest.fn().mockReturnValue("/test/workspace"),
	toRelativePath: vitest.fn((path, cwd) => {
		// Handle both Windows and POSIX paths by using path.relative
		// vi.mock ファクトリ内なので動的 require（TDZ 回避）。
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const relativePath = require("path").relative(cwd, path)
		// Convert to forward slashes for consistency
		const normalizedPath = relativePath.replace(/\\/g, "/")
		// Add trailing slash if original path had one
		return path.endsWith("/") ? normalizedPath + "/" : normalizedPath
	}),
}))

// Mock watcher - must be defined after mockDispose but before vitest.mock("vscode")
const mockWatcher = {
	onDidCreate: mockOnDidCreate.mockReturnValue({ dispose: mockDispose }),
	onDidDelete: mockOnDidDelete.mockReturnValue({ dispose: mockDispose }),
	dispose: mockDispose,
}

// Mock vscode
vitest.mock("vscode", () => ({
	window: {
		tabGroups: {
			onDidChangeTabs: vitest.fn((callback) => {
				registeredTabChangeCallback = callback
				return { dispose: mockDispose }
			}),
			all: [],
		},
		onDidChangeActiveTextEditor: vitest.fn(() => ({ dispose: vitest.fn() })),
	},
	workspace: {
		workspaceFolders: [
			{
				uri: { fsPath: "/test/workspace" },
				name: "test",
				index: 0,
			},
		],
		createFileSystemWatcher: vitest.fn(() => mockWatcher),
		fs: {
			stat: vitest.fn().mockResolvedValue({ type: 1 }), // FileType.File = 1
		},
	},
	FileType: { File: 1, Directory: 2 },
	// addFilePath は `vscode.Uri.file(...)` を stat に渡す。これが無いと stat 前に
	// 例外になり try 本体（ディレクトリ判定）へ到達できず、常に catch へ落ちてしまう。
	Uri: { file: (fsPath: string) => ({ fsPath, path: fsPath, scheme: "file" }) },
	// getOpenedTabsInfo が `tab.input instanceof vscode.TabInputText` で判定するため必要。
	TabInputText: class TabInputText {
		uri: { fsPath: string }
		constructor(uri: { fsPath: string }) {
			this.uri = uri
		}
	},
}))

vitest.mock("../../../services/glob/list-files", () => ({
	listFiles: vitest.fn(),
}))

describe("WorkspaceTracker", () => {
	let workspaceTracker: WorkspaceTracker
	let mockProvider: ClineProvider

	beforeEach(() => {
		vitest.clearAllMocks()
		vitest.useFakeTimers()

		// Reset all mock implementations
		registeredTabChangeCallback = null

		// タブ一覧はテスト間で汚染しないよう毎回空へ戻す。
		;(vscode.window.tabGroups as unknown as { all: unknown[] }).all = []

		// Reset workspace path mock
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")

		// Create provider mock
		mockProvider = {
			postMessageToWebview: vitest.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider & { postMessageToWebview: Mock }

		// Create tracker instance
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Ensure the tab change callback was registered
		expect(registeredTabChangeCallback).not.toBeNull()
	})

	it("should initialize with workspace files", async () => {
		const mockFiles = [["/test/workspace/file1.ts", "/test/workspace/file2.ts"], false]
		;(listFiles as Mock).mockResolvedValue(mockFiles)

		await workspaceTracker.initializeFilePaths()
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: expect.arrayContaining(["file1.ts", "file2.ts"]),
			openedTabs: [],
		})
		expect((mockProvider.postMessageToWebview as Mock).mock.calls[0][0].filePaths).toHaveLength(2)
	})

	it("should handle file creation events", async () => {
		// Get the creation callback and call it
		const [[callback]] = mockOnDidCreate.mock.calls
		await callback({ fsPath: "/test/workspace/newfile.ts" })
		vitest.runAllTimers()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: ["newfile.ts"],
			openedTabs: [],
		})
	})

	it("should handle file deletion events", async () => {
		// First add a file
		const [[createCallback]] = mockOnDidCreate.mock.calls
		await createCallback({ fsPath: "/test/workspace/file.ts" })
		vitest.runAllTimers()

		// Then delete it
		const [[deleteCallback]] = mockOnDidDelete.mock.calls
		await deleteCallback({ fsPath: "/test/workspace/file.ts" })
		vitest.runAllTimers()

		// The last call should have empty filePaths
		expect(mockProvider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: [],
		})
	})

	it("should handle directory paths correctly", async () => {
		// Mock stat to return directory type
		;(vscode.workspace.fs.stat as Mock).mockResolvedValueOnce({ type: 2 }) // FileType.Directory = 2

		const [[callback]] = mockOnDidCreate.mock.calls
		await callback({ fsPath: "/test/workspace/newdir" })
		vitest.runAllTimers()

		// ディレクトリは末尾スラッシュ付きで記録される（stat が Directory を返すため）。
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: expect.arrayContaining(["newdir/"]),
			openedTabs: [],
		})
		const lastCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0]
		expect(lastCall[0].filePaths).toHaveLength(1)
	})

	it("should respect file limits", async () => {
		// Create array of unique file paths for initial load
		const files = Array.from({ length: 1001 }, (_, i) => `/test/workspace/file${i}.ts`)
		;(listFiles as Mock).mockResolvedValue([files, false])

		await workspaceTracker.initializeFilePaths()
		vitest.runAllTimers()

		// Should only have 1000 files initially
		const expectedFiles = Array.from({ length: 1000 }, (_, i) => `file${i}.ts`).sort()
		const calls = (mockProvider.postMessageToWebview as Mock).mock.calls

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: expect.arrayContaining(expectedFiles),
			openedTabs: [],
		})
		expect(calls[0][0].filePaths).toHaveLength(1000)

		// Should allow adding up to 2000 total files
		const [[callback]] = mockOnDidCreate.mock.calls
		for (let i = 0; i < 1000; i++) {
			await callback({ fsPath: `/test/workspace/extra${i}.ts` })
		}
		vitest.runAllTimers()

		const lastCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0]
		expect(lastCall[0].filePaths).toHaveLength(2000)

		// Adding one more file beyond 2000 should not increase the count
		await callback({ fsPath: "/test/workspace/toomany.ts" })
		vitest.runAllTimers()

		const finalCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0]
		expect(finalCall[0].filePaths).toHaveLength(2000)
	})

	it("should clean up watchers and timers on dispose", async () => {
		// Set up updateTimer（await して workspaceDidUpdate を走らせ updateTimer を立てる）
		const [[callback]] = mockOnDidCreate.mock.calls
		await callback({ fsPath: "/test/workspace/file.ts" })

		workspaceTracker.dispose() // updateTimer の clear 分岐を通す
		expect(mockDispose).toHaveBeenCalled()
		vitest.runAllTimers() // Ensure any pending timers are cleared

		// No more updates should happen after dispose
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("should handle workspace path changes when tabs change", async () => {
		expect(registeredTabChangeCallback).not.toBeNull()

		// Set initial workspace path and create tracker
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Clear any initialization calls
		vitest.clearAllMocks()

		// Mock listFiles to return some files
		const mockFiles = [["/test/new-workspace/file1.ts"], false]
		;(listFiles as Mock).mockResolvedValue(mockFiles)

		// Change workspace path
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")

		// Simulate tab change event
		await registeredTabChangeCallback!()

		// Run the debounce timer for workspaceDidReset
		vitest.advanceTimersByTime(300)

		// Should clear file paths and reset workspace
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: [],
		})

		// Run all remaining timers to complete initialization
		await Promise.resolve() // Wait for initializeFilePaths to complete
		vitest.runAllTimers()

		// Should initialize file paths for new workspace
		expect(listFiles).toHaveBeenCalledWith("/test/new-workspace", true, 1000)
		vitest.runAllTimers()
	})

	it("should not update file paths if workspace changes during initialization", async () => {
		// Setup initial workspace path
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Clear any initialization calls
		vitest.clearAllMocks()
		;(mockProvider.postMessageToWebview as Mock).mockClear()

		// Create a promise to control listFiles timing
		let resolveListFiles: (value: [string[], boolean]) => void
		const listFilesPromise = new Promise<[string[], boolean]>((resolve) => {
			resolveListFiles = resolve
		})

		// Setup listFiles to use our controlled promise
		;(listFiles as Mock).mockImplementation(() => {
			// Change workspace path before listFiles resolves
			;(getWorkspacePath as Mock).mockReturnValue("/test/changed-workspace")
			return listFilesPromise
		})

		// Start initialization
		const initPromise = workspaceTracker.initializeFilePaths()

		// Resolve listFiles after workspace path change
		resolveListFiles!([["/test/workspace/file1.ts", "/test/workspace/file2.ts"], false])

		// Wait for initialization to complete
		await initPromise
		vitest.runAllTimers()

		// Should not update file paths because workspace changed during initialization
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "workspaceUpdated",
				openedTabs: [],
			}),
		)

		// Extract the actual file paths to verify format
		const actualFilePaths = (mockProvider.postMessageToWebview as Mock).mock.calls[0][0].filePaths

		// Verify file path array length
		expect(actualFilePaths).toHaveLength(2)

		// Verify file paths contain the expected file names regardless of platform specifics
		expect(actualFilePaths.every((path: string) => path.includes("file1.ts") || path.includes("file2.ts"))).toBe(
			true,
		)
	})

	it("should clear resetTimer when calling workspaceDidReset multiple times", async () => {
		expect(registeredTabChangeCallback).not.toBeNull()

		// Set initial workspace path
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")

		// Create tracker instance to set initial prevWorkSpacePath
		workspaceTracker = new WorkspaceTracker(mockProvider)

		// Change workspace path to trigger update
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")

		// Call workspaceDidReset through tab change event
		await registeredTabChangeCallback!()

		// Call again before timer completes
		await registeredTabChangeCallback!()

		// Advance timer
		vitest.advanceTimersByTime(300)

		// Should only have one call to postMessageToWebview
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "workspaceUpdated",
			filePaths: [],
			openedTabs: [],
		})
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
	})

	it("should handle dispose with active resetTimer", async () => {
		expect(registeredTabChangeCallback).not.toBeNull()

		// beforeEach で prevWorkSpacePath は "/test/workspace"。cwd を別パスに変えて
		// タブ変更を起こすと workspaceDidReset が走り resetTimer がセットされる。
		;(getWorkspacePath as Mock).mockReturnValue("/test/new-workspace")

		// Trigger resetTimer
		await registeredTabChangeCallback!()

		// Dispose before timer completes（resetTimer の clear 分岐を通す）
		workspaceTracker.dispose()

		// Advance timer
		vitest.advanceTimersByTime(300)

		// Should have called dispose on all disposables
		expect(mockDispose).toHaveBeenCalled()

		// resetTimer は dispose で止めたので postMessage は呼ばれない。
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("cwd が空のときは initializeFilePaths が即 return する（listFiles を呼ばない）", async () => {
		// 不変条件: workspace 未選択（cwd 空）でファイル列挙を起動しない。
		;(getWorkspacePath as Mock).mockReturnValue("")
		const tracker = new WorkspaceTracker(mockProvider)
		;(listFiles as Mock).mockClear()

		await tracker.initializeFilePaths()

		expect(listFiles).not.toHaveBeenCalled()
		tracker.dispose()
	})

	it("初期化中に workspace が切り替わったら stale な結果を反映しない", async () => {
		// 不変条件: listFiles の await 中に workspace が変わったら、その結果は捨てる。
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		const tracker = new WorkspaceTracker(mockProvider)
		;(mockProvider.postMessageToWebview as Mock).mockClear()

		let resolveList!: (v: [string[], boolean]) => void
		;(listFiles as Mock).mockReturnValue(
			new Promise<[string[], boolean]>((resolve) => {
				resolveList = resolve
			}),
		)

		const initPromise = tracker.initializeFilePaths() // tempCwd を capture して await へ

		// await 中に reset が完了した状況を再現（prevWorkSpacePath が別値になる）。
		;(tracker as unknown as { prevWorkSpacePath: string }).prevWorkSpacePath = "/test/changed"
		resolveList([["/test/workspace/file1.ts"], false])
		await initPromise
		vitest.runAllTimers()

		// prevWorkSpacePath !== tempCwd なので workspaceDidUpdate に到達しない。
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		tracker.dispose()
	})

	it("開いているタブ情報を集約し active を先頭に、TabInputText 以外は除外する", async () => {
		// 不変条件: テキストタブだけを拾い、アクティブなタブを先頭に並べる。
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		;(mockProvider.postMessageToWebview as Mock).mockClear()
		;(vscode.window.tabGroups as unknown as { all: unknown[] }).all = [
			{
				tabs: [
					{
						label: "inactive.ts",
						isActive: false,
						input: new (vscode as unknown as { TabInputText: new (u: unknown) => unknown }).TabInputText({
							fsPath: "/test/workspace/inactive.ts",
						}),
					},
					{
						label: "active.ts",
						isActive: true,
						input: new (vscode as unknown as { TabInputText: new (u: unknown) => unknown }).TabInputText({
							fsPath: "/test/workspace/active.ts",
						}),
					},
					// TabInputText でない入力（webview 等）は除外される。
					{ label: "not-text", isActive: false, input: { notText: true } },
				],
			},
		]

		// cwd 不変なのでタブ変更は workspaceDidUpdate 経路になる。
		await registeredTabChangeCallback!()
		vitest.runAllTimers()

		const lastCall = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0][0]
		expect(lastCall.openedTabs).toEqual([
			{ label: "active.ts", isActive: true, path: "active.ts" },
			{ label: "inactive.ts", isActive: false, path: "inactive.ts" },
		])
	})

	it("update タイマ発火時に cwd が空なら postMessage せず、normalizeFilePath は resolve にフォールバックする", async () => {
		// 不変条件: 想定外の空 cwd でも落ちず、更新を送らない。
		;(mockProvider.postMessageToWebview as Mock).mockClear()
		;(getWorkspacePath as Mock).mockReturnValue("") // cwd を空へ

		const [[createCallback]] = mockOnDidCreate.mock.calls
		// addFilePath -> normalizeFilePath は cwd 空なので path.resolve(filePath) を使う。
		await createCallback({ fsPath: "/abs/newfile.ts" })
		vitest.runAllTimers() // update タイマ本体で !cwd により return

		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("末尾スラッシュ付きパスは normalizeFilePath でスラッシュを保つ", async () => {
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		;(mockProvider.postMessageToWebview as Mock).mockClear()
		;(vscode.workspace.fs.stat as Mock).mockResolvedValueOnce({ type: 2 }) // Directory

		const [[createCallback]] = mockOnDidCreate.mock.calls
		await createCallback({ fsPath: "/test/workspace/dir/" })
		vitest.runAllTimers()

		const last = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0][0]
		expect(last.filePaths).toContain("dir/")
	})

	it("ディレクトリはスラッシュ付きで記録し、スラッシュ無しの削除でも取り除ける", async () => {
		// 不変条件: ディレクトリ表現の揺れ（末尾スラッシュ有無）を吸収して削除できる。
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		;(mockProvider.postMessageToWebview as Mock).mockClear()
		;(vscode.workspace.fs.stat as Mock).mockResolvedValueOnce({ type: 2 }) // Directory

		const [[createCallback]] = mockOnDidCreate.mock.calls
		await createCallback({ fsPath: "/test/workspace/newdir" }) // -> ".../newdir/" で記録
		vitest.runAllTimers()

		let last = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0][0]
		expect(last.filePaths).toContain("newdir/")

		// スラッシュ無しで削除イベント: delete(path)=false -> delete(path+"/")=true
		const [[deleteCallback]] = mockOnDidDelete.mock.calls
		await deleteCallback({ fsPath: "/test/workspace/newdir" })
		vitest.runAllTimers()

		last = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0][0]
		expect(last.filePaths).not.toContain("newdir/")
	})

	it("reset 時に cwd が空でも getOpenedTabsInfo はタブを集約できる（cwd || '' の右側）", async () => {
		// 不変条件: workspace が外れた（cwd 空）reset でも、開いているタブの列挙で落ちない。
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		const tracker = new WorkspaceTracker(mockProvider) // prevWorkSpacePath = "/test/workspace"
		;(mockProvider.postMessageToWebview as Mock).mockClear()
		;(vscode.window.tabGroups as unknown as { all: unknown[] }).all = [
			{
				tabs: [
					{
						label: "a.ts",
						isActive: true,
						input: new (vscode as unknown as { TabInputText: new (u: unknown) => unknown }).TabInputText({
							fsPath: "/test/workspace/a.ts",
						}),
					},
				],
			},
		]
		;(getWorkspacePath as Mock).mockReturnValue("") // cwd を空へ → reset 経路

		await registeredTabChangeCallback!() // prev "/test/workspace" !== cwd "" -> workspaceDidReset
		vitest.advanceTimersByTime(300) // reset タイマ本体（getOpenedTabsInfo を cwd 空で実行）
		await Promise.resolve()

		const call = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0][0]
		expect(call.filePaths).toEqual([])
		expect(call.openedTabs).toEqual([{ label: "a.ts", isActive: true, path: expect.any(String) }])
		tracker.dispose()
	})

	it("stat が失敗したらファイル扱いで記録する（catch 分岐）", async () => {
		// 不変条件: stat が落ちても（新規作成直後などで起こりうる）落とさずファイルとして加える。
		;(getWorkspacePath as Mock).mockReturnValue("/test/workspace")
		;(mockProvider.postMessageToWebview as Mock).mockClear()
		;(vscode.workspace.fs.stat as Mock).mockRejectedValueOnce(new Error("stat failed"))

		const [[createCallback]] = mockOnDidCreate.mock.calls
		await createCallback({ fsPath: "/test/workspace/ghost.ts" })
		vitest.runAllTimers()

		const last = (mockProvider.postMessageToWebview as Mock).mock.calls.slice(-1)[0][0]
		expect(last.filePaths).toContain("ghost.ts") // スラッシュ無し = ファイル扱い
	})
})
