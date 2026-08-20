import * as vscode from "vscode"

import { diagnosticsToProblemsString, getNewDiagnostics } from "../index"

// Mock path module
vitest.mock("path", () => ({
	relative: vitest.fn((cwd, fullPath) => {
		let relativePath = ""
		// Handle the specific case already present
		if (cwd === "/project/root" && fullPath === "/project/root/src/utils/file.ts") {
			relativePath = "src/utils/file.ts"
		}
		// Handle the test cases with /path/to as cwd
		else if (cwd === "/path/to") {
			// Simple relative path calculation for the test cases
			relativePath = fullPath.replace(cwd + "/", "")
		}
		// Fallback for other cases (can be adjusted if needed)
		else {
			relativePath = fullPath
		}

		// Return a string-like object with toPosix method
		const result = Object.assign(relativePath, {
			toPosix: () => relativePath.replace(/\\/g, "/"),
		})
		return result
	}),
}))

// Mock vscode module
vitest.mock("vscode", () => ({
	Uri: {
		file: vitest.fn((path) => ({
			fsPath: path,
			toString: vitest.fn(() => path),
		})),
	},
	Diagnostic: vitest.fn().mockImplementation((range, message, severity) => ({
		range,
		message,
		severity,
		source: "test",
	})),
	Range: vitest.fn().mockImplementation((startLine, startChar, endLine, endChar) => ({
		start: { line: startLine, character: startChar },
		end: { line: endLine, character: endChar },
	})),
	DiagnosticSeverity: {
		Error: 0,
		Warning: 1,
		Information: 2,
		Hint: 3,
	},
	FileType: {
		Unknown: 0,
		File: 1,
		Directory: 2,
		SymbolicLink: 64,
	},
	workspace: {
		fs: {
			stat: vitest.fn(),
		},
		openTextDocument: vitest.fn(),
	},
}))

describe("diagnosticsToProblemsString", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("should filter diagnostics by severity and include correct labels", async () => {
		// Mock file URI
		const fileUri = vscode.Uri.file("/path/to/file.ts")

		// Create diagnostics with different severities
		const diagnostics = [
			new vscode.Diagnostic(new vscode.Range(0, 0, 0, 10), "Error message", vscode.DiagnosticSeverity.Error),
			new vscode.Diagnostic(new vscode.Range(1, 0, 1, 10), "Warning message", vscode.DiagnosticSeverity.Warning),
			new vscode.Diagnostic(new vscode.Range(2, 0, 2, 10), "Info message", vscode.DiagnosticSeverity.Information),
			new vscode.Diagnostic(new vscode.Range(3, 0, 3, 10), "Hint message", vscode.DiagnosticSeverity.Hint),
		]

		// Mock fs.stat to return file type
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content
		const mockDocument = {
			lineAt: vitest.fn((line) => ({
				text: `Line ${line + 1} content`,
			})),
		}
		vscode.workspace.openTextDocument = vitest.fn().mockResolvedValue(mockDocument)

		// Test with Error and Warning severities only
		const result = await diagnosticsToProblemsString(
			[[fileUri, diagnostics]],
			[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
			"/path/to",
		)

		// Verify only Error and Warning diagnostics are included
		expect(result).toContain("Error message")
		expect(result).toContain("Warning message")
		expect(result).not.toContain("Info message")
		expect(result).not.toContain("Hint message")

		// Verify correct severity labels are used
		expect(result).toContain("[test Error]")
		expect(result).toContain("[test Warning]")
		expect(result).not.toContain("[test Information]")
		expect(result).not.toContain("[test Hint]")

		// Verify line content is included
		expect(result).toContain("Line 1 content")
		expect(result).toContain("Line 2 content")
	})

	it("should handle directory URIs correctly without attempting to open as document", async () => {
		// Mock directory URI
		const dirUri = vscode.Uri.file("/path/to/directory/")

		// Mock diagnostic for directory
		const diagnostic = new vscode.Diagnostic(
			new vscode.Range(0, 0, 0, 10),
			"Directory diagnostic message",
			vscode.DiagnosticSeverity.Error,
		)

		// Mock fs.stat to return directory type
		const mockStat = {
			type: vscode.FileType.Directory,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock openTextDocument to ensure it's not called
		vscode.workspace.openTextDocument = vitest.fn()

		// Call the function
		const result = await diagnosticsToProblemsString(
			[[dirUri, [diagnostic]]],
			[vscode.DiagnosticSeverity.Error],
			"/path/to",
		)

		// Verify fs.stat was called with the directory URI
		expect(vscode.workspace.fs.stat).toHaveBeenCalledWith(dirUri)

		// Verify openTextDocument was not called
		expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()

		// Verify the output contains the expected directory indicator
		expect(result).toContain("(directory)")
		expect(result).toContain("Directory diagnostic message")
		expect(result).toMatch(/directory\/\n- \[test Error\] 1 \| \(directory\) : Directory diagnostic message/)
	})

	it("should correctly handle multiple diagnostics for the same file", async () => {
		// Mock file URI
		const fileUri = vscode.Uri.file("/path/to/file.ts")

		// Create multiple diagnostics for the same file
		const diagnostics = [
			new vscode.Diagnostic(new vscode.Range(4, 0, 4, 10), "Later line error", vscode.DiagnosticSeverity.Error),
			new vscode.Diagnostic(
				new vscode.Range(0, 0, 0, 10),
				"First line warning",
				vscode.DiagnosticSeverity.Warning,
			),
			new vscode.Diagnostic(
				new vscode.Range(2, 0, 2, 10),
				"Middle line info",
				vscode.DiagnosticSeverity.Information,
			),
		]

		// Mock fs.stat to return file type
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content with specific line texts for each test case
		const mockDocument = {
			lineAt: vitest.fn((line: number) => {
				const lineTexts: Record<number, string> = {
					0: "Line 0 content for warning",
					2: "Line 2 content for info",
					4: "Line 4 content for error",
				}
				return { text: lineTexts[line] }
			}),
		}
		vscode.workspace.openTextDocument = vitest.fn().mockResolvedValue(mockDocument)

		// Call the function with all severities
		const result = await diagnosticsToProblemsString(
			[[fileUri, diagnostics]],
			[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning, vscode.DiagnosticSeverity.Information],
			"/path/to",
		)

		// Verify all diagnostics are included in the output
		expect(result).toContain("First line warning")
		expect(result).toContain("Middle line info")
		expect(result).toContain("Later line error")

		// Verify line content is included for each diagnostic and matches the test case
		expect(result).toContain("Line 0 content for warning")
		expect(result).toContain("Line 2 content for info")
		expect(result).toContain("Line 4 content for error")

		// Verify the output contains all severity labels
		expect(result).toContain("[test Warning]")
		expect(result).toContain("[test Information]")
		expect(result).toContain("[test Error]")

		// Verify diagnostics appear in line number order (even though input wasn't sorted)
		// Verify exact output format
		expect(result).toBe(
			"file.ts\n" +
				"- [test Warning] 1 | Line 0 content for warning : First line warning\n" +
				"- [test Information] 3 | Line 2 content for info : Middle line info\n" +
				"- [test Error] 5 | Line 4 content for error : Later line error",
		)
	})

	it("should correctly handle diagnostics from multiple files", async () => {
		// Mock URIs for different files
		const fileUri1 = vscode.Uri.file("/path/to/file1.ts")
		const fileUri2 = vscode.Uri.file("/path/to/subdir/file2.ts")

		// Create diagnostics for each file
		const diagnostics1 = [
			new vscode.Diagnostic(new vscode.Range(0, 0, 0, 10), "File1 error", vscode.DiagnosticSeverity.Error),
		]

		const diagnostics2 = [
			new vscode.Diagnostic(new vscode.Range(1, 0, 1, 10), "File2 warning", vscode.DiagnosticSeverity.Warning),
			new vscode.Diagnostic(new vscode.Range(2, 0, 2, 10), "File2 info", vscode.DiagnosticSeverity.Information),
		]

		// Mock fs.stat to return file type for both files
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content with specific line texts for each test case
		const mockDocument1 = {
			lineAt: vitest.fn((_line) => ({
				text: "Line 1 content for error",
			})),
		}
		const mockDocument2 = {
			lineAt: vitest.fn((line) => {
				const lineTexts = ["Line 1 content", "Line 2 content for warning", "Line 3 content for info"]
				return { text: lineTexts[line] }
			}),
		}
		vscode.workspace.openTextDocument = vitest
			.fn()
			.mockResolvedValueOnce(mockDocument1)
			.mockResolvedValueOnce(mockDocument2)

		// Call the function with all severities
		const result = await diagnosticsToProblemsString(
			[
				[fileUri1, diagnostics1],
				[fileUri2, diagnostics2],
			],
			[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning, vscode.DiagnosticSeverity.Information],
			"/path/to",
		)

		// Verify file paths are correctly shown with relative paths
		expect(result).toContain("file1.ts")
		expect(result).toContain("subdir/file2.ts")

		// Verify diagnostics are grouped under their respective files
		const file1Section = result.split("file1.ts")[1]
		expect(file1Section).toContain("File1 error")
		expect(file1Section).toContain("Line 1 content for error")

		const file2Section = result.split("subdir/file2.ts")[1]
		expect(file2Section).toContain("File2 warning")
		expect(file2Section).toContain("Line 2 content for warning")
		expect(file2Section).toContain("File2 info")
		expect(file2Section).toContain("Line 3 content for info")

		// Verify exact output format
		expect(result).toBe(
			"file1.ts\n" +
				"- [test Error] 1 | Line 1 content for error : File1 error\n\n" +
				"subdir/file2.ts\n" +
				"- [test Warning] 2 | Line 2 content for warning : File2 warning\n" +
				"- [test Information] 3 | Line 3 content for info : File2 info",
		)
	})

	it("should return empty string when no diagnostics match the severity filter", async () => {
		// Mock file URI
		const fileUri = vscode.Uri.file("/path/to/file.ts")

		// Create diagnostics with Error and Warning severities
		const diagnostics = [
			new vscode.Diagnostic(new vscode.Range(0, 0, 0, 10), "Error message", vscode.DiagnosticSeverity.Error),
			new vscode.Diagnostic(new vscode.Range(1, 0, 1, 10), "Warning message", vscode.DiagnosticSeverity.Warning),
		]

		// Mock fs.stat to return file type
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content (though it shouldn't be accessed in this case)
		const mockDocument = {
			lineAt: vitest.fn((line) => ({
				text: `Line ${line + 1} content`,
			})),
		}
		vscode.workspace.openTextDocument = vitest.fn().mockResolvedValue(mockDocument)

		// Test with Information and Hint severities only (which don't match our diagnostics)
		const result = await diagnosticsToProblemsString(
			[[fileUri, diagnostics]],
			[vscode.DiagnosticSeverity.Information, vscode.DiagnosticSeverity.Hint],
			"/path/to",
		)

		// Verify empty string is returned
		expect(result).toBe("")

		// Verify no unnecessary calls were made
		expect(vscode.workspace.fs.stat).not.toHaveBeenCalled()
		expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
	})

	it("should correctly handle cwd parameter for relative file paths", async () => {
		// Mock file URI in a subdirectory
		const fileUri = vscode.Uri.file("/project/root/src/utils/file.ts")

		// Create a diagnostic for the file
		const diagnostic = new vscode.Diagnostic(
			new vscode.Range(4, 0, 4, 10),
			"Relative path test error",
			vscode.DiagnosticSeverity.Error,
		)

		// Mock fs.stat to return file type
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content matching test assertion
		const mockDocument = {
			lineAt: vitest.fn((line) => ({
				text: `Line ${line + 1} content for error`,
			})),
		}
		vscode.workspace.openTextDocument = vitest.fn().mockResolvedValue(mockDocument)

		// Call the function with cwd set to the project root
		const result = await diagnosticsToProblemsString(
			[[fileUri, [diagnostic]]],
			[vscode.DiagnosticSeverity.Error],
			"/project/root",
		)

		// Verify exact output format
		expect(result).toBe(
			"src/utils/file.ts\n" + "- [test Error] 5 | Line 5 content for error : Relative path test error",
		)

		// Verify fs.stat and openTextDocument were called
		expect(vscode.workspace.fs.stat).toHaveBeenCalledWith(fileUri)
		expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(fileUri)
	})
	it("should return empty string when includeDiagnostics is false", async () => {
		// Mock file URI
		const fileUri = vscode.Uri.file("/path/to/file.ts")

		// Create diagnostics
		const diagnostics = [
			new vscode.Diagnostic(new vscode.Range(0, 0, 0, 10), "Error message", vscode.DiagnosticSeverity.Error),
			new vscode.Diagnostic(new vscode.Range(1, 0, 1, 10), "Warning message", vscode.DiagnosticSeverity.Warning),
		]

		// Mock fs.stat to return file type
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content
		const mockDocument = {
			lineAt: vitest.fn((line) => ({
				text: `Line ${line + 1} content`,
			})),
		}
		vscode.workspace.openTextDocument = vitest.fn().mockResolvedValue(mockDocument)

		// Test with includeDiagnostics set to false
		const result = await diagnosticsToProblemsString(
			[[fileUri, diagnostics]],
			[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
			"/path/to",
			false, // includeDiagnostics
		)

		// Verify empty string is returned
		expect(result).toBe("")

		// Verify no file operations were performed
		expect(vscode.workspace.fs.stat).not.toHaveBeenCalled()
		expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
	})

	it("should limit diagnostics based on count when maxDiagnostics is specified", async () => {
		// Mock file URI
		const fileUri = vscode.Uri.file("/path/to/file.ts")

		// Create multiple diagnostics with varying message lengths
		const diagnostics = [
			new vscode.Diagnostic(new vscode.Range(0, 0, 0, 10), "Error 1", vscode.DiagnosticSeverity.Error),
			new vscode.Diagnostic(new vscode.Range(1, 0, 1, 10), "Warning 1", vscode.DiagnosticSeverity.Warning),
			new vscode.Diagnostic(new vscode.Range(2, 0, 2, 10), "Error 2", vscode.DiagnosticSeverity.Error),
			new vscode.Diagnostic(new vscode.Range(3, 0, 3, 10), "Warning 2", vscode.DiagnosticSeverity.Warning),
			new vscode.Diagnostic(new vscode.Range(4, 0, 4, 10), "Error 3", vscode.DiagnosticSeverity.Error),
		]

		// Mock fs.stat to return file type
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content
		const mockDocument = {
			lineAt: vitest.fn((line) => ({
				text: `Line ${line + 1} content`,
			})),
		}
		vscode.workspace.openTextDocument = vitest.fn().mockResolvedValue(mockDocument)

		// Test with maxDiagnostics set to 3 (should include exactly 3 diagnostics)
		const result = await diagnosticsToProblemsString(
			[[fileUri, diagnostics]],
			[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
			"/path/to",
			true, // includeDiagnostics
			3, // maxDiagnostics (count limit)
		)

		// Verify that exactly 3 diagnostics are included, prioritizing errors
		expect(result).toContain("Error 1")
		expect(result).toContain("Error 2")
		expect(result).toContain("Error 3")
		// Warnings should not be included since we have 3 errors and limit is 3
		expect(result).not.toContain("Warning 1")
		expect(result).not.toContain("Warning 2")

		// Verify the limit message is included
		expect(result).toContain("2 more problems omitted to prevent context overflow")
	})

	it("should prioritize errors over warnings when limiting diagnostics by count", async () => {
		// Mock file URIs
		const fileUri1 = vscode.Uri.file("/path/to/file1.ts")
		const fileUri2 = vscode.Uri.file("/path/to/file2.ts")

		// Create diagnostics with mixed severities
		const diagnostics1 = [
			new vscode.Diagnostic(new vscode.Range(0, 0, 0, 10), "Warning in file1", vscode.DiagnosticSeverity.Warning),
			new vscode.Diagnostic(new vscode.Range(1, 0, 1, 10), "Error in file1", vscode.DiagnosticSeverity.Error),
		]

		const diagnostics2 = [
			new vscode.Diagnostic(new vscode.Range(0, 0, 0, 10), "Error in file2", vscode.DiagnosticSeverity.Error),
			new vscode.Diagnostic(new vscode.Range(1, 0, 1, 10), "Warning in file2", vscode.DiagnosticSeverity.Warning),
			new vscode.Diagnostic(
				new vscode.Range(2, 0, 2, 10),
				"Info in file2",
				vscode.DiagnosticSeverity.Information,
			),
		]

		// Mock fs.stat to return file type
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content
		const mockDocument = {
			lineAt: vitest.fn((line) => ({
				text: `Line ${line + 1} content`,
			})),
		}
		vscode.workspace.openTextDocument = vitest.fn().mockResolvedValue(mockDocument)

		// Test with maxDiagnostics set to 2 (should include exactly 2 diagnostics)
		const result = await diagnosticsToProblemsString(
			[
				[fileUri1, diagnostics1],
				[fileUri2, diagnostics2],
			],
			[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning, vscode.DiagnosticSeverity.Information],
			"/path/to",
			true, // includeDiagnostics
			2, // maxDiagnostics (count limit)
		)

		// Verify exactly 2 errors are included (prioritized over warnings)
		expect(result).toContain("Error in file1")
		expect(result).toContain("Error in file2")
		// Warnings and info should not be included
		expect(result).not.toContain("Warning in file1")
		expect(result).not.toContain("Warning in file2")
		expect(result).not.toContain("Info in file2")

		// Verify the limit message is included
		expect(result).toContain("3 more problems omitted to prevent context overflow")
	})

	it("should handle maxDiagnostics with no limit when undefined", async () => {
		// Mock file URI
		const fileUri = vscode.Uri.file("/path/to/file.ts")

		// Create multiple diagnostics
		const diagnostics = [
			new vscode.Diagnostic(new vscode.Range(0, 0, 0, 10), "Error 1", vscode.DiagnosticSeverity.Error),
			new vscode.Diagnostic(new vscode.Range(1, 0, 1, 10), "Warning 1", vscode.DiagnosticSeverity.Warning),
			new vscode.Diagnostic(new vscode.Range(2, 0, 2, 10), "Error 2", vscode.DiagnosticSeverity.Error),
		]

		// Mock fs.stat to return file type
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content
		const mockDocument = {
			lineAt: vitest.fn((line) => ({
				text: `Line ${line + 1} content`,
			})),
		}
		vscode.workspace.openTextDocument = vitest.fn().mockResolvedValue(mockDocument)

		// Test with maxDiagnostics undefined
		const result = await diagnosticsToProblemsString(
			[[fileUri, diagnostics]],
			[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
			"/path/to",
			true, // includeDiagnostics
			undefined, // maxDiagnostics
		)

		// Verify all diagnostics are included
		expect(result).toContain("Error 1")
		expect(result).toContain("Warning 1")
		expect(result).toContain("Error 2")

		// Verify no limit message is included
		expect(result).not.toContain("(Showing")
	})

	it("should handle maxDiagnostics of 0 as no limit", async () => {
		// Mock file URI
		const fileUri = vscode.Uri.file("/path/to/file.ts")

		// Create multiple diagnostics
		const diagnostics = [
			new vscode.Diagnostic(new vscode.Range(0, 0, 0, 10), "Error 1", vscode.DiagnosticSeverity.Error),
			new vscode.Diagnostic(new vscode.Range(1, 0, 1, 10), "Warning 1", vscode.DiagnosticSeverity.Warning),
		]

		// Mock fs.stat to return file type
		const mockStat = {
			type: vscode.FileType.File,
		}
		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue(mockStat)

		// Mock document content
		const mockDocument = {
			lineAt: vitest.fn((line) => ({
				text: `Line ${line + 1} content`,
			})),
		}
		vscode.workspace.openTextDocument = vitest.fn().mockResolvedValue(mockDocument)

		// Test with maxDiagnostics set to 0
		const result = await diagnosticsToProblemsString(
			[[fileUri, diagnostics]],
			[vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning],
			"/path/to",
			true, // includeDiagnostics
			0, // maxDiagnostics (should be treated as no limit)
		)

		// Verify all diagnostics are included
		expect(result).toContain("Error 1")
		expect(result).toContain("Warning 1")

		// Verify no limit message is included
		expect(result).not.toContain("(Showing")
	})

	// ─── 想定外入力での整形（無制限パス）────────────────────────────────
	it("無制限パス: Hint・未知の重大度・source なし・stat 失敗でも落ちない", async () => {
		const fileUri = vscode.Uri.file("/path/to/weird.ts")
		// mock の Diagnostic は必ず source:"test" を付けるので、source 無しは直接組み立てる
		const diagnostics = [
			{
				range: new vscode.Range(0, 0, 0, 5),
				message: "hint msg",
				severity: vscode.DiagnosticSeverity.Hint,
				source: "test",
			},
			{ range: new vscode.Range(1, 0, 1, 5), message: "unknown msg", severity: 99, source: undefined },
		] as unknown as vscode.Diagnostic[]

		// stat が失敗 → (unavailable) 経路
		vscode.workspace.fs.stat = vitest.fn().mockRejectedValue(new Error("stat failed"))

		const result = await diagnosticsToProblemsString(
			[[fileUri, diagnostics]],
			[vscode.DiagnosticSeverity.Hint, 99 as vscode.DiagnosticSeverity],
			"/path/to",
		)

		expect(result).toContain("[test Hint]")
		// 未知の重大度は "Diagnostic"、source 無しなので接頭辞なし
		expect(result).toContain("[Diagnostic]")
		expect(result).not.toContain("[test Diagnostic]")
		// stat 失敗で行内容は取れず (unavailable)
		expect(result).toContain("(unavailable)")
	})

	// ─── 想定外入力での整形（count 制限パス）────────────────────────────
	it("制限パス: 全重大度ラベル・source なし・stat 失敗でも落ちない", async () => {
		const fileUri = vscode.Uri.file("/path/to/limited.ts")
		const diagnostics = [
			{
				range: new vscode.Range(0, 0, 0, 5),
				message: "e",
				severity: vscode.DiagnosticSeverity.Error,
				source: "test",
			},
			{
				range: new vscode.Range(1, 0, 1, 5),
				message: "w",
				severity: vscode.DiagnosticSeverity.Warning,
				source: "test",
			},
			{
				range: new vscode.Range(2, 0, 2, 5),
				message: "i",
				severity: vscode.DiagnosticSeverity.Information,
				source: "test",
			},
			{
				range: new vscode.Range(3, 0, 3, 5),
				message: "h",
				severity: vscode.DiagnosticSeverity.Hint,
				source: "test",
			},
			{ range: new vscode.Range(4, 0, 4, 5), message: "u", severity: 99, source: undefined },
		] as unknown as vscode.Diagnostic[]

		vscode.workspace.fs.stat = vitest.fn().mockRejectedValue(new Error("stat failed"))

		const result = await diagnosticsToProblemsString(
			[[fileUri, diagnostics]],
			[
				vscode.DiagnosticSeverity.Error,
				vscode.DiagnosticSeverity.Warning,
				vscode.DiagnosticSeverity.Information,
				vscode.DiagnosticSeverity.Hint,
				99 as vscode.DiagnosticSeverity,
			],
			"/path/to",
			true,
			10, // 全件収まる上限
		)

		expect(result).toContain("[test Error]")
		expect(result).toContain("[test Warning]")
		expect(result).toContain("[test Information]")
		expect(result).toContain("[test Hint]")
		expect(result).toContain("[Diagnostic]") // 未知の重大度・source なし
		expect(result).toContain("(unavailable)")
	})

	it("制限パス: ディレクトリ URI は (directory) と表示する", async () => {
		const dirUri = vscode.Uri.file("/path/to/dir/")
		const diagnostics = [
			{
				range: new vscode.Range(0, 0, 0, 5),
				message: "dir msg",
				severity: vscode.DiagnosticSeverity.Error,
				source: "test",
			},
		] as unknown as vscode.Diagnostic[]

		vscode.workspace.fs.stat = vitest.fn().mockResolvedValue({ type: vscode.FileType.Directory })
		vscode.workspace.openTextDocument = vitest.fn()

		const result = await diagnosticsToProblemsString(
			[[dirUri, diagnostics]],
			[vscode.DiagnosticSeverity.Error],
			"/path/to",
			true,
			5,
		)

		expect(result).toContain("(directory)")
		expect(result).toContain("dir msg")
		expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()
	})
})

describe("getNewDiagnostics", () => {
	it("旧に無い問題だけを差分として返す", () => {
		const uri = vscode.Uri.file("/path/to/file.ts")
		const oldDiag = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), "old", vscode.DiagnosticSeverity.Error)
		const newDiag = new vscode.Diagnostic(new vscode.Range(2, 0, 2, 5), "new", vscode.DiagnosticSeverity.Error)

		const result = getNewDiagnostics([[uri, [oldDiag]]], [[uri, [oldDiag, newDiag]]])

		expect(result).toHaveLength(1)
		expect(result[0][0]).toBe(uri)
		expect(result[0][1]).toEqual([newDiag])
	})

	it("旧に無いファイルの問題はすべて新規扱い（oldMap ミス）", () => {
		const uri = vscode.Uri.file("/path/to/fresh.ts")
		const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), "fresh", vscode.DiagnosticSeverity.Warning)

		// oldDiagnostics は空 → oldMap.get(uri) は undefined → [] にフォールバック
		const result = getNewDiagnostics([], [[uri, [d]]])

		expect(result).toEqual([[uri, [d]]])
	})

	it("新しい問題が無いファイルは結果に含めない", () => {
		const uri = vscode.Uri.file("/path/to/same.ts")
		const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), "same", vscode.DiagnosticSeverity.Error)

		// old と new が構造的に等しい → deepEqual で除外 → push されない
		const result = getNewDiagnostics([[uri, [d]]], [[uri, [d]]])

		expect(result).toEqual([])
	})
})
