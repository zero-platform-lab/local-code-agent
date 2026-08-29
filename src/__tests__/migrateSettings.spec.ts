import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { fileExistsAtPath } from "../utils/fs"
import { GlobalFileNames } from "../shared/globalFileNames"
import { migrateSettings } from "../utils/migrateSettings"

// Mock dependencies
vitest.mock("vscode")
vitest.mock("fs/promises", () => ({
	mkdir: vitest.fn().mockResolvedValue(undefined),
	readFile: vitest.fn(),
	writeFile: vitest.fn().mockResolvedValue(undefined),
	rename: vitest.fn().mockResolvedValue(undefined),
	unlink: vitest.fn().mockResolvedValue(undefined),
}))
vitest.mock("fs")
vitest.mock("../utils/fs")

describe("Settings Migration", () => {
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	const mockStoragePath = "/mock/storage"
	const mockSettingsDir = path.join(mockStoragePath, "settings")

	// Legacy file names
	const legacyMcpSettingsPath = path.join(mockSettingsDir, "cline_mcp_settings.json")

	// New file names
	const newMcpSettingsPath = path.join(mockSettingsDir, GlobalFileNames.mcpSettings)

	beforeEach(() => {
		vitest.clearAllMocks()

		// Mock output channel
		mockOutputChannel = {
			appendLine: vitest.fn(),
			append: vitest.fn(),
			clear: vitest.fn(),
			show: vitest.fn(),
			hide: vitest.fn(),
			dispose: vitest.fn(),
		} as unknown as vscode.OutputChannel

		// Mock extension context
		mockContext = {
			globalStorageUri: { fsPath: mockStoragePath },
		} as unknown as vscode.ExtensionContext

		// Set global outputChannel for all tests
		;(global as any).outputChannel = mockOutputChannel
	})

	it("should migrate MCP settings file if old file exists and new file doesn't", async () => {
		// Clear all previous mocks to ensure clean test environment
		vitest.clearAllMocks()

		// Setup mock for rename function
		const mockRename = vitest.mocked(fs.rename).mockResolvedValue(undefined)

		// Ensure the other files don't interfere with this test
		vitest.mocked(fileExistsAtPath).mockImplementation(async (path: string) => {
			if (path === mockSettingsDir) return true
			if (path === legacyMcpSettingsPath) return true
			return false // All other paths don't exist, including destination files
		})

		// Run the migration
		await migrateSettings(mockContext, mockOutputChannel)

		// Verify expected rename call
		expect(mockRename).toHaveBeenCalledWith(legacyMcpSettingsPath, newMcpSettingsPath)
	})

	it("should not migrate if new file already exists", async () => {
		// Clear all previous mocks to ensure clean test environment
		vitest.clearAllMocks()

		// Setup mock for rename function
		const mockRename = vitest.mocked(fs.rename).mockResolvedValue(undefined)

		// Mock file existence checks - both source and destination exist
		vitest.mocked(fileExistsAtPath).mockImplementation(async (path: string) => {
			if (path === mockSettingsDir) return true
			if (path === legacyMcpSettingsPath) return true
			if (path === newMcpSettingsPath) return true
			return false
		})

		await migrateSettings(mockContext, mockOutputChannel)

		// Verify rename was not called since destination files exist
		expect(mockRename).not.toHaveBeenCalled()
	})

	it("should handle errors gracefully", async () => {
		// Clear mocks
		vitest.clearAllMocks()

		// Mock file existence to throw error
		vitest.mocked(fileExistsAtPath).mockRejectedValue(new Error("Test error"))

		await migrateSettings(mockContext, mockOutputChannel)

		// Verify error was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Error migrating settings files"),
		)
	})
})
