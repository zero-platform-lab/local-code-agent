import * as path from "path"
import fs from "fs/promises"

import type { MockedFunction } from "vitest"

import { DEFAULT_WRITE_DELAY_MS } from "@openai-agent/types"

import { fileExistsAtPath } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { getReadablePath } from "../../../utils/path"
import { formatResponse } from "../../prompts/responses"
import { computeDiffStats } from "../../diff/stats"
import { ToolUse, ToolResponse } from "../../../shared/tools"
import {
	editFileTool,
	countOccurrences,
	safeLiteralReplace,
	buildWhitespaceTolerantRegex,
	buildTokenRegex,
} from "../EditFileTool"
import { makeMockTask } from "../../task/__tests__/makeMockTask"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue(""),
	},
}))

vi.mock("path", async () => {
	const originalPath = await vi.importActual("path")
	return {
		...originalPath,
		resolve: vi.fn().mockImplementation((...args) => {
			const separator = process.platform === "win32" ? "\\" : "/"
			return args.join(separator)
		}),
		isAbsolute: vi.fn().mockReturnValue(false),
		relative: vi.fn().mockImplementation((from, to) => to),
	}
})

vi.mock("delay", () => ({
	default: vi.fn(),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg) => `Error: ${msg}`),
		agentIgnoreError: vi.fn((path) => `Access denied: ${path}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn().mockReturnValue("test/path.txt"),
}))

vi.mock("../../diff/stats", () => ({
	sanitizeUnifiedDiff: vi.fn((diff) => diff),
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
}))

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn().mockResolvedValue(undefined),
	},
	env: {
		openExternal: vi.fn(),
	},
	Uri: {
		parse: vi.fn(),
	},
}))

describe("editFileTool", () => {
	// Test data
	const testFilePath = "test/file.txt"
	const absoluteFilePath = process.platform === "win32" ? "C:\\test\\file.txt" : "/test/file.txt"
	const testFileContent = "Line 1\nLine 2\nLine 3\nLine 4"
	const testOldString = "Line 2"
	const testNewString = "Modified Line 2"

	// Mocked functions
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockedFsReadFile = fs.readFile as unknown as MockedFunction<
		(path: string, encoding: string) => Promise<string>
	>
	const mockedIsPathOutsideWorkspace = isPathOutsideWorkspace as MockedFunction<typeof isPathOutsideWorkspace>
	const mockedGetReadablePath = getReadablePath as MockedFunction<typeof getReadablePath>
	const mockedPathResolve = path.resolve as MockedFunction<typeof path.resolve>
	const mockedPathIsAbsolute = path.isAbsolute as MockedFunction<typeof path.isAbsolute>
	const mockedCreatePrettyPatch = formatResponse.createPrettyPatch as MockedFunction<
		typeof formatResponse.createPrettyPatch
	>
	const mockedComputeDiffStats = computeDiffStats as MockedFunction<typeof computeDiffStats>

	let mockTask: any
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let mockPushToolResult: ReturnType<typeof vi.fn>
	let toolResult: ToolResponse | undefined

	beforeEach(() => {
		vi.clearAllMocks()

		mockedPathResolve.mockReturnValue(absoluteFilePath)
		mockedPathIsAbsolute.mockReturnValue(false)
		mockedFileExistsAtPath.mockResolvedValue(true)
		mockedFsReadFile.mockResolvedValue(testFileContent)
		mockedIsPathOutsideWorkspace.mockReturnValue(false)
		mockedGetReadablePath.mockReturnValue("test/path.txt")

		mockTask = makeMockTask({
			cwd: "/",
			providerState: {
				diagnosticsEnabled: true,
				writeDelayMs: 1000,
				experiments: {},
			},
		}) as any
		mockTask.ask = vi.fn().mockResolvedValue(undefined)
		mockTask.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing param error")
		mockTask.diffViewProvider = {
			editType: undefined,
			isEditing: false,
			originalContent: "",
			open: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			reset: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(undefined),
			saveChanges: vi.fn().mockResolvedValue({
				newProblemsMessage: "",
				userEdits: null,
				finalContent: "final content",
			}),
			saveDirectly: vi.fn().mockResolvedValue(undefined),
			scrollToFirstDiff: vi.fn(),
			pushToolWriteResult: vi.fn().mockResolvedValue("Tool result message"),
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)

		toolResult = undefined
	})

	/**
	 * Helper function to execute the edit_file tool with different parameters
	 */
	async function executeEditFileTool(
		params: Partial<ToolUse["params"]> = {},
		options: {
			fileExists?: boolean
			fileContent?: string
			isPartial?: boolean
			accessAllowed?: boolean
		} = {},
	): Promise<ToolResponse | undefined> {
		const fileExists = options.fileExists ?? true
		const fileContent = options.fileContent ?? testFileContent
		const isPartial = options.isPartial ?? false
		const accessAllowed = options.accessAllowed ?? true

		mockedFileExistsAtPath.mockResolvedValue(fileExists)
		mockedFsReadFile.mockResolvedValue(fileContent)
		mockTask.rooIgnoreController.validateAccess.mockReturnValue(accessAllowed)

		const nativeArgs: Record<string, unknown> = {
			file_path: testFilePath,
			old_string: testOldString,
			new_string: testNewString,
		}
		for (const [key, value] of Object.entries(params)) {
			nativeArgs[key] = value
		}
		// Keep expected_replacements numeric in native args when provided.
		if (typeof nativeArgs.expected_replacements === "string") {
			nativeArgs.expected_replacements = Number(nativeArgs.expected_replacements)
		}

		const toolUse: ToolUse = {
			type: "tool_use",
			name: "edit_file",
			params: {
				file_path: testFilePath,
				old_string: testOldString,
				new_string: testNewString,
				...params,
			},
			nativeArgs: nativeArgs as any,
			partial: isPartial,
		}

		mockPushToolResult = vi.fn((result: ToolResponse) => {
			toolResult = result
		})

		await editFileTool.handle(mockTask, toolUse as ToolUse<"edit_file">, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		return toolResult
	}

	describe("parameter validation", () => {
		it("returns error when file_path is missing", async () => {
			const result = await executeEditFileTool({ file_path: undefined })

			expect(result).toBe("Missing param error")
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("edit_file")
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})

		it("treats undefined new_string as empty string (deletion)", async () => {
			await executeEditFileTool(
				{ old_string: "Line 2", new_string: undefined },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("allows empty new_string for deletion", async () => {
			await executeEditFileTool(
				{ old_string: "Line 2", new_string: "" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("returns error when old_string equals new_string", async () => {
			const result = await executeEditFileTool({
				old_string: "same",
				new_string: "same",
			})

			expect(result).toContain("No changes to apply")
			expect(result).toContain("<error_details>")
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})

		describe("native tool mode coercion", () => {
			/**
			 * Helper to execute edit_file with native tool args (simulating native protocol)
			 */
			async function executeWithNativeArgs(
				nativeArgs: Record<string, unknown>,
				options: { fileExists?: boolean; fileContent?: string } = {},
			): Promise<ToolResponse | undefined> {
				const fileExists = options.fileExists ?? true
				const fileContent = options.fileContent ?? testFileContent

				mockedFileExistsAtPath.mockResolvedValue(fileExists)
				mockedFsReadFile.mockResolvedValue(fileContent)
				mockTask.rooIgnoreController.validateAccess.mockReturnValue(true)

				const toolUse: ToolUse = {
					type: "tool_use",
					name: "edit_file",
					params: {},
					partial: false,
					nativeArgs: nativeArgs as any,
				}

				let capturedResult: ToolResponse | undefined
				const localPushToolResult = vi.fn((result: ToolResponse) => {
					capturedResult = result
				})

				await editFileTool.handle(mockTask, toolUse as ToolUse<"edit_file">, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: localPushToolResult,
				})

				return capturedResult
			}

			it("coerces undefined old_string to empty string in native mode (file creation)", async () => {
				await executeWithNativeArgs(
					{ file_path: testFilePath, old_string: undefined, new_string: "New content" },
					{ fileExists: false },
				)

				expect(mockTask.mistakeTracker!.count).toBe(0)
				expect(mockTask.diffViewProvider.editType).toBe("create")
				expect(mockAskApproval).toHaveBeenCalled()
			})

			it("coerces undefined new_string to empty string in native mode (deletion)", async () => {
				await executeWithNativeArgs(
					{ file_path: testFilePath, old_string: "Line 2", new_string: undefined },
					{ fileContent: "Line 1\nLine 2\nLine 3" },
				)

				expect(mockTask.mistakeTracker!.count).toBe(0)
				expect(mockAskApproval).toHaveBeenCalled()
			})

			it("handles both old_string and new_string as undefined in native mode", async () => {
				await executeWithNativeArgs(
					{ file_path: testFilePath, old_string: undefined, new_string: undefined },
					{ fileExists: false },
				)

				// Both undefined means: old_string = "" (create file), new_string = "" (empty file)
				expect(mockTask.mistakeTracker!.count).toBe(0)
				expect(mockTask.diffViewProvider.editType).toBe("create")
				expect(mockAskApproval).toHaveBeenCalled()
			})

			it("handles null values as strings in native mode", async () => {
				await executeWithNativeArgs(
					{ file_path: testFilePath, old_string: null, new_string: "New content" },
					{ fileExists: false },
				)

				// null is coerced to "" via ?? operator
				expect(mockTask.mistakeTracker!.count).toBe(0)
				expect(mockTask.diffViewProvider.editType).toBe("create")
				expect(mockAskApproval).toHaveBeenCalled()
			})
		})
	})

	describe("file access", () => {
		it("returns error when file does not exist and old_string is not empty", async () => {
			const result = await executeEditFileTool({}, { fileExists: false })

			expect(result).toContain("File does not exist")
			expect(result).toContain("<error_details>")
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})

		it("returns error when access is denied", async () => {
			const result = await executeEditFileTool({}, { accessAllowed: false })

			expect(result).toContain("Access denied")
		})
	})

	describe("edit_file logic", () => {
		it("returns error when no match is found", async () => {
			const result = await executeEditFileTool(
				{ old_string: "NonExistent" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("No match found")
			expect(result).toContain("<error_details>")
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith(
				"edit_file",
				expect.stringContaining("No match found"),
			)
		})

		it("emits diff_error on the 2nd consecutive failure for the same file", async () => {
			await executeEditFileTool({ old_string: "NonExistent" }, { fileContent: "Line 1\nLine 2\nLine 3" })
			await executeEditFileTool({ old_string: "NonExistent" }, { fileContent: "Line 1\nLine 2\nLine 3" })

			expect(mockTask.say).toHaveBeenCalledWith("diff_error", expect.stringContaining("No match found"))
		})

		it("returns error when occurrence count does not match expected_replacements", async () => {
			const result = await executeEditFileTool(
				{ old_string: "Line", expected_replacements: "1" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("Expected 1 occurrence(s) but found 3")
			expect(result).toContain("<error_details>")
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith(
				"edit_file",
				expect.stringContaining("Occurrence count mismatch"),
			)
		})

		it("succeeds when occurrence count matches expected_replacements", async () => {
			await executeEditFileTool(
				{ old_string: "Line", new_string: "Row", expected_replacements: "4" },
				{ fileContent: "Line 1\nLine 2\nLine 3\nLine 4" },
			)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.diffViewProvider.editType).toBe("modify")
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("successfully replaces single unique match", async () => {
			await executeEditFileTool(
				{
					old_string: "Line 2",
					new_string: "Modified Line 2",
				},
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.diffViewProvider.editType).toBe("modify")
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("defaults expected_replacements to 1", async () => {
			const result = await executeEditFileTool(
				{ old_string: "Line" },
				{ fileContent: "Line 1\nLine 2\nLine 3\nLine 4" },
			)

			expect(result).toContain("Expected 1 occurrence(s) but found 4")
			expect(result).toContain("<error_details>")
		})
	})

	describe("consecutive error display behavior", () => {
		it("does NOT show diff_error to user on first no_match failure", async () => {
			await executeEditFileTool({ old_string: "NonExistent" }, { fileContent: "Line 1\nLine 2\nLine 3" })

			expect(mockTask.mistakeTracker.editFileMisses.get(testFilePath)).toBe(1)
			expect(mockTask.say).not.toHaveBeenCalledWith("diff_error", expect.any(String))
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith(
				"edit_file",
				expect.stringContaining("No match found"),
			)
		})

		it("shows diff_error to user on second consecutive no_match failure", async () => {
			// First failure
			await executeEditFileTool({ old_string: "NonExistent" }, { fileContent: "Line 1\nLine 2\nLine 3" })

			// Second failure on same file
			await executeEditFileTool({ old_string: "AlsoNonExistent" }, { fileContent: "Line 1\nLine 2\nLine 3" })

			expect(mockTask.mistakeTracker.editFileMisses.get(testFilePath)).toBe(2)
			expect(mockTask.say).toHaveBeenCalledWith("diff_error", expect.stringContaining("No match found"))
		})

		it("does NOT show diff_error to user on first occurrence_mismatch failure", async () => {
			await executeEditFileTool(
				{ old_string: "Line", expected_replacements: "1" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockTask.mistakeTracker.editFileMisses.get(testFilePath)).toBe(1)
			expect(mockTask.say).not.toHaveBeenCalledWith("diff_error", expect.any(String))
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith(
				"edit_file",
				expect.stringContaining("Occurrence count mismatch"),
			)
		})

		it("shows diff_error to user on second consecutive occurrence_mismatch failure", async () => {
			// First failure
			await executeEditFileTool(
				{ old_string: "Line", expected_replacements: "1" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			// Second failure on same file
			await executeEditFileTool(
				{ old_string: "Line", expected_replacements: "5" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockTask.mistakeTracker.editFileMisses.get(testFilePath)).toBe(2)
			expect(mockTask.say).toHaveBeenCalledWith(
				"diff_error",
				expect.stringContaining("Occurrence count mismatch"),
			)
		})

		it("resets consecutive error counter on successful edit", async () => {
			// First failure
			await executeEditFileTool({ old_string: "NonExistent" }, { fileContent: "Line 1\nLine 2\nLine 3" })

			expect(mockTask.mistakeTracker.editFileMisses.get(testFilePath)).toBe(1)

			// Successful edit
			await executeEditFileTool(
				{ old_string: "Line 2", new_string: "Modified Line 2" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			// Counter should be deleted (reset) for the file
			expect(mockTask.mistakeTracker.editFileMisses.has(testFilePath)).toBe(false)
		})

		it("tracks errors independently per file", async () => {
			const otherFilePath = "other/file.txt"

			// First failure on original file
			await executeEditFileTool({ old_string: "NonExistent" }, { fileContent: "Line 1\nLine 2\nLine 3" })

			// First failure on other file
			await executeEditFileTool(
				{ file_path: otherFilePath, old_string: "NonExistent" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			// Both files should have count of 1, not 2
			expect(mockTask.mistakeTracker.editFileMisses.get(testFilePath)).toBe(1)
			expect(mockTask.mistakeTracker.editFileMisses.get(otherFilePath)).toBe(1)

			// Neither should have triggered diff_error display
			expect(mockTask.say).not.toHaveBeenCalledWith("diff_error", expect.any(String))
		})
	})

	describe("file creation", () => {
		it("creates new file when old_string is empty and file does not exist", async () => {
			await executeEditFileTool({ old_string: "", new_string: "New file content" }, { fileExists: false })

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockTask.diffViewProvider.editType).toBe("create")
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("returns error when trying to create file that already exists", async () => {
			const result = await executeEditFileTool(
				{ old_string: "", new_string: "Content" },
				{ fileExists: true, fileContent: "Existing content" },
			)

			expect(result).toContain("File already exists")
			expect(result).toContain("<error_details>")
			expect(result).toContain("already exists")
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})
	})

	describe("approval workflow", () => {
		it("saves changes when user approves", async () => {
			mockAskApproval.mockResolvedValue(true)

			await executeEditFileTool()

			expect(mockTask.diffViewProvider.saveChanges).toHaveBeenCalled()
			expect(mockTask.didEditFile).toBe(true)
			expect(mockTask.tokenUsageTracker!.recordToolUsage).toHaveBeenCalledWith("edit_file")
		})

		it("reverts changes when user rejects", async () => {
			mockAskApproval.mockResolvedValue(false)

			const result = await executeEditFileTool()

			expect(mockTask.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(result).toContain("rejected")
		})
	})

	describe("partial block handling", () => {
		it("handles partial block without errors after path stabilizes", async () => {
			// Path stabilization requires two consecutive calls with the same path
			// First call sets lastSeenPartialPath, second call sees it has stabilized
			await executeEditFileTool({}, { isPartial: true })
			await executeEditFileTool({}, { isPartial: true })

			expect(mockTask.ask).toHaveBeenCalled()
		})

		it("shows creating new file preview when old_string is empty", async () => {
			// Path stabilization requires two consecutive calls with the same path
			await executeEditFileTool({ old_string: "" }, { isPartial: true })
			await executeEditFileTool({ old_string: "" }, { isPartial: true })

			expect(mockTask.ask).toHaveBeenCalled()
		})

		it("finalizes a partial tool preview row on failure (no stuck spinner)", async () => {
			// Path stabilization requires two consecutive calls with the same path
			await executeEditFileTool({ old_string: "NonExistent" }, { isPartial: true })
			await executeEditFileTool({ old_string: "NonExistent" }, { isPartial: true })

			await executeEditFileTool(
				{ old_string: "NonExistent" },
				{ isPartial: false, fileContent: "Line 1\nLine 2\nLine 3" },
			)

			const askCalls = mockTask.ask.mock.calls
			const hasFinalToolAsk = askCalls.some((call: any[]) => call[0] === "tool" && call[2] === false)
			expect(hasFinalToolAsk).toBe(true)
		})

		it("finalizes a partial tool preview row on no-op success (no changes needed)", async () => {
			// Path stabilization requires two consecutive calls with the same path
			await executeEditFileTool(
				{ old_string: " Line 2", new_string: "Line 2" },
				{ isPartial: true, fileContent: "Line 1\nLine 2\nLine 3" },
			)
			await executeEditFileTool(
				{ old_string: " Line 2", new_string: "Line 2" },
				{ isPartial: true, fileContent: "Line 1\nLine 2\nLine 3" },
			)

			const result = await executeEditFileTool(
				{ old_string: " Line 2", new_string: "Line 2" },
				{ isPartial: false, fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("No changes needed")
			const askCalls = mockTask.ask.mock.calls
			const hasFinalToolAsk = askCalls.some((call: any[]) => call[0] === "tool" && call[2] === false)
			expect(hasFinalToolAsk).toBe(true)
		})
	})

	describe("error handling", () => {
		it("handles file read errors gracefully", async () => {
			mockedFsReadFile.mockRejectedValueOnce(new Error("Read failed"))

			const toolUse: ToolUse = {
				type: "tool_use",
				name: "edit_file",
				params: {
					file_path: testFilePath,
					old_string: testOldString,
					new_string: testNewString,
				},
				nativeArgs: {
					file_path: testFilePath,
					old_string: testOldString,
					new_string: testNewString,
				},
				partial: false,
			}

			let capturedResult: ToolResponse | undefined
			const localPushToolResult = vi.fn((result: ToolResponse) => {
				capturedResult = result
			})

			await editFileTool.handle(mockTask, toolUse as ToolUse<"edit_file">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: localPushToolResult,
			})

			expect(capturedResult).toContain("Failed to read file")
			expect(capturedResult).toContain("<error_details>")
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})

		it("handles general errors and resets diff view", async () => {
			mockTask.diffViewProvider.open.mockRejectedValueOnce(new Error("General error"))

			await executeEditFileTool()

			expect(mockHandleError).toHaveBeenCalledWith("edit_file", expect.any(Error))
			expect(mockTask.diffViewProvider.reset).toHaveBeenCalled()
		})
	})

	describe("file tracking", () => {
		it("tracks file context after successful edit", async () => {
			await executeEditFileTool()

			expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledWith(testFilePath, "agent_edited")
		})
	})

	describe("CRLF normalization", () => {
		it("preserves CRLF line endings on output", async () => {
			const contentWithCRLF = "Line 1\r\nLine 2\r\nLine 3"

			await executeEditFileTool(
				{ old_string: "Line 2", new_string: "Modified Line 2" },
				{ fileContent: contentWithCRLF },
			)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.update).toHaveBeenCalledWith("Line 1\r\nModified Line 2\r\nLine 3", true)
		})

		it("normalizes CRLF in old_string for matching against LF file content", async () => {
			await executeEditFileTool(
				{
					old_string: "Line 1\r\nLine 2\r\nLine 3",
					new_string: "Line 1\r\nModified Line 2\r\nLine 3",
				},
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.update).toHaveBeenCalledWith("Line 1\nModified Line 2\nLine 3", true)
		})
	})

	describe("deterministic fallback matching", () => {
		it("recovers from whitespace/indentation mismatch (whitespace-tolerant regex)", async () => {
			await executeEditFileTool(
				{
					old_string: "start\nif (true) {\n    return 1\n}\nend",
					new_string: "start\nif (true) {\n    return 2\n}\nend",
				},
				{ fileContent: "start\nif (true) {\n\treturn 1\n}\nend" },
			)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.update).toHaveBeenCalledWith(
				"start\nif (true) {\n    return 2\n}\nend",
				true,
			)
		})

		it("keeps $ literal under regex fallback replacement", async () => {
			await executeEditFileTool(
				{
					old_string: "Line 1\n    Line 2\nLine 3",
					new_string: "Line 1\n    Cost: $100\nLine 3",
				},
				{ fileContent: "Line 1\n\tLine 2\nLine 3" },
			)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.update).toHaveBeenCalledWith("Line 1\n    Cost: $100\nLine 3", true)
		})

		it("falls back to token-based regex when whitespace-tolerant regex cannot match", async () => {
			await executeEditFileTool(
				{
					old_string: " Line 2",
					new_string: "Row 2",
				},
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.update).toHaveBeenCalledWith("Line 1\nRow 2\nLine 3", true)
		})
	})

	describe("dollar sign handling", () => {
		it("handles $ in new_string correctly", async () => {
			await executeEditFileTool(
				{ old_string: "Line 2", new_string: "Cost: $100" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockTask.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
		})
	})

	// --- 追加: C1 100% と不変条件の網羅 ---

	// module-private だった正規化ヘルパを直接検証する。実行経路（execute）では
	// old_string の空/空白は手前で弾かれるため、防御ガードに到達できない。
	describe("internal helpers", () => {
		describe("countOccurrences", () => {
			it("returns 0 for an empty substring", () => {
				expect(countOccurrences("abc", "")).toBe(0)
			})
			it("counts non-overlapping occurrences", () => {
				expect(countOccurrences("aaa", "a")).toBe(3)
				expect(countOccurrences("ababab", "ab")).toBe(3)
				expect(countOccurrences("abc", "z")).toBe(0)
			})
		})

		describe("safeLiteralReplace", () => {
			it("returns the input unchanged when oldString is empty", () => {
				expect(safeLiteralReplace("abc", "", "x")).toBe("abc")
			})
			it("returns the input unchanged when oldString is not present", () => {
				expect(safeLiteralReplace("abc", "z", "x")).toBe("abc")
			})
			it("replaces without $ special-casing when newString has no $", () => {
				expect(safeLiteralReplace("x a y a", "a", "b")).toBe("x b y b")
			})
			it("keeps $-sequences literal in newString", () => {
				expect(safeLiteralReplace("x a y", "a", "$1")).toBe("x $1 y")
				expect(safeLiteralReplace("x a y", "a", "$&")).toBe("x $& y")
			})
		})

		describe("buildWhitespaceTolerantRegex", () => {
			it("never matches when oldLF is empty", () => {
				const re = buildWhitespaceTolerantRegex("")
				expect("anything".match(re)).toBeNull()
			})
			it("tolerates horizontal whitespace differences", () => {
				const re = buildWhitespaceTolerantRegex("a b")
				expect(re.test("a    b")).toBe(true)
			})
			it("tolerates newlines within a whitespace run", () => {
				const re = buildWhitespaceTolerantRegex("a \nb")
				expect(re.test("a\n\nb")).toBe(true)
			})
		})

		describe("buildTokenRegex", () => {
			it("never matches when oldLF is only whitespace", () => {
				const re = buildTokenRegex("   ")
				expect("   ".match(re)).toBeNull()
			})
			it("matches tokens separated by arbitrary whitespace", () => {
				const re = buildTokenRegex("a b")
				expect(re.test("a\n\tb")).toBe(true)
			})
		})
	})

	describe("absolute file_path handling", () => {
		// file_path が絶対のとき cwd 相対に変換する（L202-203）。実在の絶対パスを
		// 渡し、namespace 側 spy も true にして tool のバインド差異を吸収する。
		it("relativizes an absolute file_path", async () => {
			mockedPathIsAbsolute.mockReturnValueOnce(true)

			await executeEditFileTool(
				{ file_path: "/abs/target.txt", old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveChanges).toHaveBeenCalled()
		})

		// error-preview builder の長い old_string 切り詰め（L213）。
		it("truncates a long old_string when building the error preview", async () => {
			const longOld = "L".repeat(60)

			const result = await executeEditFileTool(
				{ old_string: longOld, new_string: "X" },
				{ fileContent: "no match here" },
			)

			expect(result).toContain("No match found")
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		})
	})

	describe("non-Error read failure", () => {
		// readFile が Error 以外（文字列など）で reject しても理由を利用者に返す（L249 の else）。
		it("surfaces a string thrown from readFile via String(error)", async () => {
			mockedFsReadFile.mockResolvedValue(testFileContent)
			mockedFsReadFile.mockRejectedValueOnce("EIO: stringy read failure")

			const toolUse: ToolUse = {
				type: "tool_use",
				name: "edit_file",
				params: {
					file_path: testFilePath,
					old_string: testOldString,
					new_string: testNewString,
				},
				nativeArgs: {
					file_path: testFilePath,
					old_string: testOldString,
					new_string: testNewString,
				},
				partial: false,
			}

			let capturedResult: ToolResponse | undefined
			const localPushToolResult = vi.fn((result: ToolResponse) => {
				capturedResult = result
			})

			await editFileTool.handle(mockTask, toolUse as ToolUse<"edit_file">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: localPushToolResult,
			})

			expect(capturedResult).toContain("Failed to read file")
			expect(capturedResult).toContain("EIO: stringy read failure")
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		})
	})

	describe("occurrence mismatch via fallback matchers", () => {
		// exact 一致 0 件だが whitespace-tolerant / token-based では複数一致し、
		// いずれも expected と食い違う場合の専用エラー（L351-359）。
		it("reports a whitespace/token occurrence mismatch and writes nothing", async () => {
			const result = await executeEditFileTool(
				{ old_string: "foo bar", new_string: "X" },
				{ fileContent: "foo  bar\nfoo\tbar" },
			)

			expect(result).toContain("Occurrence count mismatch")
			expect(result).toContain("whitespace-tolerant")
			expect(result).toContain("token-based")
			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		})
	})

	describe("empty-diff short circuits", () => {
		// modify で diff が空なら reset して打ち切る（L389-396）。
		it("reports 'No changes needed', resets, and writes nothing when a modify diff is empty", async () => {
			mockedCreatePrettyPatch.mockReturnValueOnce("")

			const result = await executeEditFileTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("No changes needed")
			expect(mockTask.diffViewProvider.reset).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		})

		// 新規作成では diff が空でも打ち切らず作成まで進む（L389 の !isNewFile 側・L408 の diff||""）。
		it("creates a new file even when the generated diff is empty", async () => {
			mockedCreatePrettyPatch.mockReturnValueOnce("")

			await executeEditFileTool({ old_string: "", new_string: "New content" }, { fileExists: false })

			expect(mockTask.diffViewProvider.editType).toBe("create")
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveChanges).toHaveBeenCalled()
		})
	})

	describe("diff stats and provider fallbacks", () => {
		it("omits diffStats from the approval payload when computeDiffStats returns null", async () => {
			mockedComputeDiffStats.mockReturnValueOnce(null)

			await executeEditFileTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			const payload = JSON.parse(String(mockAskApproval.mock.calls[0][1]))
			expect(payload.diffStats).toBeUndefined()
		})

		it("falls back to default diagnostics/writeDelay when the provider reference is gone", async () => {
			mockTask.providerRef = { deref: () => undefined } as any

			await executeEditFileTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockTask.diffViewProvider.saveChanges).toHaveBeenCalledWith(true, DEFAULT_WRITE_DELAY_MS)
		})
	})

	describe("preventFocusDisruption", () => {
		function enableFocusDisruption() {
			mockTask.providerRef = {
				deref: () => ({
					getState: async () => ({
						diagnosticsEnabled: true,
						writeDelayMs: 1000,
						experiments: { preventFocusDisruption: true },
					}),
				}),
			} as any
		}

		it("saves directly without opening the diff view when the experiment is enabled", async () => {
			enableFocusDisruption()

			await executeEditFileTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockTask.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveDirectly).toHaveBeenCalledTimes(1)
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockTask.didEditFile).toBe(true)
		})

		it("writes nothing if the user rejects, even with the experiment enabled", async () => {
			enableFocusDisruption()
			mockAskApproval.mockResolvedValue(false)

			const result = await executeEditFileTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("rejected")
			expect(mockTask.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		})
	})

	describe("partial preview: finalize + absolute + truncation", () => {
		// 別ファイルの partial preview を確定中でも、異なる relPath の失敗では
		// その preview 行に触れない（L163-164 の早期 return）。
		it("does not finalize a partial preview belonging to a different file", async () => {
			await executeEditFileTool({ file_path: "a.txt", old_string: "X" }, { isPartial: true })
			await executeEditFileTool({ file_path: "a.txt", old_string: "X" }, { isPartial: true })

			const result = await executeEditFileTool(
				{ file_path: "b.txt", old_string: "NoSuch", new_string: "Y" },
				{ isPartial: false, fileExists: false },
			)

			expect(result).toContain("File does not exist")
			expect(mockTask.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		})

		// partial で絶対パスを相対化し（L516-518）、長い old_string を切り詰める（L509）。
		it("relativizes an absolute path and truncates a long old_string preview", async () => {
			mockedPathIsAbsolute.mockReturnValue(true)
			const longOld = "L".repeat(60)

			await executeEditFileTool({ file_path: "/abs/x.txt", old_string: longOld }, { isPartial: true })
			await executeEditFileTool({ file_path: "/abs/x.txt", old_string: longOld }, { isPartial: true })

			const calls = mockTask.ask.mock.calls
			expect(calls.length).toBeGreaterThan(0)
			const payload = JSON.parse(calls[calls.length - 1][1])
			expect(payload.diff).toBe(`replacing: "${"L".repeat(50)}..."`)
		})
	})
})
