// npx vitest src/integrations/editor/__tests__/EditorUtils.spec.ts

import * as vscode from "vscode"

import { EditorUtils } from "../EditorUtils"

// Use simple classes to simulate VSCode's Range and Position behavior.
vi.mock("vscode", () => {
	class MockPosition {
		constructor(
			public line: number,
			public character: number,
		) {}
	}
	class MockRange {
		start: MockPosition
		end: MockPosition
		constructor(start: MockPosition, end: MockPosition) {
			this.start = start
			this.end = end
		}
	}

	return {
		Range: MockRange,
		Position: MockPosition,
		workspace: {
			getWorkspaceFolder: vi.fn(),
		},
		window: { activeTextEditor: undefined },
		languages: {
			getDiagnostics: vi.fn(() => []),
		},
		DiagnosticSeverity: {
			Error: 0,
			Warning: 1,
			Information: 2,
			Hint: 3,
		},
	}
})

describe("EditorUtils", () => {
	let mockDocument: any

	beforeEach(() => {
		mockDocument = {
			getText: vi.fn(),
			lineAt: vi.fn(),
			lineCount: 10,
			uri: { fsPath: "/test/file.ts" },
		}
	})

	describe("getEffectiveRange", () => {
		it("should return selected text when available", () => {
			const mockRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
			mockDocument.getText.mockReturnValue("selected text")

			const result = EditorUtils.getEffectiveRange(mockDocument, mockRange)

			expect(result).toEqual({
				range: mockRange,
				text: "selected text",
			})
		})

		it("should return null for empty line", () => {
			const mockRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
			mockDocument.getText.mockReturnValue("")
			mockDocument.lineAt.mockReturnValue({ text: "", lineNumber: 0 })

			const result = EditorUtils.getEffectiveRange(mockDocument, mockRange)

			expect(result).toBeNull()
		})

		it("should expand empty selection to full lines", () => {
			// Simulate a caret (empty selection) on line 2 at character 5.
			const initialRange = new vscode.Range(new vscode.Position(2, 5), new vscode.Position(2, 5))
			// Return non-empty text for any line with text (lines 1, 2, and 3).
			mockDocument.lineAt.mockImplementation((line: number) => {
				return { text: `Line ${line} text`, lineNumber: line }
			})
			mockDocument.getText.mockImplementation((range: any) => {
				// If the range is exactly the empty initial selection, return an empty string.
				if (
					range.start.line === initialRange.start.line &&
					range.start.character === initialRange.start.character &&
					range.end.line === initialRange.end.line &&
					range.end.character === initialRange.end.character
				) {
					return ""
				}
				return "expanded text"
			})

			const result = EditorUtils.getEffectiveRange(mockDocument, initialRange)

			expect(result).not.toBeNull()
			// Expected effective range: from the beginning of line 1 to the end of line 3.
			expect(result?.range.start).toEqual({ line: 1, character: 0 })
			expect(result?.range.end).toEqual({ line: 3, character: 11 })
			expect(result?.text).toBe("expanded text")
		})

		it("clamps the expanded range at the document boundaries", () => {
			// キャレットが 1 行だけのドキュメントの先頭にある場合、前後に広げようとしても
			// 0 行目〜最終行に丸め込まれる（Math.max/Math.min の両端）。
			const caret = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
			mockDocument.lineCount = 1
			mockDocument.lineAt.mockImplementation((line: number) => ({ text: "only line", lineNumber: line }))
			mockDocument.getText.mockImplementation((range: any) => {
				if (range.start.line === 0 && range.start.character === 0 && range.end.character === 0) {
					return ""
				}
				return "only line"
			})

			const result = EditorUtils.getEffectiveRange(mockDocument, caret)

			expect(result?.range.start).toEqual({ line: 0, character: 0 })
			expect(result?.range.end).toEqual({ line: 0, character: 9 })
		})

		it("returns null and logs when reading the range throws", () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})
			mockDocument.getText.mockImplementation(() => {
				throw new Error("boom")
			})
			const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))

			expect(EditorUtils.getEffectiveRange(mockDocument, range)).toBeNull()
			expect(spy).toHaveBeenCalled()
			spy.mockRestore()
		})
	})

	describe("hasIntersectingRange", () => {
		it("should return false for ranges that only touch boundaries", () => {
			// Range1: [0, 0) - [0, 10) and Range2: [0, 10) - [0, 20)
			const range1 = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
			const range2 = new vscode.Range(new vscode.Position(0, 10), new vscode.Position(0, 20))
			expect(EditorUtils.hasIntersectingRange(range1, range2)).toBe(false)
		})

		it("should return true for overlapping ranges", () => {
			// Range1: [0, 0) - [0, 15) and Range2: [0, 10) - [0, 20)
			const range1 = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 15))
			const range2 = new vscode.Range(new vscode.Position(0, 10), new vscode.Position(0, 20))
			expect(EditorUtils.hasIntersectingRange(range1, range2)).toBe(true)
		})

		it("should return false for non-overlapping ranges", () => {
			// Range1: [0, 0) - [0, 10) and Range2: [1, 0) - [1, 5)
			const range1 = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
			const range2 = new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 5))
			expect(EditorUtils.hasIntersectingRange(range1, range2)).toBe(false)
		})

		it("returns false when range2 ends where range1 begins on the same line", () => {
			// range2 が range1 より前に閉じるケース。2 番目の early-return（161-162 行）を通す。
			// Range1: [0, 10) - [0, 20), Range2: [0, 0) - [0, 10)
			const range1 = new vscode.Range(new vscode.Position(0, 10), new vscode.Position(0, 20))
			const range2 = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 10))
			expect(EditorUtils.hasIntersectingRange(range1, range2)).toBe(false)
		})
	})

	describe("getFilePath", () => {
		it("should return relative path when in workspace", () => {
			const mockWorkspaceFolder = {
				uri: { fsPath: "/test" },
				name: "test",
				index: 0,
			}
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(mockWorkspaceFolder as any)

			const result = EditorUtils.getFilePath(mockDocument)

			expect(result).toBe("file.ts")
		})

		it("should return absolute path when not in workspace", () => {
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)

			const result = EditorUtils.getFilePath(mockDocument)

			expect(result).toBe("/test/file.ts")
		})

		it("returns the absolute path when the file is outside the workspace folder", () => {
			// path.relative("/other", "/test/file.ts") は "../..." になり startsWith("..") で弾かれる。
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
				uri: { fsPath: "/other" },
				name: "other",
				index: 0,
			} as any)
			const doc = { uri: { fsPath: "/test/file.ts" } }

			expect(EditorUtils.getFilePath(doc as any)).toBe("/test/file.ts")
		})

		it("returns the absolute path when the document is the workspace root itself", () => {
			// path.relative が空文字を返す（!relativePath）ケース。
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
				uri: { fsPath: "/test/file.ts" },
				name: "root",
				index: 0,
			} as any)
			const doc = { uri: { fsPath: "/test/file.ts" } }

			expect(EditorUtils.getFilePath(doc as any)).toBe("/test/file.ts")
		})

		it("caches the computed path and reuses it on the second call", () => {
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)
			const doc = { uri: { fsPath: "/cached/file.ts" } }

			const first = EditorUtils.getFilePath(doc as any)
			const callsAfterFirst = vi.mocked(vscode.workspace.getWorkspaceFolder).mock.calls.length
			const second = EditorUtils.getFilePath(doc as any)

			expect(second).toBe(first)
			// キャッシュヒットなら getWorkspaceFolder は再度呼ばれない。
			expect(vi.mocked(vscode.workspace.getWorkspaceFolder).mock.calls.length).toBe(callsAfterFirst)
		})

		it("returns the fsPath and logs when resolving the workspace throws", () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation(() => {
				throw new Error("workspace boom")
			})
			const doc = { uri: { fsPath: "/z/file.ts" } }

			expect(EditorUtils.getFilePath(doc as any)).toBe("/z/file.ts")
			expect(spy).toHaveBeenCalled()
			spy.mockRestore()
		})
	})

	describe("createDiagnosticData", () => {
		it("copies only the relevant diagnostic fields", () => {
			const range = new vscode.Range(new vscode.Position(1, 2), new vscode.Position(3, 4))
			const diagnostic = {
				message: "unused variable",
				severity: vscode.DiagnosticSeverity.Warning,
				code: "no-unused-vars",
				source: "eslint",
				range,
				relatedInformation: ["ignored"],
			}

			expect(EditorUtils.createDiagnosticData(diagnostic as any)).toEqual({
				message: "unused variable",
				severity: vscode.DiagnosticSeverity.Warning,
				code: "no-unused-vars",
				source: "eslint",
				range,
			})
		})
	})

	describe("getEditorContext", () => {
		it("returns null when there is no active editor", () => {
			;(vscode.window as any).activeTextEditor = undefined

			expect(EditorUtils.getEditorContext()).toBeNull()
		})

		it("builds context from the given editor and keeps only intersecting diagnostics", () => {
			const selection = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 5))
			const document = {
				getText: vi.fn().mockReturnValue("hello"),
				lineAt: vi.fn(),
				lineCount: 3,
				uri: { fsPath: "/test/file.ts" },
			}
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
				uri: { fsPath: "/test" },
				name: "test",
				index: 0,
			} as any)
			const intersecting = new vscode.Range(new vscode.Position(0, 1), new vscode.Position(0, 3))
			const nonIntersecting = new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 1))
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
				{ message: "err", severity: 0, code: undefined, source: "x", range: intersecting },
				{ message: "far away", severity: 1, code: undefined, source: "y", range: nonIntersecting },
			] as any)

			const ctx = EditorUtils.getEditorContext({ document, selection } as any)

			expect(ctx).not.toBeNull()
			expect(ctx?.filePath).toBe("file.ts")
			expect(ctx?.selectedText).toBe("hello")
			// 1-based に変換される。
			expect(ctx?.startLine).toBe(1)
			expect(ctx?.endLine).toBe(1)
			expect(ctx?.diagnostics).toHaveLength(1)
			expect(ctx?.diagnostics?.[0].message).toBe("err")
		})

		it("falls back to the active editor and omits diagnostics when there are none", () => {
			const selection = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 3))
			const document = {
				getText: vi.fn().mockReturnValue("abc"),
				lineAt: vi.fn(),
				lineCount: 1,
				uri: { fsPath: "/test/a.ts" },
			}
			;(vscode.window as any).activeTextEditor = { document, selection }
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])

			const ctx = EditorUtils.getEditorContext()

			expect(ctx?.selectedText).toBe("abc")
			expect(ctx?.diagnostics).toBeUndefined()
		})

		it("returns null when no effective range can be derived", () => {
			const selection = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
			const document = {
				getText: vi.fn().mockReturnValue(""),
				lineAt: vi.fn().mockReturnValue({ text: "   ", lineNumber: 0 }),
				lineCount: 1,
				uri: { fsPath: "/test/b.ts" },
			}

			expect(EditorUtils.getEditorContext({ document, selection } as any)).toBeNull()
		})

		it("returns null and logs when accessing the editor throws", () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {})
			const editor = {
				get document(): any {
					throw new Error("boom")
				},
				selection: {},
			}

			expect(EditorUtils.getEditorContext(editor as any)).toBeNull()
			expect(spy).toHaveBeenCalled()
			spy.mockRestore()
		})
	})
})
