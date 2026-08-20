// npx vitest core/prompts/__tests__/responses-agentignore.spec.ts

import type { Mock } from "vitest"

import { formatResponse } from "../responses"
import { AgentIgnoreController, LOCK_TEXT_SYMBOL } from "../../ignore/AgentIgnoreController"
import { fileExistsAtPath } from "../../../utils/fs"
import * as fs from "fs/promises"
import { toPosix } from "./utils"

// Mock dependencies
vi.mock("../../../utils/fs")
vi.mock("fs/promises")
vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	return {
		workspace: {
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
		},
		RelativePattern: vi.fn(),
	}
})

describe("AgentIgnore Response Formatting", () => {
	const TEST_CWD = "/test/path"
	let mockFileExists: Mock<typeof fileExistsAtPath>
	let mockReadFile: Mock<typeof fs.readFile>

	beforeEach(() => {
		// Reset mocks
		vi.clearAllMocks()

		// Setup fs mocks
		mockFileExists = fileExistsAtPath as Mock<typeof fileExistsAtPath>
		mockReadFile = fs.readFile as Mock<typeof fs.readFile>

		// Default mock implementations
		mockFileExists.mockResolvedValue(true)
		mockReadFile.mockResolvedValue("node_modules\n.git\nsecrets/**\n*.log")
	})

	describe("formatResponse.agentIgnoreError", () => {
		/**
		 * Tests the error message format for ignored files
		 */
		it("should format error message for ignored files", () => {
			const errorMessage = formatResponse.agentIgnoreError("secrets/api-keys.json")

			// Verify error message format (JSON)
			const parsed = JSON.parse(errorMessage) as any
			expect(parsed.status).toBe("error")
			expect(parsed.type).toBe("access_denied")
			expect(parsed.path).toBe("secrets/api-keys.json")
			expect(parsed.suggestion).toContain("continue without this file")
			expect(parsed.suggestion).toContain("update the .agentignore file")
		})

		/**
		 * Tests with different file paths
		 */
		it("should include the file path in the error message", () => {
			const paths = ["node_modules/package.json", ".git/HEAD", "secrets/credentials.env", "logs/app.log"]

			// Test each path
			for (const testPath of paths) {
				const errorMessage = formatResponse.agentIgnoreError(testPath)
				const parsed = JSON.parse(errorMessage) as any
				expect(parsed.path).toBe(testPath)
			}
		})
	})

	describe("formatResponse.formatFilesList with AgentIgnoreController", () => {
		/**
		 * Tests file listing with agentignore controller
		 */
		it("should format files list with lock symbols for ignored files", async () => {
			// Create controller
			const controller = new AgentIgnoreController(TEST_CWD)
			await controller.initialize()

			// Mock validateAccess to control which files are ignored
			controller.validateAccess = vi.fn().mockImplementation((filePath: string) => {
				// Only allow files not matching these patterns
				return (
					!filePath.includes("node_modules") &&
					!filePath.includes(".git") &&
					!toPosix(filePath).includes("secrets/")
				)
			})

			// Files list with mixed allowed/ignored files
			const files = [
				"src/app.ts", // allowed
				"node_modules/package.json", // ignored
				"README.md", // allowed
				".git/HEAD", // ignored
				"secrets/keys.json", // ignored
			]

			// Format with controller
			const result = formatResponse.formatFilesList(TEST_CWD, files, false, controller as any, true)

			// Should contain each file
			expect(result).toContain("src/app.ts")
			expect(result).toContain("README.md")

			// Should contain lock symbols for ignored files - case insensitive check using regex
			expect(result).toMatch(new RegExp(`${LOCK_TEXT_SYMBOL}.*node_modules/package.json`, "i"))
			expect(result).toMatch(new RegExp(`${LOCK_TEXT_SYMBOL}.*\\.git/HEAD`, "i"))
			expect(result).toMatch(new RegExp(`${LOCK_TEXT_SYMBOL}.*secrets/keys.json`, "i"))

			// No lock symbols for allowed files
			expect(result).not.toContain(`${LOCK_TEXT_SYMBOL} src/app.ts`)
			expect(result).not.toContain(`${LOCK_TEXT_SYMBOL} README.md`)
		})

		/**
		 * Tests formatFilesList when showAgentIgnoredFiles is set to false
		 */
		it("should hide ignored files when showAgentIgnoredFiles is false", async () => {
			// Create controller
			const controller = new AgentIgnoreController(TEST_CWD)
			await controller.initialize()

			// Mock validateAccess to control which files are ignored
			controller.validateAccess = vi.fn().mockImplementation((filePath: string) => {
				// Only allow files not matching these patterns
				return (
					!filePath.includes("node_modules") &&
					!filePath.includes(".git") &&
					!toPosix(filePath).includes("secrets/")
				)
			})

			// Files list with mixed allowed/ignored files
			const files = [
				"src/app.ts", // allowed
				"node_modules/package.json", // ignored
				"README.md", // allowed
				".git/HEAD", // ignored
				"secrets/keys.json", // ignored
			]

			// Format with controller and showAgentIgnoredFiles = false
			const result = formatResponse.formatFilesList(
				TEST_CWD,
				files,
				false,
				controller as any,
				false, // showAgentIgnoredFiles = false
			)

			// Should contain allowed files
			expect(result).toContain("src/app.ts")
			expect(result).toContain("README.md")

			// Should NOT contain ignored files (even with lock symbols)
			expect(result).not.toContain("node_modules/package.json")
			expect(result).not.toContain(".git/HEAD")
			expect(result).not.toContain("secrets/keys.json")

			// Double-check with regex to ensure no form of these filenames appears
			expect(result).not.toMatch(/node_modules\/package\.json/i)
			expect(result).not.toMatch(/\.git\/HEAD/i)
			expect(result).not.toMatch(/secrets\/keys\.json/i)
		})

		/**
		 * Tests formatFilesList handles truncation correctly with AgentIgnoreController
		 */
		it("should handle truncation with AgentIgnoreController", async () => {
			// Create controller
			const controller = new AgentIgnoreController(TEST_CWD)
			await controller.initialize()

			// Format with controller and truncation flag
			const result = formatResponse.formatFilesList(
				TEST_CWD,
				["file1.txt", "file2.txt"],
				true, // didHitLimit = true
				controller as any,
				true,
			)

			// Should contain truncation message (case-insensitive check)
			expect(result).toContain("File list truncated")
			expect(result).toMatch(/use list_files on specific subdirectories/i)
		})

		/**
		 * Tests formatFilesList handles empty results
		 */
		it("should handle empty file list with AgentIgnoreController", async () => {
			// Create controller
			const controller = new AgentIgnoreController(TEST_CWD)
			await controller.initialize()

			// Format with empty files array
			const result = formatResponse.formatFilesList(TEST_CWD, [], false, controller as any, true)

			// Should show "No files found"
			expect(result).toBe("No files found.")
		})
	})

	describe("getInstructions", () => {
		/**
		 * Tests the instructions format
		 */
		it("should format .agentignore instructions for the LLM", async () => {
			// Create controller
			const controller = new AgentIgnoreController(TEST_CWD)
			await controller.initialize()

			// Get instructions
			const instructions = controller.getInstructions()

			// Verify format and content
			expect(instructions).toContain("# .agentignore")
			expect(instructions).toContain(LOCK_TEXT_SYMBOL)
			expect(instructions).toContain("node_modules")
			expect(instructions).toContain(".git")
			expect(instructions).toContain("secrets/**")
			expect(instructions).toContain("*.log")

			// Should explain what the lock symbol means
			expect(instructions).toContain("you'll notice a")
			expect(instructions).toContain("next to files that are blocked")
		})

		/**
		 * Tests null/undefined case
		 */
		it("should return undefined when no .agentignore exists", async () => {
			// Set up no .agentignore
			mockFileExists.mockResolvedValue(false)

			// Create controller without .agentignore
			const controller = new AgentIgnoreController(TEST_CWD)
			await controller.initialize()

			// Should return undefined
			expect(controller.getInstructions()).toBeUndefined()
		})
	})
})
