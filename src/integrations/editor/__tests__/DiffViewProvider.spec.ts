import { DiffViewProvider, DIFF_VIEW_URI_SCHEME, DIFF_VIEW_LABEL_CHANGES } from "../DiffViewProvider"
import * as vscode from "vscode"
import delay from "delay"

// Mock delay
vi.mock("delay", () => ({
	default: vi.fn().mockResolvedValue(undefined),
}))

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue("file content"),
	writeFile: vi.fn().mockResolvedValue(undefined),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
}))

// Mock utils
vi.mock("../../../utils/fs", () => ({
	createDirectoriesForFile: vi.fn().mockResolvedValue([]),
}))

// path はそのまま実物を使う（getReadablePath が join/normalize/relative まで使うため、
// resolve/basename だけの偽物だと壊れる）。linux 上では resolve("/mock/cwd", "x") が
// これまでの偽物と同じ "/mock/cwd/x" を返すので既存テストの期待値も変わらない。
vi.mock("path", async (importOriginal) => await importOriginal<typeof import("path")>())

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		applyEdit: vi.fn(),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		openTextDocument: vi.fn().mockResolvedValue({
			isDirty: false,
			save: vi.fn().mockResolvedValue(undefined),
		}),
		textDocuments: [],
		fs: {
			stat: vi.fn(),
		},
	},
	window: {
		createTextEditorDecorationType: vi.fn(),
		showTextDocument: vi.fn(),
		onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
		tabGroups: {
			all: [],
			close: vi.fn(),
		},
		visibleTextEditors: [],
	},
	commands: {
		executeCommand: vi.fn(),
	},
	languages: {
		getDiagnostics: vi.fn(() => []),
	},
	DiagnosticSeverity: {
		Error: 0,
		Warning: 1,
		Information: 2,
		Hint: 3,
	},
	WorkspaceEdit: vi.fn().mockImplementation(() => ({
		replace: vi.fn(),
		delete: vi.fn(),
	})),
	ViewColumn: {
		Active: 1,
		Beside: 2,
		One: 1,
		Two: 2,
		Three: 3,
		Four: 4,
		Five: 5,
		Six: 6,
		Seven: 7,
		Eight: 8,
		Nine: 9,
	},
	Range: vi.fn(),
	Position: vi.fn(),
	Selection: vi.fn(),
	TextEditorRevealType: {
		InCenter: 2,
	},
	TabInputTextDiff: class TabInputTextDiff {},
	TabInputText: class TabInputText {},
	Uri: {
		file: vi.fn((path) => ({ fsPath: path, scheme: "file" })),
		parse: vi.fn((_uri) => ({ with: vi.fn(() => ({})) })),
	},
}))

// Mock DecorationController
vi.mock("../DecorationController", () => ({
	DecorationController: vi.fn().mockImplementation(() => ({
		setActiveLine: vi.fn(),
		updateOverlayAfterLine: vi.fn(),
		addLines: vi.fn(),
		clear: vi.fn(),
	})),
}))

describe("DiffViewProvider", () => {
	let diffViewProvider: DiffViewProvider
	const mockCwd = "/mock/cwd"
	let mockWorkspaceEdit: { replace: any; delete: any }
	let mockTask: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockWorkspaceEdit = {
			replace: vi.fn(),
			delete: vi.fn(),
		}
		vi.mocked(vscode.WorkspaceEdit).mockImplementation(() => mockWorkspaceEdit as any)

		// Create a mock Task instance
		mockTask = {
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						includeDiagnosticMessages: true,
						maxDiagnosticMessages: 50,
					}),
				}),
			},
		}

		diffViewProvider = new DiffViewProvider(mockCwd, mockTask)
		// Mock the necessary properties and methods
		;(diffViewProvider as any).relPath = "test.txt"
		;(diffViewProvider as any).activeDiffEditor = {
			document: {
				uri: { fsPath: `${mockCwd}/test.txt` },
				getText: vi.fn(),
				lineCount: 10,
			},
			selection: {
				active: { line: 0, character: 0 },
				anchor: { line: 0, character: 0 },
			},
			edit: vi.fn().mockResolvedValue(true),
			revealRange: vi.fn(),
		}
		;(diffViewProvider as any).activeLineController = { setActiveLine: vi.fn(), clear: vi.fn() }
		;(diffViewProvider as any).fadedOverlayController = {
			updateOverlayAfterLine: vi.fn(),
			addLines: vi.fn(),
			clear: vi.fn(),
		}
	})

	describe("update method", () => {
		it("should preserve empty last line when original content has one", async () => {
			;(diffViewProvider as any).originalContent = "Original content\n"
			await diffViewProvider.update("New content", true)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"New content\n",
			)
		})

		it("should not add extra newline when accumulated content already ends with one", async () => {
			;(diffViewProvider as any).originalContent = "Original content\n"
			await diffViewProvider.update("New content\n", true)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"New content\n",
			)
		})

		it("should not add newline when original content does not end with one", async () => {
			;(diffViewProvider as any).originalContent = "Original content"
			await diffViewProvider.update("New content", true)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(expect.anything(), expect.anything(), "New content")
		})
	})

	describe("open method", () => {
		it("should pre-open file as text document before executing diff command", async () => {
			// Setup
			const mockEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/test.md`, scheme: "file" },
					getText: vi.fn().mockReturnValue(""),
					lineCount: 0,
				},
				selection: {
					active: { line: 0, character: 0 },
					anchor: { line: 0, character: 0 },
				},
				edit: vi.fn().mockResolvedValue(true),
				revealRange: vi.fn(),
			}

			// Track the order of calls
			const callOrder: string[] = []

			// Mock showTextDocument to track when it's called
			vi.mocked(vscode.window.showTextDocument).mockImplementation(async (uri, options) => {
				callOrder.push("showTextDocument")
				expect(options).toEqual({ preview: false, viewColumn: vscode.ViewColumn.Active, preserveFocus: true })
				return mockEditor as any
			})

			// Mock executeCommand to track when it's called
			vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
				callOrder.push("executeCommand")
				expect(command).toBe("vscode.diff")
				return undefined
			})

			// Mock workspace.onDidOpenTextDocument to trigger immediately
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((callback) => {
				// Trigger the callback immediately with the document
				setTimeout(() => {
					callback({ uri: { fsPath: `${mockCwd}/test.md`, scheme: "file" } } as any)
				}, 0)
				return { dispose: vi.fn() }
			})

			// Mock window.visibleTextEditors to return our editor
			vi.mocked(vscode.window).visibleTextEditors = [mockEditor as any]

			// Set up for file
			;(diffViewProvider as any).editType = "modify"

			// Execute open
			await diffViewProvider.open("test.md")

			// Verify that showTextDocument was called before executeCommand
			expect(callOrder).toEqual(["showTextDocument", "executeCommand"])

			// Verify that showTextDocument was called with preview: false and preserveFocus: true
			expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: `${mockCwd}/test.md` }),
				{ preview: false, viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
			)

			// Verify that the diff command was executed
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.any(Object),
				expect.any(Object),
				`test.md: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
				{ preserveFocus: true },
			)
		})

		it("should handle showTextDocument failure", async () => {
			// Mock showTextDocument to fail
			vi.mocked(vscode.window.showTextDocument).mockRejectedValue(new Error("Cannot open file"))

			// Mock workspace.onDidOpenTextDocument
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockReturnValue({ dispose: vi.fn() })

			// Mock window.onDidChangeVisibleTextEditors
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })

			// Set up for file
			;(diffViewProvider as any).editType = "modify"

			// Try to open and expect rejection
			await expect(diffViewProvider.open("test.md")).rejects.toThrow(
				"Failed to execute diff command for /mock/cwd/test.md: Cannot open file",
			)
		})
	})

	describe("closeAllDiffViews method", () => {
		it("should close diff views including those identified by label", async () => {
			// Mock tab groups with various types of tabs
			const mockTabs = [
				// Normal diff view
				{
					input: {
						constructor: { name: "TabInputTextDiff" },
						original: { scheme: DIFF_VIEW_URI_SCHEME },
						modified: { fsPath: "/test/file1.ts" },
					},
					label: `file1.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
					isDirty: false,
				},
				// Diff view identified by label (for pre-opened files)
				{
					input: {
						constructor: { name: "TabInputTextDiff" },
						original: { scheme: "file" }, // Different scheme due to pre-opening
						modified: { fsPath: "/test/file2.md" },
					},
					label: `file2.md: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
					isDirty: false,
				},
				// Regular file tab (should not be closed)
				{
					input: {
						constructor: { name: "TabInputText" },
						uri: { fsPath: "/test/file3.js" },
					},
					label: "file3.js",
					isDirty: false,
				},
				// Dirty diff view (should not be closed)
				{
					input: {
						constructor: { name: "TabInputTextDiff" },
						original: { scheme: DIFF_VIEW_URI_SCHEME },
						modified: { fsPath: "/test/file4.ts" },
					},
					label: `file4.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`,
					isDirty: true,
				},
			]

			// Make tabs appear as TabInputTextDiff instances
			mockTabs.forEach((tab) => {
				if (tab.input.constructor.name === "TabInputTextDiff") {
					Object.setPrototypeOf(tab.input, vscode.TabInputTextDiff.prototype)
				}
			})

			// Mock the tabGroups getter
			Object.defineProperty(vscode.window.tabGroups, "all", {
				get: () => [
					{
						tabs: mockTabs as any,
					},
				],
				configurable: true,
			})

			const closedTabs: any[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((tab) => {
				closedTabs.push(tab)
				return Promise.resolve(true)
			})

			// Execute closeAllDiffViews
			await (diffViewProvider as any).closeAllDiffViews()

			// Verify that only the appropriate tabs were closed
			expect(closedTabs).toHaveLength(2)
			expect(closedTabs[0].label).toBe(`file1.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`)
			expect(closedTabs[1].label).toBe(`file2.md: ${DIFF_VIEW_LABEL_CHANGES} (Editable)`)

			// Verify that the regular file and dirty diff were not closed
			expect(closedTabs.find((t) => t.label === "file3.js")).toBeUndefined()
			expect(
				closedTabs.find((t) => t.label === `file4.ts: ${DIFF_VIEW_LABEL_CHANGES} (Editable)` && t.isDirty),
			).toBeUndefined()
		})
	})

	describe("saveDirectly method", () => {
		beforeEach(() => {
			// Mock vscode functions
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
		})

		it("should write content directly to file without opening diff view", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			const result = await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 2000)

			// Verify file was written
			const fs = await import("fs/promises")
			expect(fs.writeFile).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content", "utf-8")

			// Verify file was opened without focus
			expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: `${mockCwd}/test.ts` }),
				{ preview: false, preserveFocus: true },
			)

			// Verify diagnostics were checked after delay
			expect(mockDelay).toHaveBeenCalledWith(2000)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()

			// Verify result
			expect(result.newProblemsMessage).toBe("")
			expect(result.userEdits).toBeUndefined()
			expect(result.finalContent).toBe("new content")
		})

		it("should not open file when openWithoutFocus is false", async () => {
			await diffViewProvider.saveDirectly("test.ts", "new content", false, true, 1000)

			// Verify file was written
			const fs = await import("fs/promises")
			expect(fs.writeFile).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content", "utf-8")

			// Verify file was NOT opened
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})

		it("should skip diagnostics when diagnosticsEnabled is false", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()
			vi.mocked(vscode.languages.getDiagnostics).mockClear()

			await diffViewProvider.saveDirectly("test.ts", "new content", true, false, 1000)

			// Verify file was written
			const fs = await import("fs/promises")
			expect(fs.writeFile).toHaveBeenCalledWith(`${mockCwd}/test.ts`, "new content", "utf-8")

			// Verify delay was NOT called
			expect(mockDelay).not.toHaveBeenCalled()
			// getDiagnostics is called once for pre-diagnostics, but not for post-diagnostics
			expect(vscode.languages.getDiagnostics).toHaveBeenCalledTimes(1)
		})

		it("should handle negative delay values", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, -500)

			// Verify delay was called with 0 (safe minimum)
			expect(mockDelay).toHaveBeenCalledWith(0)
		})

		it("should store results for formatFileWriteResponse", async () => {
			await diffViewProvider.saveDirectly("test.ts", "new content", true, true, 1000)

			// Verify internal state was updated
			expect((diffViewProvider as any).newProblemsMessage).toBe("")
			expect((diffViewProvider as any).userEdits).toBeUndefined()
			expect((diffViewProvider as any).relPath).toBe("test.ts")
			expect((diffViewProvider as any).newContent).toBe("new content")
		})
	})

	describe("saveChanges method with diagnostic settings", () => {
		beforeEach(() => {
			// Setup common mocks for saveChanges tests
			;(diffViewProvider as any).relPath = "test.ts"
			;(diffViewProvider as any).newContent = "new content"
			;(diffViewProvider as any).activeDiffEditor = {
				document: {
					getText: vi.fn().mockReturnValue("new content"),
					isDirty: false,
					save: vi.fn().mockResolvedValue(undefined),
				},
			}
			;(diffViewProvider as any).preDiagnostics = []

			// Mock vscode functions
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
		})

		it("should apply diagnostic delay when diagnosticsEnabled is true", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)

			const result = await diffViewProvider.saveChanges(true, 3000)

			// Verify delay was called with correct duration
			expect(mockDelay).toHaveBeenCalledWith(3000)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()
			expect(result.newProblemsMessage).toBe("")
		})

		it("should skip diagnostics when diagnosticsEnabled is false", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)

			const result = await diffViewProvider.saveChanges(false, 2000)

			// Verify delay was NOT called and diagnostics were NOT checked
			expect(mockDelay).not.toHaveBeenCalled()
			expect(vscode.languages.getDiagnostics).not.toHaveBeenCalled()
			expect(result.newProblemsMessage).toBe("")
		})

		it("should use default values when no parameters provided", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)

			const result = await diffViewProvider.saveChanges()

			// Verify default behavior (enabled=true, delay=2000ms)
			expect(mockDelay).toHaveBeenCalledWith(1000)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()
			expect(result.newProblemsMessage).toBe("")
		})

		it("should handle custom delay values", async () => {
			const mockDelay = vi.mocked(delay)
			mockDelay.mockClear()

			// Mock closeAllDiffViews
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)

			await diffViewProvider.saveChanges(true, 5000)

			// Verify custom delay was used
			expect(mockDelay).toHaveBeenCalledWith(5000)
			expect(vscode.languages.getDiagnostics).toHaveBeenCalled()
		})
	})

	// ここから下は「実際にファイルへ書く本体」と復元処理まわりの不変条件を守るテスト。
	// diff エディタの解決は onDidOpenTextDocument を即発火させて模す。
	const makeEditor = (fsPath: string, lineCount = 0) => ({
		document: {
			uri: { fsPath, scheme: "file" },
			getText: vi.fn().mockReturnValue(""),
			lineCount,
		},
		selection: {
			active: { line: 0, character: 0 },
			anchor: { line: 0, character: 0 },
		},
		edit: vi.fn().mockResolvedValue(true),
		revealRange: vi.fn(),
	})

	// open() の後半にある openDiffEditor を、ファイルドキュメントの open イベント経由で解決させる。
	const primeDiffEditorOpen = (editor: any, fsPath: string) => {
		vi.mocked(vscode.window.showTextDocument).mockResolvedValue(editor)
		vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined as any)
		vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((cb: any) => {
			setTimeout(() => cb({ uri: { fsPath, scheme: "file" } }), 0)
			return { dispose: vi.fn() }
		})
		vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
		;(vscode.window as any).visibleTextEditors = [editor]
	}

	const setTabs = (tabs: any[]) => {
		Object.defineProperty(vscode.window.tabGroups, "all", {
			get: () => (tabs.length ? [{ tabs }] : []),
			configurable: true,
		})
	}

	describe("open method - write body and setup", () => {
		it("creates a new file, writes an empty placeholder, and records empty original content", async () => {
			const fsPath = `${mockCwd}/brand-new.ts`
			const editor = makeEditor(fsPath)
			primeDiffEditorOpen(editor, fsPath)
			setTabs([])
			;(vscode.workspace as any).textDocuments = []
			const fs = await import("fs/promises")
			vi.mocked(fs.readFile).mockClear()
			vi.mocked(fs.writeFile).mockClear()

			const provider = new DiffViewProvider(mockCwd, mockTask)
			provider.editType = undefined // 新規ファイル

			await provider.open("brand-new.ts")

			expect(provider.originalContent).toBe("")
			// 新規ファイルは空文字で place-holder を書く。既存内容の読み込みはしない。
			expect(fs.writeFile).toHaveBeenCalledWith(fsPath, "")
			expect(fs.readFile).not.toHaveBeenCalled()
		})

		it("saves a dirty existing document before reading its original content", async () => {
			const fsPath = `${mockCwd}/existing.ts`
			const save = vi.fn().mockResolvedValue(undefined)
			;(vscode.workspace as any).textDocuments = [{ uri: { scheme: "file", fsPath }, isDirty: true, save }]
			const editor = makeEditor(fsPath)
			primeDiffEditorOpen(editor, fsPath)
			setTabs([])
			const fs = await import("fs/promises")
			vi.mocked(fs.readFile).mockResolvedValue("ORIGINAL BODY")

			const provider = new DiffViewProvider(mockCwd, mockTask)
			provider.editType = "modify"

			await provider.open("existing.ts")

			expect(save).toHaveBeenCalledTimes(1)
			expect(provider.originalContent).toBe("ORIGINAL BODY")
			;(vscode.workspace as any).textDocuments = []
		})

		it("closes an already-open file tab and marks the document as previously open", async () => {
			const fsPath = `${mockCwd}/reopen.ts`
			const editor = makeEditor(fsPath)
			primeDiffEditorOpen(editor, fsPath)
			;(vscode.workspace as any).textDocuments = []
			const fileTabInput = Object.assign(Object.create(vscode.TabInputText.prototype), {
				uri: { scheme: "file", fsPath },
			})
			const fileTab = { input: fileTabInput, isDirty: false, label: "reopen.ts" }
			setTabs([fileTab])
			const closed: any[] = []
			vi.mocked(vscode.window.tabGroups.close).mockImplementation((t: any) => {
				closed.push(t)
				return Promise.resolve(true)
			})

			const provider = new DiffViewProvider(mockCwd, mockTask)
			provider.editType = "modify"

			await provider.open("reopen.ts")

			expect(closed).toContain(fileTab)
			expect((provider as any).documentWasOpen).toBe(true)
		})

		it("logs but continues when closing an open tab throws", async () => {
			const fsPath = `${mockCwd}/reopen2.ts`
			const editor = makeEditor(fsPath)
			primeDiffEditorOpen(editor, fsPath)
			;(vscode.workspace as any).textDocuments = []
			const fileTabInput = Object.assign(Object.create(vscode.TabInputText.prototype), {
				uri: { scheme: "file", fsPath },
			})
			const fileTab = { input: fileTabInput, isDirty: false, label: "reopen2.ts" }
			setTabs([fileTab])
			vi.mocked(vscode.window.tabGroups.close).mockRejectedValue(new Error("cannot close"))
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})

			const provider = new DiffViewProvider(mockCwd, mockTask)
			provider.editType = "modify"

			await provider.open("reopen2.ts")

			expect(spy).toHaveBeenCalledWith(expect.stringContaining("Failed to close tab"), expect.anything())
			expect((provider as any).documentWasOpen).toBe(true)
			spy.mockRestore()
		})
	})

	describe("update method - streaming and guards", () => {
		it("throws when required values are not set", async () => {
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = undefined

			await expect(provider.update("x", true)).rejects.toThrow("Required values not set")
		})

		it("throws when the user closed the editor", async () => {
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = "test.txt"
			;(provider as any).activeLineController = { setActiveLine: vi.fn(), clear: vi.fn() }
			;(provider as any).fadedOverlayController = {
				updateOverlayAfterLine: vi.fn(),
				addLines: vi.fn(),
				clear: vi.fn(),
			}
			;(provider as any).activeDiffEditor = undefined

			await expect(provider.update("x", true)).rejects.toThrow("User closed text editor")
		})

		it("streams non-final content and drops the partial last line", async () => {
			;(diffViewProvider as any).originalContent = "orig\n"
			;(diffViewProvider as any).activeDiffEditor.visibleRanges = [{ start: { line: 0 }, end: { line: 100 } }]

			await diffViewProvider.update("line1\nline2\npartial", false)

			// 未確定の "partial" 行は落とし、"line1\nline2\n" までを反映する。
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				"line1\nline2\n",
			)
			expect((diffViewProvider as any).streamedLines).toEqual(["line1", "line2"])
		})

		it("writes an empty replacement when there are no accumulated lines yet", async () => {
			;(diffViewProvider as any).originalContent = "orig\n"
			;(diffViewProvider as any).activeDiffEditor.visibleRanges = []

			// "" を非最終で流すと split→pop で行が 0 本になり、末尾改行を足さず "" を書く。
			await diffViewProvider.update("", false)

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(expect.anything(), expect.anything(), "")
			expect((diffViewProvider as any).streamedLines).toEqual([])
		})
	})

	describe("saveChanges - write body", () => {
		it("returns an empty result when preconditions are missing", async () => {
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = "x.ts"
			;(provider as any).newContent = undefined
			;(provider as any).activeDiffEditor = undefined

			const result = await provider.saveChanges()

			expect(result).toEqual({ newProblemsMessage: undefined, userEdits: undefined, finalContent: undefined })
		})

		it("saves the dirty diff document before closing the views", async () => {
			const save = vi.fn().mockResolvedValue(undefined)
			;(diffViewProvider as any).relPath = "dirty.ts"
			;(diffViewProvider as any).newContent = "agent content"
			;(diffViewProvider as any).activeDiffEditor = {
				document: { getText: vi.fn().mockReturnValue("agent content"), isDirty: true, save },
			}
			;(diffViewProvider as any).preDiagnostics = []
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			const result = await diffViewProvider.saveChanges(false, 0)

			expect(save).toHaveBeenCalledTimes(1)
			expect(result.finalContent).toBe("agent content")
			expect(result.userEdits).toBeUndefined()
		})

		it("captures the user's edits as a pretty patch when the editor content differs", async () => {
			;(diffViewProvider as any).relPath = "edited.ts"
			;(diffViewProvider as any).newContent = "line a\nline b\n"
			;(diffViewProvider as any).activeDiffEditor = {
				document: {
					getText: vi.fn().mockReturnValue("line a\nline B CHANGED\n"),
					isDirty: false,
					save: vi.fn(),
				},
			}
			;(diffViewProvider as any).preDiagnostics = []
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			const result = await diffViewProvider.saveChanges(false, 0)

			expect(result.userEdits).toBeDefined()
			expect(result.userEdits).toContain("CHANGED")
			// finalContent は「エディタ上の実際の内容」であって agent の元案ではない。
			expect(result.finalContent).toBe("line a\nline B CHANGED\n")
			expect((diffViewProvider as any).userEdits).toBe(result.userEdits)
		})
	})

	describe("pushToolWriteResult", () => {
		it("throws when no file path is set", async () => {
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = undefined

			await expect(provider.pushToolWriteResult({ say: vi.fn() } as any, mockCwd, true)).rejects.toThrow(
				"No file path available",
			)
		})

		it("sends user_feedback_diff and includes user_edits when the user edited", async () => {
			const say = vi.fn().mockResolvedValue(undefined)
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = "src/edited.ts"
			;(provider as any).userEdits = "@@ -1 +1 @@\n-a\n+b"
			;(provider as any).newProblemsMessage = "\n\nNew problems detected"

			const payload = JSON.parse(await provider.pushToolWriteResult({ say } as any, mockCwd, false))

			expect(say).toHaveBeenCalledTimes(1)
			expect(say.mock.calls[0][0]).toBe("user_feedback_diff")
			const sayArg = JSON.parse(say.mock.calls[0][1])
			expect(sayArg.tool).toBe("editedExistingFile")
			expect(sayArg.diff).toBe("@@ -1 +1 @@\n-a\n+b")
			expect(payload.operation).toBe("modified")
			expect(payload.user_edits).toBe("@@ -1 +1 @@\n-a\n+b")
			expect(payload.problems).toBe("\n\nNew problems detected")
		})

		it("does not send feedback and omits user_edits when the content is unchanged", async () => {
			const say = vi.fn().mockResolvedValue(undefined)
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = "src/created.ts"
			;(provider as any).userEdits = undefined

			const payload = JSON.parse(await provider.pushToolWriteResult({ say } as any, mockCwd, true))

			expect(say).not.toHaveBeenCalled()
			expect(payload.operation).toBe("created")
			expect(payload.user_edits).toBeUndefined()
		})

		it("labels the feedback as a new file when isNewFile is true and the user edited", async () => {
			const say = vi.fn().mockResolvedValue(undefined)
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = "src/fresh.ts"
			;(provider as any).userEdits = "@@ -0 +1 @@\n+hello"

			await provider.pushToolWriteResult({ say } as any, mockCwd, true)

			const sayArg = JSON.parse(say.mock.calls[0][1])
			expect(sayArg.tool).toBe("newFileCreated")
		})
	})

	describe("revertChanges - restores original state", () => {
		it("does nothing when there is no active edit", async () => {
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = undefined
			;(provider as any).activeDiffEditor = undefined
			const fs = await import("fs/promises")
			vi.mocked(fs.unlink).mockClear()

			await provider.revertChanges()

			expect(fs.unlink).not.toHaveBeenCalled()
		})

		it("new file: closes views, deletes the file, and removes created dirs in reverse order", async () => {
			const fs = await import("fs/promises")
			vi.mocked(fs.unlink).mockClear()
			const rmdirOrder: string[] = []
			vi.mocked(fs.rmdir).mockImplementation(async (p: any) => {
				rmdirOrder.push(p)
				return undefined as any
			})
			const save = vi.fn().mockResolvedValue(undefined)
			const provider = new DiffViewProvider(mockCwd, mockTask)
			provider.editType = undefined // 新規ファイル
			;(provider as any).relPath = "new/deep/file.ts"
			;(provider as any).createdDirs = [`${mockCwd}/new`, `${mockCwd}/new/deep`]
			;(provider as any).activeDiffEditor = { document: { isDirty: true, save } }
			;(provider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(provider as any).reset = vi.fn().mockResolvedValue(undefined)

			await provider.revertChanges()

			expect(save).toHaveBeenCalledTimes(1)
			// 破棄したら中途半端な内容を残さず、作ったファイル自体を消す。
			expect(fs.unlink).toHaveBeenCalledWith(`${mockCwd}/new/deep/file.ts`)
			// 作成したディレクトリは深い方から順に消す。
			expect(rmdirOrder).toEqual([`${mockCwd}/new/deep`, `${mockCwd}/new`])
			expect((provider as any).reset).toHaveBeenCalled()
		})

		it("existing file: rewrites the exact original content and saves", async () => {
			const save = vi.fn().mockResolvedValue(undefined)
			const originalText = "ORIGINAL\ncontent\n"
			const provider = new DiffViewProvider(mockCwd, mockTask)
			provider.editType = "modify"
			provider.originalContent = originalText
			;(provider as any).relPath = "keep.ts"
			;(provider as any).documentWasOpen = false
			;(provider as any).activeDiffEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/keep.ts` },
					getText: vi.fn().mockReturnValue("agent overwrote this"),
					positionAt: vi.fn((n: number) => ({ offset: n })),
					save,
				},
			}
			;(provider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(provider as any).reset = vi.fn().mockResolvedValue(undefined)

			await provider.revertChanges()

			// 元の内容ちょうどに戻す replace が呼ばれる（部分的な内容を残さない）。
			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(expect.anything(), expect.anything(), originalText)
			expect(save).toHaveBeenCalledTimes(1)
		})

		it("existing file: falls back to empty content when the original is unknown", async () => {
			const save = vi.fn().mockResolvedValue(undefined)
			const provider = new DiffViewProvider(mockCwd, mockTask)
			provider.editType = "modify"
			provider.originalContent = undefined
			;(provider as any).relPath = "keep3.ts"
			;(provider as any).documentWasOpen = false
			;(provider as any).activeDiffEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/keep3.ts` },
					getText: vi.fn().mockReturnValue("agent"),
					positionAt: vi.fn((n: number) => ({ offset: n })),
					save,
				},
			}
			;(provider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(provider as any).reset = vi.fn().mockResolvedValue(undefined)

			await provider.revertChanges()

			expect(mockWorkspaceEdit.replace).toHaveBeenCalledWith(expect.anything(), expect.anything(), "")
		})

		it("existing file: reopens the document when it was open before the edit", async () => {
			const provider = new DiffViewProvider(mockCwd, mockTask)
			provider.editType = "modify"
			provider.originalContent = "x"
			;(provider as any).relPath = "keep2.ts"
			;(provider as any).documentWasOpen = true
			;(provider as any).activeDiffEditor = {
				document: {
					uri: { fsPath: `${mockCwd}/keep2.ts` },
					getText: vi.fn().mockReturnValue("y"),
					positionAt: vi.fn((n: number) => ({ offset: n })),
					save: vi.fn().mockResolvedValue(undefined),
				},
			}
			;(provider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			;(provider as any).reset = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await provider.revertChanges()

			expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: `${mockCwd}/keep2.ts` }),
				{ preview: false, preserveFocus: true },
			)
		})
	})

	describe("collectNewProblems edge cases", () => {
		it("keeps going when the write delay rejects", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			vi.mocked(delay).mockRejectedValueOnce(new Error("delay failed"))
			;(diffViewProvider as any).relPath = "d.ts"
			;(diffViewProvider as any).newContent = "c"
			;(diffViewProvider as any).activeDiffEditor = {
				document: { getText: vi.fn().mockReturnValue("c"), isDirty: false, save: vi.fn() },
			}
			;(diffViewProvider as any).preDiagnostics = []
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])

			const result = await diffViewProvider.saveChanges(true, 100)

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to apply write delay"))
			expect(result.newProblemsMessage).toBe("")
			warn.mockRestore()
		})

		it("defaults diagnostic settings when the task state is unavailable", async () => {
			// providerRef.deref() が undefined → state?.x ?? default の右側へ落ちる。
			const taskWithoutState = { providerRef: { deref: vi.fn().mockReturnValue(undefined) } }
			const provider = new DiffViewProvider(mockCwd, taskWithoutState as any)
			;(provider as any).relPath = "s.ts"
			;(provider as any).newContent = "c"
			;(provider as any).activeDiffEditor = {
				document: { getText: vi.fn().mockReturnValue("c"), isDirty: false, save: vi.fn() },
			}
			;(provider as any).preDiagnostics = []
			;(provider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])

			const result = await provider.saveChanges(true, 0)

			expect(result.newProblemsMessage).toBe("")
		})
	})

	describe("closeAllDiffViews failure", () => {
		it("logs when closing a diff tab rejects", async () => {
			const diffInput = Object.assign(Object.create(vscode.TabInputTextDiff.prototype), {
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified: { fsPath: "/x/f.ts" },
			})
			const tab = { input: diffInput, isDirty: false, label: `f.ts: ${DIFF_VIEW_LABEL_CHANGES}` }
			setTabs([tab])
			vi.mocked(vscode.window.tabGroups.close).mockRejectedValue(new Error("nope"))
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})

			await (diffViewProvider as any).closeAllDiffViews()

			expect(spy).toHaveBeenCalledWith(expect.stringContaining("Failed to close diff tab"), expect.anything())
			spy.mockRestore()
		})
	})

	describe("openDiffEditor", () => {
		it("throws when relPath is not set", async () => {
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = undefined

			await expect((provider as any).openDiffEditor()).rejects.toThrow("No file path set")
		})

		it("reuses an already-open diff tab", async () => {
			const modified = { fsPath: `${mockCwd}/reuse.ts` }
			const diffInput = Object.assign(Object.create(vscode.TabInputTextDiff.prototype), {
				original: { scheme: DIFF_VIEW_URI_SCHEME },
				modified,
			})
			setTabs([{ input: diffInput }])
			const editor = makeEditor(`${mockCwd}/reuse.ts`)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(editor as any)

			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = "reuse.ts"
			;(provider as any).originalContent = ""

			const result = await (provider as any).openDiffEditor()

			expect(result).toBe(editor)
			expect(vscode.window.showTextDocument).toHaveBeenCalledWith(modified, { preserveFocus: true })
		})

		it("encodes an empty original into the diff query when originalContent is unset", async () => {
			const fsPath = `${mockCwd}/noorig.ts`
			const editor = makeEditor(fsPath)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(editor as any)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockImplementation((cb: any) => {
				setTimeout(() => cb({ uri: { fsPath, scheme: "file" } }), 0)
				return { dispose: vi.fn() }
			})
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
			;(vscode.window as any).visibleTextEditors = [editor]
			setTabs([])

			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).relPath = "noorig.ts"
			;(provider as any).originalContent = undefined // `?? ""` の右側を通す

			const result = await (provider as any).openDiffEditor()

			expect(result).toBe(editor)
		})

		it("resolves via the visible-editors fallback when onDidOpenTextDocument never fires", async () => {
			const fsPath = `${mockCwd}/fallback.ts`
			const editor = makeEditor(fsPath)
			;(vscode.workspace as any).textDocuments = []
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue(editor as any)
			vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined as any)
			vi.mocked(vscode.workspace.onDidOpenTextDocument).mockReturnValue({ dispose: vi.fn() })
			vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockImplementation((cb: any) => {
				setTimeout(() => cb([editor]), 0)
				return { dispose: vi.fn() }
			})
			;(vscode.window as any).visibleTextEditors = []
			setTabs([])

			const provider = new DiffViewProvider(mockCwd, mockTask)
			provider.editType = "modify"

			await provider.open("fallback.ts")

			expect((provider as any).activeDiffEditor).toBe(editor)
		})

		it("rejects when the diff editor never appears (timeout)", async () => {
			vi.useFakeTimers()
			try {
				vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)
				vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined as any)
				vi.mocked(vscode.workspace.onDidOpenTextDocument).mockReturnValue({ dispose: vi.fn() })
				vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockReturnValue({ dispose: vi.fn() })
				setTabs([])

				const provider = new DiffViewProvider(mockCwd, mockTask)
				;(provider as any).relPath = "never.ts"
				;(provider as any).originalContent = ""

				const p = (provider as any).openDiffEditor()
				const assertion = expect(p).rejects.toThrow(/within 10 seconds/)
				await vi.advanceTimersByTimeAsync(10_000)
				await assertion
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("scrollToFirstDiff", () => {
		it("does nothing without an active editor", () => {
			const provider = new DiffViewProvider(mockCwd, mockTask)
			;(provider as any).activeDiffEditor = undefined

			expect(() => provider.scrollToFirstDiff()).not.toThrow()
		})

		it("reveals the first differing line", () => {
			const revealRange = vi.fn()
			;(diffViewProvider as any).originalContent = "a\nb\nc\n"
			;(diffViewProvider as any).activeDiffEditor = {
				document: { getText: vi.fn().mockReturnValue("a\nX\nc\n") },
				revealRange,
			}

			diffViewProvider.scrollToFirstDiff()

			expect(revealRange).toHaveBeenCalled()
		})

		it("does nothing when there is no diff", () => {
			const revealRange = vi.fn()
			;(diffViewProvider as any).originalContent = "a\nb\n"
			;(diffViewProvider as any).activeDiffEditor = {
				document: { getText: vi.fn().mockReturnValue("a\nb\n") },
				revealRange,
			}

			diffViewProvider.scrollToFirstDiff()

			expect(revealRange).not.toHaveBeenCalled()
		})

		it("treats unknown original content as empty and reveals the first line", () => {
			const revealRange = vi.fn()
			;(diffViewProvider as any).originalContent = undefined // `|| ""` の右側を通す
			;(diffViewProvider as any).activeDiffEditor = {
				document: { getText: vi.fn().mockReturnValue("a\n") },
				revealRange,
			}

			diffViewProvider.scrollToFirstDiff()

			expect(revealRange).toHaveBeenCalled()
		})
	})

	describe("reset", () => {
		it("clears all per-edit state", async () => {
			;(diffViewProvider as any).closeAllDiffViews = vi.fn().mockResolvedValue(undefined)
			diffViewProvider.editType = "modify"
			diffViewProvider.isEditing = true
			diffViewProvider.originalContent = "x"
			;(diffViewProvider as any).createdDirs = ["/a"]
			;(diffViewProvider as any).documentWasOpen = true
			;(diffViewProvider as any).activeDiffEditor = {}
			;(diffViewProvider as any).streamedLines = ["a"]
			;(diffViewProvider as any).preDiagnostics = [1]

			await diffViewProvider.reset()

			expect(diffViewProvider.editType).toBeUndefined()
			expect(diffViewProvider.isEditing).toBe(false)
			expect(diffViewProvider.originalContent).toBeUndefined()
			expect((diffViewProvider as any).createdDirs).toEqual([])
			expect((diffViewProvider as any).documentWasOpen).toBe(false)
			expect((diffViewProvider as any).activeDiffEditor).toBeUndefined()
			expect((diffViewProvider as any).streamedLines).toEqual([])
			expect((diffViewProvider as any).preDiagnostics).toEqual([])
		})
	})

	describe("saveDirectly - in-memory save", () => {
		it("saves the in-memory document when it is dirty and openFile is false", async () => {
			const save = vi.fn().mockResolvedValue(undefined)
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({ isDirty: true, save } as any)
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
			vi.mocked(vscode.window.showTextDocument).mockClear()
			const fs = await import("fs/promises")

			await diffViewProvider.saveDirectly("mem.ts", "body", false, false, 0)

			expect(fs.writeFile).toHaveBeenCalledWith(`${mockCwd}/mem.ts`, "body", "utf-8")
			expect(save).toHaveBeenCalledTimes(1)
			expect(vscode.window.showTextDocument).not.toHaveBeenCalled()
		})
	})
})
