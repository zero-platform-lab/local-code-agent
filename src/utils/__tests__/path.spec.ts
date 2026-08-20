// npx vitest utils/__tests__/path.spec.ts

import os from "os"
import * as path from "path"

import * as vscode from "vscode"

import { arePathsEqual, getReadablePath, getWorkspacePath, toRelativePath, getWorkspacePathForContext } from "../path"

// vscode は global mock（__mocks__/vscode.js）を使う。workspace/window の状態は
// テストごとに差し替え、下の describe で毎回既定へ戻す。

describe("Path Utilities", () => {
	const originalPlatform = process.platform
	// Helper to mock VS Code configuration

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
		})
	})

	describe("String.prototype.toPosix", () => {
		it("should convert backslashes to forward slashes", () => {
			const windowsPath = "C:\\Users\\test\\file.txt"
			expect(windowsPath.toPosix()).toBe("C:/Users/test/file.txt")
		})

		it("should not modify paths with forward slashes", () => {
			const unixPath = "/home/user/file.txt"
			expect(unixPath.toPosix()).toBe("/home/user/file.txt")
		})

		it("should preserve extended-length Windows paths", () => {
			const extendedPath = "\\\\?\\C:\\Very\\Long\\Path"
			expect(extendedPath.toPosix()).toBe("\\\\?\\C:\\Very\\Long\\Path")
		})
	})
	describe("getWorkspacePath", () => {
		it("should return the current workspace path", () => {
			const workspacePath = "/Users/test/project"
			expect(getWorkspacePath(workspacePath)).toBe("/Users/test/project")
		})

		it("should return undefined when outside a workspace", () => {})
	})
	describe("arePathsEqual", () => {
		describe("on Windows", () => {
			beforeEach(() => {
				Object.defineProperty(process, "platform", {
					value: "win32",
				})
			})

			it("should compare paths case-insensitively", () => {
				expect(arePathsEqual("C:\\Users\\Test", "c:\\users\\test")).toBe(true)
			})

			it("should handle different path separators", () => {
				// Convert both paths to use forward slashes after normalization
				const path1 = path.normalize("C:\\Users\\Test").replace(/\\/g, "/")
				const path2 = path.normalize("C:/Users/Test").replace(/\\/g, "/")
				expect(arePathsEqual(path1, path2)).toBe(true)
			})

			it("should normalize paths with ../", () => {
				// Convert both paths to use forward slashes after normalization
				const path1 = path.normalize("C:\\Users\\Test\\..\\Test").replace(/\\/g, "/")
				const path2 = path.normalize("C:\\Users\\Test").replace(/\\/g, "/")
				expect(arePathsEqual(path1, path2)).toBe(true)
			})
		})

		describe("on POSIX", () => {
			beforeEach(() => {
				Object.defineProperty(process, "platform", {
					value: "darwin",
				})
			})

			it("should compare paths case-sensitively", () => {
				expect(arePathsEqual("/Users/Test", "/Users/test")).toBe(false)
			})

			it("should normalize paths", () => {
				expect(arePathsEqual("/Users/./Test", "/Users/Test")).toBe(true)
			})

			it("should handle trailing slashes", () => {
				expect(arePathsEqual("/Users/Test/", "/Users/Test")).toBe(true)
			})
		})

		describe("edge cases", () => {
			it("should handle undefined paths", () => {
				expect(arePathsEqual(undefined, undefined)).toBe(true)
				expect(arePathsEqual("/test", undefined)).toBe(false)
				expect(arePathsEqual(undefined, "/test")).toBe(false)
			})

			it("should handle root paths with trailing slashes", () => {
				expect(arePathsEqual("/", "/")).toBe(true)
				expect(arePathsEqual("C:\\", "C:\\")).toBe(true)
			})
		})
	})

	describe("getReadablePath", () => {
		const homeDir = os.homedir()
		const desktop = path.join(homeDir, "Desktop")
		const cwd = process.platform === "win32" ? "C:\\Users\\test\\project" : "/Users/test/project"

		it("should return basename when path equals cwd", () => {
			expect(getReadablePath(cwd, cwd)).toBe("project")
		})

		it("should return relative path when inside cwd", () => {
			const filePath =
				process.platform === "win32"
					? "C:\\Users\\test\\project\\src\\file.txt"
					: "/Users/test/project/src/file.txt"
			expect(getReadablePath(cwd, filePath)).toBe("src/file.txt")
		})

		it("should return absolute path when outside cwd", () => {
			const filePath =
				process.platform === "win32" ? "C:\\Users\\test\\other\\file.txt" : "/Users/test/other/file.txt"
			expect(getReadablePath(cwd, filePath)).toBe(filePath.toPosix())
		})

		it("should handle Desktop as cwd", () => {
			const filePath = path.join(desktop, "file.txt")
			expect(getReadablePath(desktop, filePath)).toBe(filePath.toPosix())
		})

		it("should return empty string when relative path is undefined", () => {
			expect(getReadablePath(cwd)).toBe("")
		})

		it("should return cwd basename when relative path is empty string", () => {
			// Empty string resolves to cwd, which returns basename
			expect(getReadablePath(cwd, "")).toBe("project")
		})

		it("should handle parent directory traversal", () => {
			const filePath =
				process.platform === "win32" ? "C:\\Users\\test\\other\\file.txt" : "/Users/test/other/file.txt"
			expect(getReadablePath(cwd, filePath)).toBe(filePath.toPosix())
		})

		it("should normalize paths with redundant segments", () => {
			const filePath =
				process.platform === "win32"
					? "C:\\Users\\test\\project\\src\\file.txt"
					: "/Users/test/project/./src/../src/file.txt"
			expect(getReadablePath(cwd, filePath)).toBe("src/file.txt")
		})
	})
})

// ---------------------------------------------------------------------------

describe("toRelativePath", () => {
	const cwd = path.resolve(path.sep, "Users", "test", "project")

	it("cwd からの相対パスを posix 表記で返す", () => {
		const filePath = path.join(cwd, "src", "file.txt")
		expect(toRelativePath(filePath, cwd)).toBe("src/file.txt")
	})

	it("末尾スラッシュ（ディレクトリ）は相対パスにも残す", () => {
		// path.relative は末尾スラッシュを落とすので、明示的に復元されることを固定する。
		const dirPath = `${path.join(cwd, "src")}/`
		expect(toRelativePath(dirPath, cwd)).toBe("src/")
	})
})

// ---------------------------------------------------------------------------

// getWorkspacePath / getWorkspacePathForContext は global mock の workspace/window
// 状態に依存するため、テストごとに差し替えて既定へ戻す。
describe("getWorkspacePath (workspace/editor 依存)", () => {
	const savedFolders = (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders
	const savedEditor = (vscode.window as { activeTextEditor: unknown }).activeTextEditor
	const savedGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder

	function setState(opts: {
		folders?: Array<{ uri: { fsPath: string } }>
		activeFsPath?: string
		workspaceFolderFsPath?: string | null
	}) {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = opts.folders
		;(vscode.window as { activeTextEditor: unknown }).activeTextEditor = opts.activeFsPath
			? { document: { uri: { fsPath: opts.activeFsPath } } }
			: null
		;(vscode.workspace as { getWorkspaceFolder: unknown }).getWorkspaceFolder = () =>
			opts.workspaceFolderFsPath == null ? null : { uri: { fsPath: opts.workspaceFolderFsPath } }
	}

	afterEach(() => {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = savedFolders
		;(vscode.window as { activeTextEditor: unknown }).activeTextEditor = savedEditor
		;(vscode.workspace as { getWorkspaceFolder: unknown }).getWorkspaceFolder = savedGetWorkspaceFolder
	})

	it("アクティブエディタの workspace フォルダを優先して返す", () => {
		setState({
			folders: [{ uri: { fsPath: "/ws/root" } }],
			activeFsPath: "/ws/root/sub/file.ts",
			workspaceFolderFsPath: "/ws/root/sub",
		})
		expect(getWorkspacePath()).toBe("/ws/root/sub")
	})

	it("アクティブエディタはあるが workspace フォルダが見つからなければ cwd(folders 先頭) を返す", () => {
		setState({
			folders: [{ uri: { fsPath: "/ws/root" } }],
			activeFsPath: "/outside/file.ts",
			workspaceFolderFsPath: null,
		})
		expect(getWorkspacePath()).toBe("/ws/root")
	})

	it("アクティブエディタが無く folders も空なら defaultCwdPath を返す", () => {
		setState({ folders: [], workspaceFolderFsPath: null })
		expect(getWorkspacePath("/default/cwd")).toBe("/default/cwd")
	})
})

describe("getWorkspacePathForContext", () => {
	const savedFolders = (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders
	const savedEditor = (vscode.window as { activeTextEditor: unknown }).activeTextEditor
	const savedGetWorkspaceFolder = vscode.workspace.getWorkspaceFolder

	afterEach(() => {
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = savedFolders
		;(vscode.window as { activeTextEditor: unknown }).activeTextEditor = savedEditor
		;(vscode.workspace as { getWorkspaceFolder: unknown }).getWorkspaceFolder = savedGetWorkspaceFolder
	})

	it("contextPath の属する workspace フォルダを返す", () => {
		;(vscode.workspace as { getWorkspaceFolder: unknown }).getWorkspaceFolder = () => ({
			uri: { fsPath: "/ctx/ws" },
		})
		expect(getWorkspacePathForContext("/ctx/ws/file.ts")).toBe("/ctx/ws")
	})

	it("contextPath に workspace が無ければ debug ログを出して getWorkspacePath へフォールバックする", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
		;(vscode.workspace as { getWorkspaceFolder: unknown }).getWorkspaceFolder = () => null
		;(vscode.window as { activeTextEditor: unknown }).activeTextEditor = null
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: "/fallback/ws" } }]

		expect(getWorkspacePathForContext("/nowhere/file.ts")).toBe("/fallback/ws")
		expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("No workspace found for context path"))
		debugSpy.mockRestore()
	})

	it("contextPath 未指定なら getWorkspacePath に委譲する", () => {
		;(vscode.window as { activeTextEditor: unknown }).activeTextEditor = null
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = []
		expect(getWorkspacePathForContext()).toBe("")
	})
})
