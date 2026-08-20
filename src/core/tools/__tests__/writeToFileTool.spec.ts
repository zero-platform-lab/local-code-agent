import * as path from "path"
import fs from "fs/promises"

import type { MockedFunction } from "vitest"

import { DEFAULT_WRITE_DELAY_MS } from "@openai-agent/types"

import { fileExistsAtPath, createDirectoriesForFile } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { getReadablePath } from "../../../utils/path"
import { formatResponse } from "../../prompts/responses"
import { unescapeHtmlEntities } from "../../../utils/text-normalization"
import { everyLineHasLineNumbers, stripLineNumbers } from "../../../integrations/misc/extract-text"
import { ToolUse, ToolResponse } from "../../../shared/tools"
import { writeToFileTool } from "../WriteToFileTool"
import { makeMockTask } from "../../task/__tests__/makeMockTask"

// WriteToFileTool は preventFocusDisruption 経路でのみ `fs.readFile` を使う。
// 既定 spec は fs/promises を mock していなかったので、ここで安全に差し替える。
vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("existing content"),
	},
}))

vi.mock("path", async () => {
	const originalPath = await vi.importActual("path")
	return {
		...originalPath,
		resolve: vi.fn().mockImplementation((...args) => {
			// On Windows, use backslashes; on Unix, use forward slashes
			const separator = process.platform === "win32" ? "\\" : "/"
			return args.join(separator)
		}),
	}
})

vi.mock("delay", () => ({
	default: vi.fn(),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(false),
	createDirectoriesForFile: vi.fn().mockResolvedValue([]),
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

vi.mock("../../../utils/text-normalization", () => ({
	unescapeHtmlEntities: vi.fn().mockImplementation((content) => content),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	everyLineHasLineNumbers: vi.fn().mockReturnValue(false),
	stripLineNumbers: vi.fn().mockImplementation((content) => content),
	addLineNumbers: vi.fn().mockImplementation((content: string) =>
		content
			.split("\n")
			.map((line: string, i: number) => `${i + 1} | ${line}`)
			.join("\n"),
	),
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

vi.mock("../../ignore/AgentIgnoreController", () => ({
	AgentIgnoreController: class {
		initialize() {
			return Promise.resolve()
		}
		validateAccess() {
			return true
		}
	},
}))

describe("writeToFileTool", () => {
	// Test data
	const testFilePath = "test/file.txt"
	const absoluteFilePath = process.platform === "win32" ? "C:\\test\\file.txt" : "/test/file.txt"
	const testContent = "Line 1\nLine 2\nLine 3"
	const testContentWithMarkdown = "```javascript\nLine 1\nLine 2\n```"

	// Mocked functions with correct types
	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockedCreateDirectoriesForFile = createDirectoriesForFile as MockedFunction<typeof createDirectoriesForFile>
	const mockedIsPathOutsideWorkspace = isPathOutsideWorkspace as MockedFunction<typeof isPathOutsideWorkspace>
	const mockedGetReadablePath = getReadablePath as MockedFunction<typeof getReadablePath>
	const mockedUnescapeHtmlEntities = unescapeHtmlEntities as MockedFunction<typeof unescapeHtmlEntities>
	const mockedEveryLineHasLineNumbers = everyLineHasLineNumbers as MockedFunction<typeof everyLineHasLineNumbers>
	const mockedStripLineNumbers = stripLineNumbers as MockedFunction<typeof stripLineNumbers>
	const mockedPathResolve = path.resolve as MockedFunction<typeof path.resolve>
	const mockedFsReadFile = fs.readFile as unknown as MockedFunction<(p: string, enc: string) => Promise<string>>
	const mockedCreatePrettyPatch = formatResponse.createPrettyPatch as MockedFunction<
		typeof formatResponse.createPrettyPatch
	>

	let mockCline: any
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let mockPushToolResult: ReturnType<typeof vi.fn>
	let toolResult: ToolResponse | undefined

	beforeEach(() => {
		vi.clearAllMocks()
		writeToFileTool.resetPartialState()

		mockedPathResolve.mockReturnValue(absoluteFilePath)
		mockedFileExistsAtPath.mockResolvedValue(false)
		mockedIsPathOutsideWorkspace.mockReturnValue(false)
		mockedGetReadablePath.mockReturnValue("test/path.txt")
		mockedUnescapeHtmlEntities.mockImplementation((content) => content)
		mockedEveryLineHasLineNumbers.mockReturnValue(false)
		mockedStripLineNumbers.mockImplementation((content) => content)

		mockCline = makeMockTask({
			cwd: "/",
			providerState: {
				diagnosticsEnabled: true,
				writeDelayMs: 1000,
			},
		}) as any
		mockCline.diffStrategy = undefined
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
			saveDirectly: vi.fn().mockResolvedValue({
				newProblemsMessage: "",
				userEdits: null,
				finalContent: "final content",
			}),
			scrollToFirstDiff: vi.fn(),
			updateDiagnosticSettings: vi.fn(),
			pushToolWriteResult: vi.fn().mockImplementation(async function (
				this: any,
				task: any,
				cwd: string,
				isNewFile: boolean,
			) {
				// Simulate the behavior of pushToolWriteResult
				if (this.userEdits) {
					await task.say(
						"user_feedback_diff",
						JSON.stringify({
							tool: isNewFile ? "newFileCreated" : "editedExistingFile",
							path: "test/path.txt",
							diff: this.userEdits,
						}),
					)
				}
				return "Tool result message"
			}),
		}
		mockCline.api = {
			getModel: vi.fn().mockReturnValue({ id: "claude-3" }),
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn().mockResolvedValue(undefined)

		toolResult = undefined
	})

	/**
	 * Helper function to execute the write file tool with different parameters
	 */
	async function executeWriteFileTool(
		params: Partial<ToolUse["params"]> = {},
		options: {
			fileExists?: boolean
			isPartial?: boolean
			accessAllowed?: boolean
		} = {},
	): Promise<ToolResponse | undefined> {
		// Configure mocks based on test scenario
		const fileExists = options.fileExists ?? false
		const isPartial = options.isPartial ?? false
		const accessAllowed = options.accessAllowed ?? true

		mockedFileExistsAtPath.mockResolvedValue(fileExists)
		mockCline.rooIgnoreController.validateAccess.mockReturnValue(accessAllowed)

		// Create a tool use object
		const toolUse: ToolUse = {
			type: "tool_use",
			name: "write_to_file",
			params: {
				path: testFilePath,
				content: testContent,
				...params,
			},
			nativeArgs: {
				path: (params.path ?? testFilePath) as any,
				content: (params.content ?? testContent) as any,
			},
			partial: isPartial,
		}

		mockPushToolResult = vi.fn((result: ToolResponse) => {
			toolResult = result
		})

		await writeToFileTool.handle(mockCline, toolUse as ToolUse<"write_to_file">, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		return toolResult
	}

	describe("access control", () => {
		it("validates and allows access when rooIgnoreController permits", async () => {
			await executeWriteFileTool({}, { accessAllowed: true })

			expect(mockCline.rooIgnoreController.validateAccess).toHaveBeenCalledWith(testFilePath)
			expect(mockCline.diffViewProvider.open).toHaveBeenCalledWith(testFilePath)
		})
	})

	describe("file existence detection", () => {
		it.skipIf(process.platform === "win32")("detects existing file and sets editType to modify", async () => {
			await executeWriteFileTool({}, { fileExists: true })

			expect(mockedFileExistsAtPath).toHaveBeenCalledWith(absoluteFilePath)
			expect(mockCline.diffViewProvider.editType).toBe("modify")
		})

		it.skipIf(process.platform === "win32")("detects new file and sets editType to create", async () => {
			await executeWriteFileTool({}, { fileExists: false })

			expect(mockedFileExistsAtPath).toHaveBeenCalledWith(absoluteFilePath)
			expect(mockCline.diffViewProvider.editType).toBe("create")
		})

		it("uses cached editType without filesystem check", async () => {
			mockCline.diffViewProvider.editType = "modify"

			await executeWriteFileTool({})

			expect(mockedFileExistsAtPath).not.toHaveBeenCalled()
		})
	})

	describe("directory creation for new files", () => {
		it.skipIf(process.platform === "win32")(
			"creates parent directories early when file does not exist (execute)",
			async () => {
				await executeWriteFileTool({}, { fileExists: false })

				expect(mockedCreateDirectoriesForFile).toHaveBeenCalledWith(absoluteFilePath)
			},
		)

		it.skipIf(process.platform === "win32")(
			"creates parent directories when path has stabilized (partial)",
			async () => {
				// First call - path not yet stabilized
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()

				// Second call with same path - path is now stabilized
				await executeWriteFileTool({}, { fileExists: false, isPartial: true })
				expect(mockedCreateDirectoriesForFile).toHaveBeenCalledWith(absoluteFilePath)
			},
		)

		it("does not create directories when file exists", async () => {
			await executeWriteFileTool({}, { fileExists: true })

			expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()
		})

		it("does not create directories when editType is cached as modify", async () => {
			mockCline.diffViewProvider.editType = "modify"

			await executeWriteFileTool({})

			expect(mockedCreateDirectoriesForFile).not.toHaveBeenCalled()
		})

		it.skipIf(process.platform === "win32")("creates directories when editType is cached as create", async () => {
			mockCline.diffViewProvider.editType = "create"

			await executeWriteFileTool({})

			expect(mockedCreateDirectoriesForFile).toHaveBeenCalledWith(absoluteFilePath)
		})
	})

	describe("content preprocessing", () => {
		it("removes markdown code block markers from content", async () => {
			await executeWriteFileTool({ content: testContentWithMarkdown })

			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith("Line 1\nLine 2", true)
		})

		it("passes through empty content unchanged", async () => {
			await executeWriteFileTool({ content: "" })

			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith("", true)
		})

		it("unescapes HTML entities for non-Claude models", async () => {
			mockCline.api.getModel.mockReturnValue({ id: "gpt-4" })

			await executeWriteFileTool({ content: "&lt;test&gt;" })

			expect(mockedUnescapeHtmlEntities).toHaveBeenCalledWith("&lt;test&gt;")
		})

		it("skips HTML unescaping for Claude models", async () => {
			mockCline.api.getModel.mockReturnValue({ id: "claude-3" })

			await executeWriteFileTool({ content: "&lt;test&gt;" })

			expect(mockedUnescapeHtmlEntities).not.toHaveBeenCalled()
		})

		it("strips line numbers from numbered content", async () => {
			const contentWithLineNumbers = "1 | line one\n2 | line two"
			mockedEveryLineHasLineNumbers.mockReturnValue(true)
			mockedStripLineNumbers.mockReturnValue("line one\nline two")

			await executeWriteFileTool({ content: contentWithLineNumbers })

			expect(mockedEveryLineHasLineNumbers).toHaveBeenCalledWith(contentWithLineNumbers)
			expect(mockedStripLineNumbers).toHaveBeenCalledWith(contentWithLineNumbers)
			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith("line one\nline two", true)
		})
	})

	describe("file operations", () => {
		it("successfully creates new files with full workflow", async () => {
			await executeWriteFileTool({}, { fileExists: false })

			expect(mockCline.mistakeTracker!.count).toBe(0)
			expect(mockCline.diffViewProvider.open).toHaveBeenCalledWith(testFilePath)
			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith(testContent, true)
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).toHaveBeenCalled()
			expect(mockCline.fileContextTracker.trackFileContext).toHaveBeenCalledWith(testFilePath, "agent_edited")
			expect(mockCline.didEditFile).toBe(true)
		})

		it("processes files outside workspace boundary", async () => {
			mockedIsPathOutsideWorkspace.mockReturnValue(true)

			await executeWriteFileTool({})

			expect(mockedIsPathOutsideWorkspace).toHaveBeenCalled()
		})

		it("processes files with large content", async () => {
			const largeContent = "Line\n".repeat(10000)
			await executeWriteFileTool({ content: largeContent })

			// Should process normally without issues
			expect(mockCline.mistakeTracker!.count).toBe(0)
		})
	})

	describe("partial block handling", () => {
		it("returns early when path is missing in partial block", async () => {
			await executeWriteFileTool({ path: undefined }, { isPartial: true })

			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
		})

		it("returns early when content is undefined in partial block", async () => {
			await executeWriteFileTool({ content: undefined }, { isPartial: true })

			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
		})

		it("streams content updates during partial execution after path stabilizes", async () => {
			// First call - path not yet stabilized, early return (no file operations)
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockCline.ask).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()

			// Second call with same path - path is now stabilized, file operations proceed
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockCline.ask).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.open).toHaveBeenCalledWith(testFilePath)
			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith(testContent, false)
		})
	})

	describe("user interaction", () => {
		it("reverts changes when user rejects approval", async () => {
			mockAskApproval.mockResolvedValue(false)

			await executeWriteFileTool({})

			expect(mockCline.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		})

		it("reports user edits with diff feedback", async () => {
			const userEditsValue = "- old line\n+ new line"
			mockCline.diffViewProvider.saveChanges.mockResolvedValue({
				newProblemsMessage: " with warnings",
				userEdits: userEditsValue,
				finalContent: "modified content",
			})
			// Set the userEdits property on the diffViewProvider mock to simulate user edits
			mockCline.diffViewProvider.userEdits = userEditsValue

			await executeWriteFileTool({}, { fileExists: true })

			expect(mockCline.say).toHaveBeenCalledWith(
				"user_feedback_diff",
				expect.stringContaining("editedExistingFile"),
			)
		})
	})

	describe("error handling", () => {
		it("handles general file operation errors", async () => {
			mockCline.diffViewProvider.open.mockRejectedValue(new Error("General error"))

			await executeWriteFileTool({})

			expect(mockHandleError).toHaveBeenCalledWith("writing file", expect.any(Error))
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
		})

		it("handles partial streaming errors after path stabilizes", async () => {
			mockCline.diffViewProvider.open.mockRejectedValue(new Error("Open failed"))

			// First call - path not yet stabilized, no error yet
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockHandleError).not.toHaveBeenCalled()

			// Second call with same path - path is now stabilized, error occurs
			await executeWriteFileTool({}, { isPartial: true })
			expect(mockHandleError).toHaveBeenCalledWith("handling partial write_to_file", expect.any(Error))
		})
	})

	// --- 追加: C1 100% と「失敗/未承認/拒否なら書かない」不変条件の網羅 ---

	// nativeArgs を直接組んで execute を回すヘルパ（既定 helper は path/content を
	// 常に埋めてしまい欠落系を作れないため）。
	async function runWithNativeArgs(nativeArgs: Record<string, unknown>): Promise<ToolResponse | undefined> {
		let captured: ToolResponse | undefined
		const toolUse: ToolUse = {
			type: "tool_use",
			name: "write_to_file",
			params: nativeArgs as any,
			nativeArgs: nativeArgs as any,
			partial: false,
		}
		await writeToFileTool.handle(mockCline, toolUse as ToolUse<"write_to_file">, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: vi.fn((r: ToolResponse) => {
				captured = r
			}),
		})
		return captured
	}

	describe("missing parameters and access control (writes nothing)", () => {
		it("returns a missing-param error and writes nothing when path is absent", async () => {
			const result = await runWithNativeArgs({ path: undefined, content: testContent })

			expect(result).toBe("Missing param error")
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("write_to_file")
			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("write_to_file", "path")
			expect(mockCline.diffViewProvider.reset).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		})

		it("returns a missing-param error and writes nothing when content is undefined", async () => {
			const result = await runWithNativeArgs({ path: testFilePath, content: undefined })

			expect(result).toBe("Missing param error")
			expect(mockCline.mistakeTracker!.count).toBe(1)
			expect(mockCline.sayAndCreateMissingParamError).toHaveBeenCalledWith("write_to_file", "content")
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		})

		it("denies access and writes nothing when the path is agent-ignored", async () => {
			const result = await executeWriteFileTool({}, { accessAllowed: false })

			expect(String(result)).toContain("Access denied")
			expect(mockCline.say).toHaveBeenCalledWith("agentignore_error", testFilePath)
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
			expect(mockAskApproval).not.toHaveBeenCalled()
		})
	})

	describe("provider state fallbacks (non-focus)", () => {
		it("uses default diagnostics/writeDelay when the provider reference is gone", async () => {
			mockCline.providerRef = { deref: () => undefined }

			await executeWriteFileTool({}, { fileExists: false })

			expect(mockCline.diffViewProvider.saveChanges).toHaveBeenCalledWith(true, DEFAULT_WRITE_DELAY_MS)
		})

		it("omits diffStats when the (non-focus) diff yields no stats", async () => {
			// createPrettyPatch が空 → sanitize も空 → computeDiffStats は null。
			mockedCreatePrettyPatch.mockReturnValueOnce("")

			await executeWriteFileTool({}, { fileExists: true })

			const payload = JSON.parse(String(mockAskApproval.mock.calls[0][1]))
			expect(payload.diffStats).toBeUndefined()
		})
	})

	describe("preventFocusDisruption (execute)", () => {
		function enableFocusDisruption() {
			mockCline.providerRef = {
				deref: () => ({
					getState: async () => ({
						diagnosticsEnabled: true,
						writeDelayMs: 1000,
						experiments: { preventFocusDisruption: true },
					}),
				}),
			}
		}

		it("writes a new file directly without opening the diff view", async () => {
			enableFocusDisruption()

			await executeWriteFileTool({}, { fileExists: false })

			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveDirectly).toHaveBeenCalledTimes(1)
			expect(mockCline.didEditFile).toBe(true)
		})

		it("reads the original content and writes directly for an existing file", async () => {
			enableFocusDisruption()

			await executeWriteFileTool({}, { fileExists: true })

			expect(mockedFsReadFile).toHaveBeenCalled()
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveDirectly).toHaveBeenCalledTimes(1)
		})

		it("omits diffStats in the focus path when the diff yields no stats", async () => {
			enableFocusDisruption()
			mockedCreatePrettyPatch.mockReturnValueOnce("")

			await executeWriteFileTool({}, { fileExists: true })

			const payload = JSON.parse(String(mockAskApproval.mock.calls[0][1]))
			expect(payload.diffStats).toBeUndefined()
		})

		it("writes nothing and does not revert when the user rejects (focus path)", async () => {
			enableFocusDisruption()
			mockAskApproval.mockResolvedValue(false)

			await executeWriteFileTool({}, { fileExists: false })

			expect(mockCline.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.revertChanges).not.toHaveBeenCalled()
		})
	})

	describe("partial streaming edge cases", () => {
		it("returns early (no diff view) in partial when preventFocusDisruption is enabled", async () => {
			mockCline.providerRef = {
				deref: () => ({
					getState: async () => ({ experiments: { preventFocusDisruption: true } }),
				}),
			}

			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })

			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
			expect(mockCline.diffViewProvider.update).not.toHaveBeenCalled()
		})

		it("partial uses the cached editType and skips the filesystem check", async () => {
			mockCline.diffViewProvider.editType = "modify"

			await executeWriteFileTool({}, { isPartial: true })
			await executeWriteFileTool({}, { isPartial: true })

			expect(mockedFileExistsAtPath).not.toHaveBeenCalled()
			const lastAsk = mockCline.ask.mock.calls[mockCline.ask.mock.calls.length - 1]
			expect(JSON.parse(lastAsk[1]).tool).toBe("editedExistingFile")
		})

		it("partial detects an existing file and marks it as an edit", async () => {
			await executeWriteFileTool({}, { isPartial: true, fileExists: true })
			await executeWriteFileTool({}, { isPartial: true, fileExists: true })

			expect(mockCline.diffViewProvider.editType).toBe("modify")
			const lastAsk = mockCline.ask.mock.calls[mockCline.ask.mock.calls.length - 1]
			expect(JSON.parse(lastAsk[1]).tool).toBe("editedExistingFile")
		})

		it("partial with empty content skips opening the diff view and reports empty content", async () => {
			await executeWriteFileTool({ content: "" }, { isPartial: true })
			await executeWriteFileTool({ content: "" }, { isPartial: true })

			const lastAsk = mockCline.ask.mock.calls[mockCline.ask.mock.calls.length - 1]
			expect(JSON.parse(lastAsk[1]).content).toBe("")
			expect(mockCline.diffViewProvider.open).not.toHaveBeenCalled()
		})

		it("partial strips line numbers when every line is numbered", async () => {
			mockedEveryLineHasLineNumbers.mockReturnValue(true)
			mockedStripLineNumbers.mockReturnValue("clean content")

			await executeWriteFileTool({ content: "1 | a\n2 | b" }, { isPartial: true })
			await executeWriteFileTool({ content: "1 | a\n2 | b" }, { isPartial: true })

			expect(mockCline.diffViewProvider.update).toHaveBeenCalledWith("clean content", false)
		})
	})
})
