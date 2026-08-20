import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { openFile } from "../open-file"
import { getWorkspacePath } from "../../../utils/path"

// os.homedir を制御可能にする（builtin は spyOn で再定義できないためモジュールごと差し替え）。
vi.mock("os", () => {
	const homedir = vi.fn(() => "/home/test")
	return { homedir, default: { homedir } }
})

// Mock vscode module
vi.mock("vscode", () => ({
	Uri: {
		file: vi.fn((path: string) => ({ fsPath: path })),
	},
	workspace: {
		fs: {
			stat: vi.fn(),
			writeFile: vi.fn(),
		},
		openTextDocument: vi.fn(),
	},
	window: {
		showTextDocument: vi.fn(),
		showErrorMessage: vi.fn(),
		tabGroups: {
			all: [],
		},
		activeTextEditor: undefined,
	},
	commands: {
		executeCommand: vi.fn(),
	},
	FileType: {
		Directory: 2,
		File: 1,
	},
	Selection: vi.fn((startLine: number, startChar: number, endLine: number, endChar: number) => ({
		start: { line: startLine, character: startChar },
		end: { line: endLine, character: endChar },
	})),
	TabInputText: vi.fn(),
}))

// Mock utils
// 注意: open-file.ts の import は src/utils/path（このファイルからは 3 階層上）。
// 旧コードは "../../utils/path" を指しており解決先がずれてモックが効いていなかった。
vi.mock("../../../utils/path", () => {
	// vi.mock ファクトリは Vitest によって巻き上げられるため、
	// トップレベル import は使えない（TDZ）。動的 require で回避する。
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const nodePath = require("path")
	return {
		arePathsEqual: vi.fn((a: string, b: string) => a === b),
		getWorkspacePath: vi.fn(() => {
			// In tests, we need to return a consistent workspace path
			// The actual workspace is /Users/agent/rc2 in local, but varies in CI
			const cwd = process.cwd()
			// If we're in the src directory, go up one level to get workspace root
			if (cwd.endsWith("/src")) {
				return nodePath.dirname(cwd)
			}
			return cwd
		}),
	}
})

// Mock i18n
vi.mock("../../i18n", () => ({
	t: vi.fn((key: string, _params?: any) => {
		// Return the key without namespace prefix to match actual behavior
		if (key.startsWith("common:")) {
			return key.replace("common:", "")
		}
		return key
	}),
}))

describe("openFile", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("decodeURIComponent error handling", () => {
		it("should handle invalid URI encoding gracefully", async () => {
			const invalidPath = "test%ZZinvalid.txt" // Invalid percent encoding
			const mockDocument = { uri: { fsPath: invalidPath } }

			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile(invalidPath)

			// Should log a warning about decode failure
			expect(console.warn).toHaveBeenCalledWith(
				"Failed to decode file path: URIError: URI malformed. Using original path.",
			)

			// Should still attempt to open the file with the original path
			expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("should successfully decode valid URI-encoded paths", async () => {
			const encodedPath = "./%5Btest%5D/file.txt" // [test] encoded
			const decodedPath = "./[test]/file.txt"
			const mockDocument = { uri: { fsPath: decodedPath } }

			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile(encodedPath)

			// Should not log any warnings
			expect(console.warn).not.toHaveBeenCalled()

			// Should use the decoded path - verify it contains the decoded brackets
			// On Windows, the path will include backslashes instead of forward slashes
			const expectedPathSegment = process.platform === "win32" ? "[test]\\file.txt" : "[test]/file.txt"
			expect(vscode.Uri.file).toHaveBeenCalledWith(expect.stringContaining(expectedPathSegment))
			expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("should handle paths with special characters that need encoding", async () => {
			const pathWithSpecialChars = "./[brackets]/file with spaces.txt"
			const mockDocument = { uri: { fsPath: pathWithSpecialChars } }

			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile(pathWithSpecialChars)

			// Should work without errors
			expect(console.warn).not.toHaveBeenCalled()
			expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("should handle already decoded paths without double-decoding", async () => {
			const normalPath = "./normal/file.txt"
			const mockDocument = { uri: { fsPath: normalPath } }

			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile(normalPath)

			// Should work without errors
			expect(console.warn).not.toHaveBeenCalled()
			expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})
	})

	describe("error handling", () => {
		it("should show error message when file does not exist", async () => {
			const nonExistentPath = "./does/not/exist.txt"

			vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error("File not found"))

			await openFile(nonExistentPath)

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.could_not_open_file")
		})

		it("should handle generic errors", async () => {
			const testPath = "./test.txt"

			vi.mocked(vscode.workspace.fs.stat).mockRejectedValue("Not an Error object")

			await openFile(testPath)

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.could_not_open_file")
		})

		it("Error でない例外は汎用メッセージを出す", async () => {
			// 既存ファイルは開けるが openTextDocument が Error でない値で reject するケース。
			// 外側 catch に Error 以外が届き、_generic 側の分岐へ入る。
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue("not an error object")

			await openFile("/abs/generic.txt")

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.could_not_open_file_generic")
		})
	})

	describe("directory handling", () => {
		it("should reveal directories in explorer", async () => {
			const dirPath = "./components"

			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.Directory,
				ctime: 0,
				mtime: 0,
				size: 0,
			})

			await openFile(dirPath)

			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
				"revealInExplorer",
				expect.objectContaining({ fsPath: expect.stringContaining("components") }),
			)
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("list.expand")
			expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
		})

		it("list.expand が失敗しても警告を出して握り潰す", async () => {
			const dirPath = "./components"

			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.Directory,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.commands.executeCommand).mockImplementation((cmd: string) =>
				cmd === "list.expand" ? Promise.reject(new Error("no expand")) : (Promise.resolve() as any),
			)

			await openFile(dirPath)

			expect(console.warn).toHaveBeenCalledWith("Could not expand directory in explorer:", expect.any(Error))
			// 展開失敗はディレクトリ処理を止めない（ファイルとして開きにいかない）
			expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
		})
	})

	describe("既存ファイルを開く", () => {
		it("絶対パス（./ でない）はそのまま stat して開く", async () => {
			const abs = "/abs/existing.txt"
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile(abs)

			expect(vscode.Uri.file).toHaveBeenCalledWith(abs)
			expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})

		it("line 指定で 0 基点の選択範囲を作る", async () => {
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile("/abs/withline.txt", { line: 5 })

			// options.line=5 → Math.max(5-1,0)=4 の行に選択を置く
			expect(vscode.Selection).toHaveBeenCalledWith(4, 0, 4, 0)
			const opts = vi.mocked(vscode.window.showTextDocument).mock.calls[0][1] as any
			expect(opts.preview).toBe(false)
			expect(opts.selection).toBeDefined()
		})
	})

	describe("tab グループの取り回し", () => {
		const originalTabGroups = (vscode.window as any).tabGroups
		const originalActiveEditor = (vscode.window as any).activeTextEditor

		afterEach(() => {
			;(vscode.window as any).tabGroups = originalTabGroups
			;(vscode.window as any).activeTextEditor = originalActiveEditor
		})

		it("別カラムで開かれた未変更タブは閉じてから開き直す", async () => {
			const abs = "/abs/reopen.txt"
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			const closeSpy = vi.fn()
			const existingTab = {
				input: Object.assign(Object.create((vscode as any).TabInputText.prototype), {
					uri: { fsPath: abs },
				}),
				isDirty: false,
			}
			const group = { tabs: [existingTab], viewColumn: 2 }
			;(vscode.window as any).tabGroups = { all: [group], close: closeSpy }
			;(vscode.window as any).activeTextEditor = { viewColumn: 1 }

			await openFile(abs)

			expect(closeSpy).toHaveBeenCalledWith(existingTab)
			expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
		})

		it("tab 走査が例外を投げても握り潰してファイルを開く", async () => {
			const abs = "/abs/throwtab.txt"
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)
			;(vscode.window as any).tabGroups = {
				get all() {
					throw new Error("tab groups unavailable")
				},
			}

			await openFile(abs)

			// tab 操作の失敗は致命的でない → 最終的にファイルは開かれる
			expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
			expect(vscode.window.showTextDocument).toHaveBeenCalled()
		})
	})

	describe("file creation", () => {
		it("should create new files when create option is true", async () => {
			const newFilePath = "./new/file.txt"
			const content = "Hello, world!"

			vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error("File not found"))
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile(newFilePath, { create: true, content })

			// On Windows, the path will include backslashes instead of forward slashes
			const expectedPathSegment = process.platform === "win32" ? "new\\file.txt" : "new/file.txt"
			expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: expect.stringContaining(expectedPathSegment) }),
				Buffer.from(content, "utf8"),
			)
			expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
		})

		it("絶対パスの作成先はそのまま使い、content 省略時は空で書き込む", async () => {
			const abs = "/abs/created.txt"

			vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error("File not found"))
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile(abs, { create: true })

			expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: abs }),
				Buffer.from("", "utf8"),
			)
		})

		it("workspace が無いとき ./ 相対はホーム基準で作成する", async () => {
			// getWorkspacePath を空にして workspaceRoot 分岐の else（homeDir 側）を通す。
			vi.mocked(getWorkspacePath).mockReturnValueOnce("")

			vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error("File not found"))
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile("./home-rel.txt", { create: true, content: "x" })

			const expectedSegment = process.platform === "win32" ? "\\home-rel.txt" : "/home-rel.txt"
			expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: expect.stringContaining(expectedSegment) }),
				Buffer.from("x", "utf8"),
			)
		})
	})

	describe("workspace/home の解決分岐", () => {
		const fileStat = { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 }

		it("workspace 解決先が有効なら ./ を workspace 基準で試す", async () => {
			vi.mocked(getWorkspacePath).mockReturnValueOnce("/ws")
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue(fileStat)
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile("./a.txt")

			expect(vscode.Uri.file).toHaveBeenCalledWith(path.join("/ws", "a.txt"))
		})

		it("workspace もホームも無ければ ./ 相対をそのまま試す", async () => {
			vi.mocked(getWorkspacePath).mockReturnValueOnce("")
			vi.mocked(os.homedir).mockReturnValueOnce("")
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue(fileStat)
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile("./b.txt")

			// attemptPaths が空になり、最後の砦として元の相対パスがそのまま使われる
			expect(vscode.Uri.file).toHaveBeenCalledWith("./b.txt")
		})

		it("作成: workspace が有効なら ./ を workspace 基準に作る", async () => {
			vi.mocked(getWorkspacePath).mockReturnValueOnce("/ws")
			vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error("File not found"))
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile("./c.txt", { create: true, content: "z" })

			expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: path.join("/ws", "c.txt") }),
				Buffer.from("z", "utf8"),
			)
		})

		it("作成: workspace もホームも無ければ元の相対パスに作る", async () => {
			vi.mocked(getWorkspacePath).mockReturnValueOnce("")
			vi.mocked(os.homedir).mockReturnValueOnce("")
			vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error("File not found"))
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile("./d.txt", { create: true })

			expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: "./d.txt" }),
				Buffer.from("", "utf8"),
			)
		})
	})

	describe("パス解決", () => {
		it("./ 相対パスは workspace 基準に解決して開く", async () => {
			// 既存の decode 系テストと別に、./ → workspaceRoot join の attemptPaths 構築を明示的に踏む。
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			})
			vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as any)
			vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as any)

			await openFile("./relative/file.txt")

			const expectedSegment = process.platform === "win32" ? "relative\\file.txt" : "relative/file.txt"
			expect(vscode.Uri.file).toHaveBeenCalledWith(expect.stringContaining(expectedSegment))
			expect(vscode.workspace.openTextDocument).toHaveBeenCalled()
		})
	})
})
