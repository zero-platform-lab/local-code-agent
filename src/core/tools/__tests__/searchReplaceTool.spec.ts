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
import { searchReplaceTool } from "../SearchReplaceTool"
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

describe("searchReplaceTool", () => {
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

	let mockCline: any
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

		mockCline = makeMockTask({
			cwd: "/",
			providerState: {
				diagnosticsEnabled: true,
				writeDelayMs: 1000,
				experiments: {},
			},
		}) as any
		mockCline.ask = vi.fn().mockResolvedValue(undefined)
		mockCline.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("Missing param error")
		mockCline.diffViewProvider = {
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
	 * Helper function to execute the search replace tool with different parameters
	 */
	async function executeSearchReplaceTool(
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
		mockCline.rooIgnoreController.validateAccess.mockReturnValue(accessAllowed)

		const nativeArgs: Record<string, unknown> = {
			file_path: testFilePath,
			old_string: testOldString,
			new_string: testNewString,
		}
		for (const [key, value] of Object.entries(params)) {
			nativeArgs[key] = value
		}

		const toolUse: ToolUse = {
			type: "tool_use",
			name: "search_replace",
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

		await searchReplaceTool.handle(mockCline, toolUse as ToolUse<"search_replace">, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		return toolResult
	}

	describe("parameter validation", () => {
		it("returns error when file_path is missing", async () => {
			const result = await executeSearchReplaceTool({ file_path: undefined })

			expect(result).toBe("Missing param error")
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("search_replace")
		})

		it("returns error when old_string is missing", async () => {
			const result = await executeSearchReplaceTool({ old_string: undefined })

			expect(result).toBe("Missing param error")
			expect(mockCline.mistakeTracker!.count).toBe(1)
		})

		it("allows empty new_string for deletion", async () => {
			// Empty new_string is valid - it means delete the old_string
			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			// Should proceed to approval (not error out)
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("returns error when old_string equals new_string", async () => {
			const result = await executeSearchReplaceTool({
				old_string: "same",
				new_string: "same",
			})

			expect(result).toContain("Error:")
			expect(mockCline.mistakeTracker!.count).toBe(1)
		})
	})

	describe("file access", () => {
		it("returns error when file does not exist", async () => {
			const result = await executeSearchReplaceTool({}, { fileExists: false })

			expect(result).toContain("Error:")
			expect(result).toContain("File not found")
			expect(mockCline.mistakeTracker!.count).toBe(1)
		})

		it("returns error when access is denied", async () => {
			const result = await executeSearchReplaceTool({}, { accessAllowed: false })

			expect(result).toContain("Access denied")
		})
	})

	describe("search and replace logic", () => {
		it("returns error when no match is found", async () => {
			const result = await executeSearchReplaceTool(
				{ old_string: "NonExistent" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("Error:")
			expect(result).toContain("No match found")
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("search_replace", "no_match")
		})

		it("returns error when multiple matches are found", async () => {
			const result = await executeSearchReplaceTool(
				{ old_string: "Line" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("Error:")
			expect(result).toContain("3 matches")
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith(
				"search_replace",
				"multiple_matches",
			)
		})

		it("successfully replaces single unique match", async () => {
			await executeSearchReplaceTool(
				{
					old_string: "Line 2",
					new_string: "Modified Line 2",
				},
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockCline.mistakeTracker!.count).toBe(0)
			expect(mockCline.diffViewProvider.editType).toBe("modify")
			expect(mockAskApproval).toHaveBeenCalled()
		})
	})

	describe("approval workflow", () => {
		it("saves changes when user approves", async () => {
			mockAskApproval.mockResolvedValue(true)

			await executeSearchReplaceTool()

			expect(mockCline.diffViewProvider.saveChanges).toHaveBeenCalled()
			expect(mockCline.didEditFile).toBe(true)
			expect(mockCline.tokenUsageTracker.recordToolUsage).toHaveBeenCalledWith("search_replace")
		})

		it("reverts changes when user rejects", async () => {
			mockAskApproval.mockResolvedValue(false)

			const result = await executeSearchReplaceTool()

			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(result).toContain("rejected")
		})
	})

	describe("partial block handling", () => {
		it("handles partial block without errors after path stabilizes", async () => {
			// Path stabilization requires two consecutive calls with the same path
			// First call sets lastSeenPartialPath, second call sees it has stabilized
			await executeSearchReplaceTool({}, { isPartial: true })
			await executeSearchReplaceTool({}, { isPartial: true })

			expect(mockCline.ask).toHaveBeenCalled()
		})
	})

	describe("error handling", () => {
		it("handles file read errors gracefully", async () => {
			// Set up the rejection BEFORE executing
			mockedFsReadFile.mockRejectedValueOnce(new Error("Read failed"))

			const toolUse: ToolUse = {
				type: "tool_use",
				name: "search_replace",
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

			await searchReplaceTool.handle(mockCline, toolUse as ToolUse<"search_replace">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: localPushToolResult,
			})

			expect(capturedResult).toContain("Error:")
			expect(capturedResult).toContain("Failed to read file")
			expect(mockCline.mistakeTracker!.count).toBe(1)
		})

		it("handles general errors and resets diff view", async () => {
			mockCline.diffViewProvider.open.mockRejectedValueOnce(new Error("General error"))

			await executeSearchReplaceTool()

			expect(mockHandleError).toHaveBeenCalledWith("search and replace", expect.any(Error))
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
		})
	})

	describe("file tracking", () => {
		it("tracks file context after successful edit", async () => {
			await executeSearchReplaceTool()

			expect(mockCline.fileContextTracker.trackFileContext).toHaveBeenCalledWith(testFilePath, "agent_edited")
		})
	})

	describe("CRLF normalization", () => {
		it("normalizes CRLF to LF when reading file", async () => {
			const contentWithCRLF = "Line 1\r\nLine 2\r\nLine 3"

			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "Modified Line 2" },
				{ fileContent: contentWithCRLF },
			)

			expect(mockCline.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("normalizes CRLF in old_string to match LF-normalized file content", async () => {
			// File has CRLF line endings
			const contentWithCRLF = "Line 1\r\nLine 2\r\nLine 3"
			// Search string also has CRLF (simulating what the model might send)
			const searchWithCRLF = "Line 1\r\nLine 2"

			await executeSearchReplaceTool(
				{ old_string: searchWithCRLF, new_string: "Modified Lines" },
				{ fileContent: contentWithCRLF },
			)

			expect(mockCline.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
		})

		it("matches LF old_string against CRLF file content after normalization", async () => {
			// File has CRLF line endings
			const contentWithCRLF = "Line 1\r\nLine 2\r\nLine 3"
			// Search string has LF (typical model output)
			const searchWithLF = "Line 1\nLine 2"

			await executeSearchReplaceTool(
				{ old_string: searchWithLF, new_string: "Modified Lines" },
				{ fileContent: contentWithCRLF },
			)

			expect(mockCline.mistakeTracker!.count).toBe(0)
			expect(mockAskApproval).toHaveBeenCalled()
		})
	})

	// --- 追加: C1 100% と「失敗/未承認なら書かない」不変条件の網羅 ---

	describe("parameter validation (new_string undefined)", () => {
		it("returns error and writes nothing when new_string is undefined", async () => {
			const result = await executeSearchReplaceTool({ new_string: undefined })

			expect(result).toBe("Missing param error")
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("search_replace")
			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("search_replace", "new_string")
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		})
	})

	describe("absolute file_path", () => {
		// file_path が絶対パスのときは cwd 相対に変換する（L66-67）。
		// 実在の絶対パスを渡し、namespace 側 spy も true にして、tool がどちらの
		// path 実装にバインドしていても true 分岐へ入るようにする。
		it("converts an absolute file_path to a workspace-relative path", async () => {
			mockedPathIsAbsolute.mockReturnValueOnce(true)

			await executeSearchReplaceTool(
				{ file_path: "/abs/target.txt", old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			// 絶対パス経路でも承認要求まで到達し、書き込みに進む。
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).toHaveBeenCalled()
		})
	})

	describe("no-op detection", () => {
		// CRLF/LF の差だけの置換は正規化後に同一 → 何も書かない。
		it("reports 'No changes needed' and writes nothing when the replacement is a no-op after CRLF normalization", async () => {
			const result = await executeSearchReplaceTool(
				{ old_string: "Line 2\r\n", new_string: "Line 2\n" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("No changes needed")
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
		})

		it("reports 'No changes needed', resets the diff view, and writes nothing when the diff is empty", async () => {
			mockedCreatePrettyPatch.mockReturnValueOnce("")

			const result = await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(result).toContain("No changes needed")
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
		})
	})

	describe("preventFocusDisruption", () => {
		it("saves directly without opening the diff view when the experiment is enabled", async () => {
			mockCline.providerRef = {
				deref: () => ({
					getState: async () => ({
						diagnosticsEnabled: true,
						writeDelayMs: 1000,
						experiments: { preventFocusDisruption: true },
					}),
				}),
			} as any

			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveDirectly).toHaveBeenCalledTimes(1)
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockCline.didEditFile).toBe(true)
		})
	})

	describe("provider state fallbacks", () => {
		it("falls back to default diagnostics/writeDelay when the provider reference is gone", async () => {
			mockCline.providerRef = { deref: () => undefined } as any

			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			expect(mockCline.diffViewProvider.saveChanges).toHaveBeenCalledWith(true, DEFAULT_WRITE_DELAY_MS)
		})
	})

	describe("diff stats", () => {
		it("omits diffStats from the approval payload when computeDiffStats returns null", async () => {
			mockedComputeDiffStats.mockReturnValueOnce(null)

			await executeSearchReplaceTool(
				{ old_string: "Line 2", new_string: "Changed" },
				{ fileContent: "Line 1\nLine 2\nLine 3" },
			)

			const payload = JSON.parse(String(mockAskApproval.mock.calls[0][1]))
			expect(payload.diffStats).toBeUndefined()
			expect(Object.keys(payload)).not.toContain("diffStats")
		})
	})

	describe("partial preview edge cases", () => {
		// 長い old_string は 50 文字で打ち切ってプレビューする（三項の then 側）。
		// 併せて絶対パスの相対化も通す。
		it("truncates a long old_string preview and relativizes an absolute path", async () => {
			mockedPathIsAbsolute.mockReturnValue(true)
			const longOld = "X".repeat(60)

			await executeSearchReplaceTool({ file_path: "/abs/target.txt", old_string: longOld }, { isPartial: true })
			await executeSearchReplaceTool({ file_path: "/abs/target.txt", old_string: longOld }, { isPartial: true })

			const calls = mockCline.ask.mock.calls
			expect(calls.length).toBeGreaterThan(0)
			const payload = JSON.parse(calls[calls.length - 1][1])
			expect(payload.diff).toBe(`replacing: "${"X".repeat(50)}..."`)
		})
	})
})
