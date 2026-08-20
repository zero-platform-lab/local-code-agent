/**
 * Tests for ReadFileTool - Codex-inspired file reading with indentation mode support.
 *
 * These tests cover:
 * - Input validation (missing path parameter)
 * - AgentIgnore blocking
 * - Directory read error handling
 * - Binary file handling (images, PDF, DOCX, unsupported)
 * - Image memory limits
 * - Approval flow (approve, deny, feedback)
 * - Text file processing (slice and indentation modes)
 * - Output structure formatting
 */

import { isBinaryFile } from "isbinaryfile"

import { readFileTool } from "../ReadFileTool"
import { formatResponse } from "../../prompts/responses"
import { validateImageForProcessing, processImageFile, isSupportedImageFormat } from "../helpers/imageHelpers"
import { extractTextFromFile, getSupportedBinaryFormats } from "../../../integrations/misc/extract-text"
import { readWithIndentation, readWithSlice } from "../../../integrations/misc/indentation-reader"

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("path", async () => {
	const originalPath = await vi.importActual("path")
	return {
		default: originalPath,
		...originalPath,
		resolve: vi.fn().mockImplementation((...args) => args.join("/")),
	}
})

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	stat: vi.fn(),
}))

vi.mock("isbinaryfile")

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn(),
	addLineNumbers: vi.fn().mockImplementation((text: string, startLine = 1) => {
		if (!text) return ""
		const lines = text.split("\n")
		return lines.map((line, i) => `${startLine + i} | ${line}`).join("\n")
	}),
	getSupportedBinaryFormats: vi.fn(() => [".pdf", ".docx", ".ipynb"]),
}))

vi.mock("../../../integrations/misc/indentation-reader", () => ({
	readWithIndentation: vi.fn(),
	readWithSlice: vi.fn(),
}))

vi.mock("../helpers/imageHelpers", () => ({
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB: 5,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB: 20,
	isSupportedImageFormat: vi.fn(),
	validateImageForProcessing: vi.fn(),
	processImageFile: vi.fn(),
	ImageMemoryTracker: vi.fn().mockImplementation(() => ({
		getTotalMemoryUsed: vi.fn().mockReturnValue(0),
		addMemoryUsage: vi.fn(),
	})),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolDenied: vi.fn(() => "The user denied this operation."),
		toolDeniedWithFeedback: vi.fn(
			(feedback?: string) =>
				`The user denied this operation and responded with the message:\n<user_message>\n${feedback}\n</user_message>`,
		),
		toolApprovedWithFeedback: vi.fn(
			(feedback?: string) =>
				`The user approved this operation and responded with the message:\n<user_message>\n${feedback}\n</user_message>`,
		),
		agentIgnoreError: vi.fn(
			(filePath: string) =>
				`Access to ${filePath} is blocked by the .agentignore file settings. You must try to continue in the task without using this file, or ask the user to update the .agentignore file.`,
		),
		toolResult: vi.fn((text: string, images?: string[]) => {
			if (images && images.length > 0) {
				return [
					{ type: "text", text },
					...images.map((img) => {
						const [header, data] = img.split(",")
						const media_type = header.match(/:(.*?);/)?.[1] || "image/png"
						return { type: "image", source: { type: "base64", media_type, data } }
					}),
				]
			}
			return text
		}),
		imageBlocks: vi.fn((images?: string[]) => {
			return images
				? images.map((img) => {
						const [header, data] = img.split(",")
						const media_type = header.match(/:(.*?);/)?.[1] || "image/png"
						return { type: "image", source: { type: "base64", media_type, data } }
					})
				: []
		}),
	},
}))

// Mock fs/promises
const fsPromises = await import("fs/promises")
const mockedFsReadFile = vi.mocked(fsPromises.readFile)
const mockedFsStat = vi.mocked(fsPromises.stat)

const mockedIsBinaryFile = vi.mocked(isBinaryFile)
const mockedExtractTextFromFile = vi.mocked(extractTextFromFile)
const mockedReadWithSlice = vi.mocked(readWithSlice)
const mockedReadWithIndentation = vi.mocked(readWithIndentation)
const mockedIsSupportedImageFormat = vi.mocked(isSupportedImageFormat)
const mockedValidateImageForProcessing = vi.mocked(validateImageForProcessing)
const mockedProcessImageFile = vi.mocked(processImageFile)

// ─── Test Helpers ─────────────────────────────────────────────────────────────

interface MockTaskOptions {
	supportsImages?: boolean
	rooIgnoreAllowed?: boolean
	maxImageFileSize?: number
	maxTotalImageSize?: number
}

function createMockTask(options: MockTaskOptions = {}) {
	const { supportsImages = false, rooIgnoreAllowed = true, maxImageFileSize = 5, maxTotalImageSize = 20 } = options

	return {
		cwd: "/test/workspace",
		api: {
			getModel: vi.fn().mockReturnValue({
				info: { supportsImages },
			}),
		},
		mistakeTracker: { count: 0 } as any,
		stream: { didToolFailInCurrentTurn: false, didRejectTool: false } as any,
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined }),
		say: vi.fn().mockResolvedValue(undefined),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing required parameter: path"),
		tokenUsageTracker: { recordToolError: vi.fn(), recordToolUsage: vi.fn() },
		rooIgnoreController: {
			validateAccess: vi.fn().mockReturnValue(rooIgnoreAllowed),
		},
		fileContextTracker: {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
		},
		providerRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					maxImageFileSize,
					maxTotalImageSize,
				}),
			}),
		},
	}
}

function createMockCallbacks() {
	return {
		pushToolResult: vi.fn(),
		askApproval: vi.fn(),
		handleError: vi.fn(),
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ReadFileTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()

		// Default mock implementations
		mockedFsStat.mockResolvedValue({ isDirectory: () => false } as any)
		mockedIsBinaryFile.mockResolvedValue(false)
		mockedFsReadFile.mockResolvedValue(Buffer.from("test content"))
		mockedReadWithSlice.mockReturnValue({
			content: "1 | test content",
			returnedLines: 1,
			totalLines: 1,
			wasTruncated: false,
			includedRanges: [[1, 1]],
		})
	})

	describe("input validation", () => {
		it("should return error when path is missing", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "" } as any, mockTask as any, callbacks)

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(mockTask.tokenUsageTracker!.recordToolError).toHaveBeenCalledWith("read_file")
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("read_file", "path")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error:"))
		})

		it("should return error when path is undefined", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({} as any, mockTask as any, callbacks)

			expect(mockTask.mistakeTracker!.count).toBe(1)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error:"))
		})

		it("should return error when offset is 0 or negative", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "test.txt", offset: 0 }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("offset must be a 1-indexed line number"),
			)
		})

		it("should return error when offset is negative", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "test.txt", offset: -5 }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("offset must be a 1-indexed line number"),
			)
		})

		it("should return error when limit is 0", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "test.txt", limit: 0 }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("limit must be at least 1 (got 0)"),
			)
		})

		it("should return error when limit is negative", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "test.txt", limit: -5 }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("limit must be at least 1 (got -5)"),
			)
		})

		it("should point at the default instead of repeating the bad limit", async () => {
			// 修正前は "limit=0 で再試行してください" と壊れた値をそのまま勧めていた。
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "test.txt", limit: 0 }, mockTask as any, callbacks)

			const pushed = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(pushed).toContain("Omit it to use the default")
			expect(pushed).not.toContain("limit=0")
		})

		it("should not read the file at all when limit is invalid", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "test.txt", limit: 0 }, mockTask as any, callbacks)

			expect(mockedFsReadFile).not.toHaveBeenCalled()
		})

		it("should accept a limit of 1", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("a\nb"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | a",
				returnedLines: 1,
				totalLines: 2,
				wasTruncated: true,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "test.txt", limit: 1 }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).not.toHaveBeenCalledWith(expect.stringContaining("limit must be"))
		})

		it("should return error when anchor_line is 0 or negative", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{
					path: "test.txt",
					mode: "indentation",
					indentation: { anchor_line: 0 },
				},
				mockTask as any,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("anchor_line must be a 1-indexed line number"),
			)
		})

		it("should return error when anchor_line is negative", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(
				{
					path: "test.txt",
					mode: "indentation",
					indentation: { anchor_line: -10 },
				},
				mockTask as any,
				callbacks,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("anchor_line must be a 1-indexed line number"),
			)
		})
	})

	describe("AgentIgnore handling", () => {
		it("should block access to agentignore-protected files", async () => {
			const mockTask = createMockTask({ rooIgnoreAllowed: false })
			const callbacks = createMockCallbacks()

			await readFileTool.execute({ path: "secret.env" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("agentignore_error", "secret.env")
			expect(formatResponse.agentIgnoreError).toHaveBeenCalledWith("secret.env")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("blocked by the .agentignore"),
			)
		})
	})

	describe("directory handling", () => {
		it("should return error when trying to read a directory", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsStat.mockResolvedValue({ isDirectory: () => true } as any)

			await readFileTool.execute({ path: "src/utils" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith(
				"error",
				expect.stringContaining("Cannot read 'src/utils' because it is a directory"),
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("it is a directory"))
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})
	})

	describe("image handling", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
		})

		it("should process image file when model supports images", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: true,
				sizeInMB: 0.5,
			})
			mockedProcessImageFile.mockResolvedValue({
				dataUrl: "data:image/png;base64,abc123",
				buffer: Buffer.from("test"),
				sizeInKB: 512,
				sizeInMB: 0.5,
				notice: "Image processed successfully",
			})

			await readFileTool.execute({ path: "image.png" }, mockTask as any, callbacks)

			expect(mockedValidateImageForProcessing).toHaveBeenCalled()
			expect(mockedProcessImageFile).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalled()
		})

		it("should skip image when model does not support images", async () => {
			const mockTask = createMockTask({ supportsImages: false })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: false,
				reason: "unsupported_model",
				notice: "Model does not support image processing",
			})

			await readFileTool.execute({ path: "image.png" }, mockTask as any, callbacks)

			expect(mockedValidateImageForProcessing).toHaveBeenCalled()
			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Model does not support image processing"),
			)
		})

		it("should skip image when file exceeds size limit", async () => {
			const mockTask = createMockTask({ supportsImages: true, maxImageFileSize: 1 })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: false,
				reason: "size_limit",
				notice: "Image file size (10 MB) exceeds the maximum allowed size (1 MB)",
			})

			await readFileTool.execute({ path: "large-image.png" }, mockTask as any, callbacks)

			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("exceeds the maximum allowed"),
			)
		})

		it("should skip image when total memory limit exceeded", async () => {
			const mockTask = createMockTask({ supportsImages: true, maxTotalImageSize: 5 })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: false,
				reason: "memory_limit",
				notice: "Skipping image: would exceed total memory limit",
			})

			await readFileTool.execute({ path: "another-image.png" }, mockTask as any, callbacks)

			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("would exceed total memory"))
		})

		it("should handle image read errors gracefully", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			mockedValidateImageForProcessing.mockResolvedValue({
				isValid: true,
				sizeInMB: 0.5,
			})
			mockedProcessImageFile.mockRejectedValue(new Error("Failed to read image"))

			await readFileTool.execute({ path: "corrupt.png" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error reading image file"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error"))
		})
	})

	describe("binary file handling", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(false)
		})

		it("should extract text from PDF files", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedExtractTextFromFile.mockResolvedValue("PDF content here")

			await readFileTool.execute({ path: "document.pdf" }, mockTask as any, callbacks)

			expect(mockedExtractTextFromFile).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("PDF content here"))
		})

		it("should extract text from DOCX files", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedExtractTextFromFile.mockResolvedValue("DOCX content here")

			await readFileTool.execute({ path: "document.docx" }, mockTask as any, callbacks)

			expect(mockedExtractTextFromFile).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("DOCX content here"))
		})

		it("should handle unsupported binary formats", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			// Return empty array to indicate .exe is not supported
			vi.mocked(getSupportedBinaryFormats).mockReturnValue([".pdf", ".docx"])

			await readFileTool.execute({ path: "program.exe" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Binary file"))
		})

		it("should handle extraction errors gracefully", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedExtractTextFromFile.mockRejectedValue(new Error("Extraction failed"))

			await readFileTool.execute({ path: "corrupt.pdf" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error extracting text"))
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})
	})

	describe("text file processing", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(false)
		})

		it("should read text file with slice mode (default)", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			const content = "line 1\nline 2\nline 3"
			mockedFsReadFile.mockResolvedValue(Buffer.from(content))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | line 1\n2 | line 2\n3 | line 3",
				returnedLines: 3,
				totalLines: 3,
				wasTruncated: false,
				includedRanges: [[1, 3]],
			})

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockedReadWithSlice).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("line 1"))
		})

		it("should read text file with offset and limit", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("line 1\nline 2\nline 3\nline 4\nline 5"))
			mockedReadWithSlice.mockReturnValue({
				content: "2 | line 2\n3 | line 3",
				returnedLines: 2,
				totalLines: 5,
				wasTruncated: true,
				includedRanges: [[2, 3]],
			})

			await readFileTool.execute(
				{ path: "test.ts", mode: "slice", offset: 2, limit: 2 },
				mockTask as any,
				callbacks,
			)

			expect(mockedReadWithSlice).toHaveBeenCalledWith(expect.any(String), 1, 2) // offset converted to 0-based
		})

		it("should read text file with indentation mode", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			const content = "class Foo {\n  method() {\n    return 42\n  }\n}"
			mockedFsReadFile.mockResolvedValue(Buffer.from(content))
			mockedReadWithIndentation.mockReturnValue({
				content: "1 | class Foo {\n2 |   method() {\n3 |     return 42\n4 |   }\n5 | }",
				returnedLines: 5,
				totalLines: 5,
				wasTruncated: false,
				includedRanges: [[1, 5]],
			})

			await readFileTool.execute(
				{
					path: "test.ts",
					mode: "indentation",
					indentation: { anchor_line: 3 },
				},
				mockTask as any,
				callbacks,
			)

			expect(mockedReadWithIndentation).toHaveBeenCalledWith(
				content,
				expect.objectContaining({
					anchorLine: 3,
				}),
			)
		})

		it("should show truncation notice when content is truncated", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("lots of content..."))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | truncated content",
				returnedLines: 100,
				totalLines: 5000,
				wasTruncated: true,
				includedRanges: [[1, 100]],
			})

			await readFileTool.execute({ path: "large.ts" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("truncated"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("To read more"))
		})

		it("should handle empty files", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from(""))
			// 実物の readWithSlice("") は returnedLines:1 / "1 | " を返す。ここを 0 行と
			// 偽っていたせいで「offset 超過を空ファイルと誤報する」バグが隠れていた。
			// 0 バイトの判定は reader に渡す前に行うので、この mock は本来呼ばれない。
			mockedReadWithSlice.mockReturnValue({
				content: "1 | ",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "empty.ts" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Note: File is empty"))
			expect(mockedReadWithSlice).not.toHaveBeenCalled()
		})

		it("should tell the model the offset is out of range rather than calling the file empty", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("a\nb"))
			mockedReadWithSlice.mockReturnValue({
				content: "Error: offset 99 is beyond file end (2 lines)",
				returnedLines: 0,
				totalLines: 2,
				wasTruncated: false,
				includedRanges: [],
			})

			await readFileTool.execute({ path: "short.ts", offset: 100 }, mockTask as any, callbacks)

			const pushed = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(pushed).toContain("Error: offset 100 is beyond file end (2 lines)")
			expect(pushed).not.toContain("File is empty")
		})
	})

	describe("approval flow", () => {
		it("should approve file read when user clicks yes", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.any(String), false)
			expect(mockTask.stream.didRejectTool).toBe(false)
		})

		it("should deny file read when user clicks no", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({ response: "noButtonClicked", text: undefined, images: undefined })

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockTask.stream.didRejectTool).toBe(true)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Denied by user"))
		})

		it("should include user feedback when provided with approval", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({
				response: "yesButtonClicked",
				text: "Please be careful with this file",
				images: undefined,
			})
			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "Please be careful with this file", undefined)
			expect(formatResponse.toolApprovedWithFeedback).toHaveBeenCalledWith("Please be careful with this file")
		})

		it("should include user feedback when provided with denial", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({
				response: "noButtonClicked",
				text: "This file contains secrets",
				images: undefined,
			})

			await readFileTool.execute({ path: "secrets.env" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "This file contains secrets", undefined)
			expect(formatResponse.toolDeniedWithFeedback).toHaveBeenCalledWith("This file contains secrets")
		})
	})

	describe("output structure", () => {
		it("should include file path in output", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "src/app.ts" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("File: src/app.ts"))
		})

		it("should track file context after successful read", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "test.ts" }, mockTask as any, callbacks)

			expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledWith("test.ts", "read_tool")
		})
	})

	describe("error handling", () => {
		it("should handle file read errors gracefully", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsReadFile.mockRejectedValue(new Error("ENOENT: no such file or directory"))

			await readFileTool.execute({ path: "nonexistent.ts" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error reading file"))
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})

		it("should handle stat errors gracefully", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedFsStat.mockRejectedValue(new Error("Permission denied"))

			await readFileTool.execute({ path: "protected.ts" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("Error reading file"))
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})
	})

	describe("getReadFileToolDescription", () => {
		it("should return description with path when nativeArgs provided", () => {
			const description = readFileTool.getReadFileToolDescription("read_file", { path: "src/app.ts" })

			expect(description).toBe("[read_file for 'src/app.ts']")
		})

		it("should return description with path when params provided", () => {
			const description = readFileTool.getReadFileToolDescription("read_file", { path: "src/app.ts" })

			expect(description).toBe("[read_file for 'src/app.ts']")
		})

		it("should return description indicating missing path", () => {
			const description = readFileTool.getReadFileToolDescription("read_file", {})

			expect(description).toBe("[read_file with missing path]")
		})

		it("falls through to the loose params branch when path is present but not a string", () => {
			// native-args ガード（typeof path === "string"）を外し、blockParams.path の
			// truthy 分岐（551 行目）へ落ちることを固定する。
			const description = readFileTool.getReadFileToolDescription("read_file", { path: 123 } as any)

			expect(description).toBe("[read_file for '123']")
		})
	})

	// ─── executeNew の残り分岐 ────────────────────────────────────────────────
	describe("executeNew — additional branches", () => {
		it("routes non-Error rejections through String() in the inner catch", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			// Error でない値を投げると `error instanceof Error ? … : String(error)` の
			// String 側へ落ちる。
			mockedFsReadFile.mockRejectedValue("weird string failure" as any)

			await readFileTool.execute({ path: "x.ts" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("weird string failure"))
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
		})

		it("falls back to default image limits when provider state is unavailable", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			// deref() が undefined を返す → `state ?? {}` の右側。既定上限で処理が続く。
			mockTask.providerRef.deref.mockReturnValue(undefined)

			await readFileTool.execute({ path: "x.ts" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("File: x.ts"))
		})

		it("treats a model without a supportsImages flag as non-image-capable", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			// info.supportsImages 未定義 → `?? false` の右側（108 行目・517 行目）。
			mockTask.api.getModel.mockReturnValue({ info: {} } as any)

			await readFileTool.execute({ path: "x.ts" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("File: x.ts"))
		})

		it("enters the outer catch when approval itself throws", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			// requestApproval 内の task.ask が投げると、ファイル単位の内側 try ではなく
			// executeNew を包む外側 catch（262-280 行目）へ落ちる。
			mockTask.ask.mockRejectedValue(new Error("ask exploded"))

			await readFileTool.execute({ path: "x.ts" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("ask exploded"))
			expect(mockTask.stream.didToolFailInCurrentTurn).toBe(true)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error"))
		})

		it("routes non-Error approval failures through String() in the outer catch", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			// 外側 catch の `error instanceof Error ? … : String(error)` の String 側。
			mockTask.ask.mockRejectedValue("ask string boom" as any)

			await readFileTool.execute({ path: "x.ts" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("ask string boom"))
		})
	})

	// ─── バイナリ処理の残り分岐 ──────────────────────────────────────────────
	describe("handleBinaryFile — additional branches", () => {
		beforeEach(() => {
			mockedIsBinaryFile.mockResolvedValue(true)
		})

		it("reports an empty extracted document as empty rather than 'Lines 1-1'", async () => {
			// バグ修正の固定: 抽出結果が空文字なら `Note: File is empty`。
			// 修正前は split('\n').length===1 のため常に `Lines 1-1:` を出していた。
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedIsSupportedImageFormat.mockReturnValue(false)
			mockedExtractTextFromFile.mockResolvedValue("")

			await readFileTool.execute({ path: "empty.pdf" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Note: File is empty"))
			expect(callbacks.pushToolResult).not.toHaveBeenCalledWith(expect.stringContaining("Lines 1-1"))
		})

		it("labels an extensionless binary as 'bin'", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			// 拡張子なし → fileExtension "" → `"".slice(1) || "bin"` の "bin" 側（368 行目）。
			mockedIsSupportedImageFormat.mockReturnValue(false)
			vi.mocked(getSupportedBinaryFormats).mockReturnValue([".pdf"])

			await readFileTool.execute({ path: "Makefile" }, mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Binary file (bin)"))
		})

		it("routes non-Error image failures through String()", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({ isValid: true, sizeInMB: 0.1 })
			mockedProcessImageFile.mockRejectedValue("image boom" as any) // 非 Error

			await readFileTool.execute({ path: "corrupt.png" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("image boom"))
		})

		it("routes non-Error extraction failures through String()", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			mockedIsSupportedImageFormat.mockReturnValue(false)
			mockedExtractTextFromFile.mockRejectedValue("extract boom" as any) // 非 Error

			await readFileTool.execute({ path: "corrupt.pdf" }, mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("extract boom"))
		})
	})

	// ─── buildAndPushResult: ステータス文言＋画像 ────────────────────────────
	describe("buildAndPushResult — status message combined with images", () => {
		it("appends the text block after image blocks when a denial carries feedback + images", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({
				response: "noButtonClicked",
				text: "no way",
				images: ["data:image/png;base64,AAA"],
			})

			await readFileTool.execute({ path: "x.ts" }, mockTask as any, callbacks)

			expect(formatResponse.toolDeniedWithFeedback).toHaveBeenCalledWith("no way")
			// 画像ありなので toolResult は配列を返し、末尾にテキストブロックを足す経路（530-531）。
			const pushed = callbacks.pushToolResult.mock.calls[0][0]
			expect(Array.isArray(pushed)).toBe(true)
		})

		it("appends the text block after image blocks when an approval carries feedback + images", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()

			mockTask.ask.mockResolvedValue({
				response: "yesButtonClicked",
				text: "looks good",
				images: ["data:image/png;base64,BBB"],
			})
			mockedFsReadFile.mockResolvedValue(Buffer.from("content"))
			mockedReadWithSlice.mockReturnValue({
				content: "1 | content",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute({ path: "x.ts" }, mockTask as any, callbacks)

			expect(formatResponse.toolApprovedWithFeedback).toHaveBeenCalledWith("looks good")
			const pushed = callbacks.pushToolResult.mock.calls[0][0]
			expect(Array.isArray(pushed)).toBe(true)
		})
	})

	// ─── requestApproval: バッチ（複数ファイル）承認 ─────────────────────────
	// NOTE: executeNew は常に単一ファイル（fileResults.length === 1）なので、この
	// バッチ承認経路（filesToApprove.length > 1）は execute() 経由では到達不能な
	// **デッドコード**。仕様として残っているため private メソッドを直接叩いて固定する。
	// 到達不能である事実は報告する（将来の削除判断はメンテナに委ねる）。
	describe("requestApproval — batch multi-file (unreachable via execute())", () => {
		function makeBatch(paths: string[]) {
			const results = paths.map((p) => ({ path: p, status: "pending" as string, entry: { path: p } }))
			const update = (path: string, updates: Record<string, unknown>) => {
				const i = results.findIndex((r) => r.path === path)
				if (i !== -1) results[i] = { ...results[i], ...updates }
			}
			return { results, update }
		}

		it("approves every file on Yes and forwards feedback", async () => {
			const mockTask = createMockTask()
			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: "go", images: ["i1"] })
			const { results, update } = makeBatch(["a.txt", "b.txt"])

			await (readFileTool as any).requestApproval(mockTask, results, update)

			expect(results.every((r) => r.status === "approved")).toBe(true)
			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "go", ["i1"])
		})

		it("approves every file on Yes without emitting feedback when there is none", async () => {
			const mockTask = createMockTask()
			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: undefined, images: undefined })
			const { results, update } = makeBatch(["a.txt", "b.txt"])

			await (readFileTool as any).requestApproval(mockTask, results, update)

			expect(results.every((r) => r.status === "approved")).toBe(true)
			expect(mockTask.say).not.toHaveBeenCalledWith("user_feedback", expect.anything(), expect.anything())
		})

		it("denies every file on No and marks the tool rejected", async () => {
			const mockTask = createMockTask()
			mockTask.ask.mockResolvedValue({ response: "noButtonClicked", text: "nope", images: undefined })
			const { results, update } = makeBatch(["a.txt", "b.txt"])

			await (readFileTool as any).requestApproval(mockTask, results, update)

			expect(results.every((r) => r.status === "denied")).toBe(true)
			expect(mockTask.stream.didRejectTool).toBe(true)
			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "nope", undefined)
		})

		it("honours per-file individual permissions", async () => {
			const mockTask = createMockTask()
			// メッセージから実際の key を読み取り、1 件承認・1 件拒否で返す。
			mockTask.ask.mockImplementation(async (_type: string, message: string) => {
				const { batchFiles } = JSON.parse(message)
				return {
					response: "messageResponse",
					text: JSON.stringify({ [batchFiles[0].key]: true, [batchFiles[1].key]: false }),
				}
			})
			const { results, update } = makeBatch(["a.txt", "b.txt"])

			await (readFileTool as any).requestApproval(mockTask, results, update)

			expect(results[0].status).toBe("approved")
			expect(results[1].status).toBe("denied")
			expect(mockTask.stream.didRejectTool).toBe(true)
		})

		it("denies all when the individual-permissions payload is unparseable", async () => {
			const mockTask = createMockTask()
			mockTask.ask.mockResolvedValue({ response: "messageResponse", text: "not-json{" })
			const { results, update } = makeBatch(["a.txt", "b.txt"])

			await (readFileTool as any).requestApproval(mockTask, results, update)

			expect(results.every((r) => r.status === "denied")).toBe(true)
			expect(mockTask.stream.didRejectTool).toBe(true)
		})

		it("treats a missing individual-permissions payload as all-denied", async () => {
			const mockTask = createMockTask()
			// text 無し → `JSON.parse(text || "{}")` の "{}" 側 → 空の許可 → 全拒否。
			mockTask.ask.mockResolvedValue({ response: "messageResponse", text: undefined })
			const { results, update } = makeBatch(["a.txt", "b.txt"])

			await (readFileTool as any).requestApproval(mockTask, results, update)

			expect(results.every((r) => r.status === "denied")).toBe(true)
			expect(mockTask.stream.didRejectTool).toBe(true)
		})
	})

	// ─── handlePartial ───────────────────────────────────────────────────────
	describe("handlePartial", () => {
		it("shows the path for the new single-file format", async () => {
			const mockTask = createMockTask()
			const block = { partial: true, nativeArgs: { path: "src/app.ts" } } as any

			await readFileTool.handlePartial(mockTask as any, block)

			expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.stringContaining("src/app.ts"), true)
		})

		it("shows the first file for the legacy format", async () => {
			const mockTask = createMockTask()
			const block = {
				partial: true,
				nativeArgs: { _legacyFormat: true, files: [{ path: "legacy.ts" }] },
			} as any

			await readFileTool.handlePartial(mockTask as any, block)

			expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.stringContaining("legacy.ts"), true)
		})

		it("uses an empty path when there are no native args", async () => {
			const mockTask = createMockTask()
			const block = { partial: true } as any

			await readFileTool.handlePartial(mockTask as any, block)

			expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.any(String), true)
		})

		it("uses an empty path when the legacy file list is empty", async () => {
			const mockTask = createMockTask()
			// files[0]?.path → undefined → `?? ""`。
			const block = { partial: true, nativeArgs: { _legacyFormat: true, files: [] } } as any

			await readFileTool.handlePartial(mockTask as any, block)

			expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.any(String), true)
		})

		it("uses an empty path when the new format omits path", async () => {
			const mockTask = createMockTask()
			// 非 legacy かつ path 無し → `block.nativeArgs.path ?? ""`。
			const block = { partial: true, nativeArgs: {} } as any

			await readFileTool.handlePartial(mockTask as any, block)

			expect(mockTask.ask).toHaveBeenCalledWith("tool", expect.any(String), true)
		})

		it("swallows errors thrown by ask", async () => {
			const mockTask = createMockTask()
			mockTask.ask.mockRejectedValueOnce(new Error("ask blew up"))
			const block = { partial: true, nativeArgs: { path: "x.ts" } } as any

			await expect(readFileTool.handlePartial(mockTask as any, block)).resolves.toBeUndefined()
		})
	})

	// ─── 旧形式（executeLegacy） ─────────────────────────────────────────────
	describe("legacy format (executeLegacy)", () => {
		const legacy = (files: any) => ({ _legacyFormat: true, files }) as any

		it("dispatches to the legacy path and warns", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

			// 旧形式は readFile(path, "utf8") で文字列を受け取る。
			mockedFsReadFile.mockResolvedValue("a\nb\nc" as any)

			await readFileTool.execute(
				legacy([{ path: "a.ts", lineRanges: [{ start: 1, end: 2 }] }]),
				mockTask as any,
				callbacks,
			)

			expect(warn).toHaveBeenCalledWith(expect.stringContaining("Legacy format detected"))
			// lineRanges 指定は selectLineRanges（実物）で 1 起点抽出される。
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("1 | a"))
			expect(mockTask.fileContextTracker.trackFileContext).toHaveBeenCalledWith("a.ts", "read_tool")
			warn.mockRestore()
		})

		it("errors when files is missing entirely", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(legacy(undefined), mockTask as any, callbacks)

			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("read_file", "files")
			expect(mockTask.mistakeTracker.count).toBe(1)
			expect(mockTask.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("read_file")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error"))
		})

		it("errors when files is an empty array", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()

			await readFileTool.execute(legacy([]), mockTask as any, callbacks)

			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("read_file", "files")
		})

		it("blocks agentignore-protected files without asking for approval", async () => {
			const mockTask = createMockTask({ rooIgnoreAllowed: false })
			const callbacks = createMockCallbacks()

			await readFileTool.execute(legacy([{ path: "secret.env" }]), mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("agentignore_error", "secret.env")
			expect(mockTask.ask).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("blocked by the .agentignore"),
			)
		})

		it("records a denial (with feedback) and does not read the file", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockTask.ask.mockResolvedValue({ response: "noButtonClicked", text: "no", images: undefined })

			await readFileTool.execute(legacy([{ path: "a.ts" }]), mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "no", undefined)
			expect(mockTask.stream.didRejectTool).toBe(true)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Denied by user"))
			expect(mockedFsReadFile).not.toHaveBeenCalled()
		})

		it("forwards approval feedback and reads the whole file when no ranges are given", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockTask.ask.mockResolvedValue({ response: "yesButtonClicked", text: "ok", images: undefined })
			mockedFsReadFile.mockResolvedValue("hello" as any)
			mockedReadWithSlice.mockReturnValue({
				content: "1 | hello",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute(legacy([{ path: "a.ts" }]), mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "ok", undefined)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("1 | hello"))
		})

		it("reports a directory instead of reading it", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockedFsStat.mockResolvedValue({ isDirectory: () => true } as any)

			await readFileTool.execute(legacy([{ path: "somedir" }]), mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("it is a directory"))
			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("it is a directory"))
		})

		it("processes an approved image for a vision model", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({ isValid: true, sizeInMB: 0.1 })
			mockedProcessImageFile.mockResolvedValue({
				dataUrl: "data:image/png;base64,AAA",
				buffer: Buffer.from("x"),
				sizeInKB: 1,
				sizeInMB: 0.1,
				notice: "ok",
			})

			await readFileTool.execute(legacy([{ path: "pic.png" }]), mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("[Image file - content processed for vision model]"),
			)
		})

		it("skips an image whose validation fails", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({ isValid: false, notice: "too big" })

			await readFileTool.execute(legacy([{ path: "big.png" }]), mockTask as any, callbacks)

			expect(mockedProcessImageFile).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("too big"))
		})

		it("uses a generic notice when image validation gives no reason", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			// notice 無し → `validation.notice ?? "Image validation failed"` の右側。
			mockedValidateImageForProcessing.mockResolvedValue({ isValid: false } as any)

			await readFileTool.execute(legacy([{ path: "big.png" }]), mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Image validation failed"))
		})

		it("emits nothing extra when processImageFile returns falsy", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({ isValid: true, sizeInMB: 0.1 })
			mockedProcessImageFile.mockResolvedValue(undefined as any)

			await readFileTool.execute(legacy([{ path: "pic.png" }]), mockTask as any, callbacks)

			// 画像処理は走ったが push すべき本文が無い → 結合結果は空。
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("")
		})

		it("falls back to default image limits when provider state is missing", async () => {
			const mockTask = createMockTask({ supportsImages: true })
			const callbacks = createMockCallbacks()
			mockTask.providerRef.deref.mockReturnValue(undefined) // state ?? {} の右側
			mockedIsBinaryFile.mockResolvedValue(true)
			mockedIsSupportedImageFormat.mockReturnValue(true)
			mockedValidateImageForProcessing.mockResolvedValue({ isValid: true, sizeInMB: 0.1 })
			mockedProcessImageFile.mockResolvedValue({
				dataUrl: "d",
				buffer: Buffer.from("x"),
				sizeInKB: 1,
				sizeInMB: 0.1,
				notice: "ok",
			})

			await readFileTool.execute(legacy([{ path: "pic.png" }]), mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Image file"))
		})

		it("cannot read a binary file when the model has no image support", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			// info に supportsImages を持たせない → `?? false` の右側。
			mockTask.api.getModel.mockReturnValue({ info: {} } as any)
			mockedIsBinaryFile.mockResolvedValue(true)

			await readFileTool.execute(legacy([{ path: "blob.bin" }]), mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Cannot read binary file"))
		})

		it("treats a file as text when the binary check itself throws", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			// isBinaryFile(...).catch(() => false) の catch 側。
			mockedIsBinaryFile.mockRejectedValue(new Error("cannot sniff"))
			mockedFsReadFile.mockResolvedValue("plain" as any)
			mockedReadWithSlice.mockReturnValue({
				content: "1 | plain",
				returnedLines: 1,
				totalLines: 1,
				wasTruncated: false,
				includedRanges: [[1, 1]],
			})

			await readFileTool.execute(legacy([{ path: "a.ts" }]), mockTask as any, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("1 | plain"))
		})

		it("records a read error and keeps going", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			mockedFsReadFile.mockRejectedValue(new Error("ENOENT"))

			await readFileTool.execute(legacy([{ path: "missing.ts" }]), mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("ENOENT"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Error: ENOENT"))
		})

		it("routes non-Error read failures through String()", async () => {
			const mockTask = createMockTask()
			const callbacks = createMockCallbacks()
			// 旧形式 catch の `error instanceof Error ? … : String(error)` の String 側。
			mockedFsReadFile.mockRejectedValue("legacy string boom" as any)

			await readFileTool.execute(legacy([{ path: "a.ts" }]), mockTask as any, callbacks)

			expect(mockTask.say).toHaveBeenCalledWith("error", expect.stringContaining("legacy string boom"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("legacy string boom"))
		})
	})
})
