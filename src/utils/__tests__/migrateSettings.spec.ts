import * as vscode from "vscode"

import { migrateSettings } from "../migrateSettings"

// Mock vscode module
vi.mock("vscode", () => ({
	window: {
		showInformationMessage: vi.fn(),
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
		})),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}))

// Mock fs module
vi.mock("fs/promises")

// Mock fs utils
vi.mock("../fs", () => ({
	fileExistsAtPath: vi.fn(),
}))

// Mock yaml module
vi.mock("yaml", () => ({
	parse: vi.fn((content) => JSON.parse(content)),
	stringify: vi.fn((obj) => JSON.stringify(obj, null, 2)),
}))

describe("migrateSettings", () => {
	let mockContext: any
	let mockOutputChannel: any
	let mockGlobalState: Map<string, any>

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

		// Create a mock global state
		mockGlobalState = new Map()

		// Create mock output channel
		mockOutputChannel = {
			appendLine: vi.fn(),
		}

		// Create mock context
		mockContext = {
			globalState: {
				get: vi.fn((key: string) => mockGlobalState.get(key)),
				update: vi.fn(async (key: string, value: any) => {
					mockGlobalState.set(key, value)
				}),
			},
			globalStorageUri: {
				fsPath: "/mock/storage/path",
			},
		}
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("default commands migration", () => {
		it("should only run migration once", async () => {
			// Set up initial state with old default commands
			const initialCommands = ["npm install", "npm test", "tsc", "git log"]
			mockGlobalState.set("allowedCommands", initialCommands)

			// Mock file system
			const { fileExistsAtPath } = await import("../fs")
			vi.mocked(fileExistsAtPath).mockResolvedValue(false)

			// Run migration first time
			await migrateSettings(mockContext, mockOutputChannel)

			// Check that old default commands were removed
			expect(mockGlobalState.get("allowedCommands")).toEqual(["git log"])

			// Check that migration was marked as complete
			expect(mockContext.globalState.update).toHaveBeenCalledWith("defaultCommandsMigrationCompleted", true)

			// Reset mocks but keep the migration flag
			mockGlobalState.set("defaultCommandsMigrationCompleted", true)
			mockGlobalState.set("allowedCommands", ["npm install", "npm test"])
			vi.mocked(mockContext.globalState.update).mockClear()

			// Run migration again
			await migrateSettings(mockContext, mockOutputChannel)

			// Verify commands were NOT modified the second time
			expect(mockGlobalState.get("allowedCommands")).toEqual(["npm install", "npm test"])
			expect(mockContext.globalState.update).not.toHaveBeenCalled()
		})

		it("should remove npm install, npm test, and tsc from allowed commands", async () => {
			// Set up initial state with old default commands
			const initialCommands = ["git log", "npm install", "npm test", "tsc", "git diff", "echo hello"]
			mockGlobalState.set("allowedCommands", initialCommands)

			// Mock file system to indicate no settings directory exists
			const { fileExistsAtPath } = await import("../fs")
			vi.mocked(fileExistsAtPath).mockResolvedValue(false)

			// Run migration
			await migrateSettings(mockContext, mockOutputChannel)

			// Check that old default commands were removed
			const updatedCommands = mockGlobalState.get("allowedCommands")
			expect(updatedCommands).toEqual(["git log", "git diff", "echo hello"])

			// Verify the update was called
			expect(mockContext.globalState.update).toHaveBeenCalledWith("allowedCommands", [
				"git log",
				"git diff",
				"echo hello",
			])

			// Verify migration was marked as complete
			expect(mockContext.globalState.update).toHaveBeenCalledWith("defaultCommandsMigrationCompleted", true)

			// No notification should be shown
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		})

		it("should not remove commands with arguments (only exact matches)", async () => {
			// Set up initial state with commands that have arguments
			const initialCommands = [
				"npm install express",
				"npm test --coverage",
				"tsc --watch",
				"npm list",
				"npm view",
				"yarn list",
				"git status",
			]
			mockGlobalState.set("allowedCommands", initialCommands)

			// Mock file system
			const { fileExistsAtPath } = await import("../fs")
			vi.mocked(fileExistsAtPath).mockResolvedValue(false)

			// Run migration
			await migrateSettings(mockContext, mockOutputChannel)

			// Check that commands with arguments were NOT removed (only exact matches are removed)
			const updatedCommands = mockGlobalState.get("allowedCommands")
			expect(updatedCommands).toEqual([
				"npm install express",
				"npm test --coverage",
				"tsc --watch",
				"npm list",
				"npm view",
				"yarn list",
				"git status",
			])

			// Migration should still be marked as complete
			expect(mockContext.globalState.update).toHaveBeenCalledWith("defaultCommandsMigrationCompleted", true)

			// No notification should be shown
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		})

		it("should handle case-insensitive matching", async () => {
			// Set up initial state with mixed case commands
			const initialCommands = ["NPM INSTALL", "Npm Test", "TSC", "git log"]
			mockGlobalState.set("allowedCommands", initialCommands)

			// Mock file system
			const { fileExistsAtPath } = await import("../fs")
			vi.mocked(fileExistsAtPath).mockResolvedValue(false)

			// Run migration
			await migrateSettings(mockContext, mockOutputChannel)

			// Check that unsafe commands were removed regardless of case
			const updatedCommands = mockGlobalState.get("allowedCommands")
			expect(updatedCommands).toEqual(["git log"])
		})

		it("should not modify commands if no old defaults are present", async () => {
			// Set up initial state with only safe commands
			const initialCommands = ["git log", "git diff", "ls -la", "echo hello"]
			mockGlobalState.set("allowedCommands", initialCommands)

			// Mock file system
			const { fileExistsAtPath } = await import("../fs")
			vi.mocked(fileExistsAtPath).mockResolvedValue(false)

			// Run migration
			await migrateSettings(mockContext, mockOutputChannel)

			// Check that commands remain unchanged
			const updatedCommands = mockGlobalState.get("allowedCommands")
			expect(updatedCommands).toEqual(initialCommands)

			// Verify no notification was shown
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()

			// Verify migration was still marked as complete
			expect(mockContext.globalState.update).toHaveBeenCalledWith("defaultCommandsMigrationCompleted", true)
		})

		it("should handle missing or invalid allowedCommands gracefully", async () => {
			// Test with no allowedCommands set
			const { fileExistsAtPath } = await import("../fs")
			vi.mocked(fileExistsAtPath).mockResolvedValue(false)

			await migrateSettings(mockContext, mockOutputChannel)
			// Should still mark migration as complete
			expect(mockContext.globalState.update).toHaveBeenCalledWith("defaultCommandsMigrationCompleted", true)

			// Verify appropriate log messages
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("marking migration as complete"),
			)
		})

		it("should handle non-array allowedCommands gracefully", async () => {
			// Test with non-array value
			mockGlobalState.set("allowedCommands", "not an array")

			const { fileExistsAtPath } = await import("../fs")
			vi.mocked(fileExistsAtPath).mockResolvedValue(false)

			await migrateSettings(mockContext, mockOutputChannel)

			// Should still mark migration as complete
			expect(mockContext.globalState.update).toHaveBeenCalledWith("defaultCommandsMigrationCompleted", true)

			// Verify appropriate log messages
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("marking migration as complete"),
			)
		})

		it("should handle errors gracefully", async () => {
			// Set up state
			mockGlobalState.set("allowedCommands", ["npm install"])

			// Make update throw an error
			mockContext.globalState.update = vi.fn().mockRejectedValue(new Error("Update failed"))

			// Mock file system
			const { fileExistsAtPath } = await import("../fs")
			vi.mocked(fileExistsAtPath).mockResolvedValue(false)

			// Run migration - should not throw
			await expect(migrateSettings(mockContext, mockOutputChannel)).resolves.toBeUndefined()

			// Verify error was logged
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("[Default Commands Migration] Error"),
			)
		})

		it("should only remove exact matches, not commands with arguments", async () => {
			// Set up initial state with exact matches and commands with arguments
			const initialCommands = [
				"npm install", // exact match - should be removed
				"npm install --save-dev typescript", // has arguments - should NOT be removed
				"npm test", // exact match - should be removed
				"npm test --coverage", // has arguments - should NOT be removed
				"tsc", // exact match - should be removed
				"tsc --noEmit", // has arguments - should NOT be removed
				"git log --oneline",
			]
			mockGlobalState.set("allowedCommands", initialCommands)

			// Mock file system
			const { fileExistsAtPath } = await import("../fs")
			vi.mocked(fileExistsAtPath).mockResolvedValue(false)

			// Run migration
			await migrateSettings(mockContext, mockOutputChannel)

			// Check that only exact matches were removed
			const updatedCommands = mockGlobalState.get("allowedCommands")
			expect(updatedCommands).toEqual([
				"npm install --save-dev typescript",
				"npm test --coverage",
				"tsc --noEmit",
				"git log --oneline",
			])

			// No notification should be shown
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		})
	})

	describe("file migrations error paths", () => {
		it("ファイル移管中に rename が失敗すると内側 catch でログして握りつぶす", async () => {
			const fsPromises = await import("fs/promises")
			const { fileExistsAtPath } = await import("../fs")

			// settingsDir はある。cline_custom_modes.json → custom_modes.json は
			// 「旧あり・新なし」なので rename が走る。その rename を失敗させる。
			vi.mocked(fileExistsAtPath).mockImplementation(async (p: string) => {
				if (p.endsWith("cline_custom_modes.json")) return true
				return p.endsWith("/settings") || p.endsWith("\\settings")
			})
			vi.mocked((fsPromises as any).rename).mockRejectedValueOnce(new Error("rename boom"))

			await migrateSettings(mockContext, mockOutputChannel)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Error in file migrations"),
			)
		})

		it("custom_modes.json の読み込みが失敗すると YAML 変換の catch でログする", async () => {
			const fsPromises = await import("fs/promises")
			const { fileExistsAtPath } = await import("../fs")

			// rename 対象(cline_*)は無し。custom_modes.json はあり、YAML はまだ無い。
			vi.mocked(fileExistsAtPath).mockImplementation(async (p: string) => {
				if (p.endsWith("cline_custom_modes.json")) return false
				if (p.endsWith("cline_mcp_settings.json")) return false
				if (p.endsWith(".yaml")) return false
				if (p.endsWith("custom_modes.json")) return true
				return p.endsWith("/settings") || p.endsWith("\\settings")
			})
			// migrateCustomModesToYaml が readFile(oldJsonPath) で失敗 → 外側 catch。
			vi.mocked((fsPromises as any).readFile).mockRejectedValueOnce(new Error("read boom"))

			await migrateSettings(mockContext, mockOutputChannel)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Error reading custom_modes.json"),
			)
		})

		it("旧ファイルがあり新ファイルが無ければ rename して成功ログを出す", async () => {
			const fsPromises = await import("fs/promises")
			const { fileExistsAtPath } = await import("../fs")

			// cline_custom_modes.json（旧）はあり、custom_modes.json（新）は無い → rename 成功。
			// 以降の custom_modes.json は「無い」ままにして YAML 変換は早期 return させる。
			vi.mocked(fileExistsAtPath).mockImplementation(async (p: string) => {
				if (p.endsWith("cline_custom_modes.json")) return true
				return p.endsWith("/settings") || p.endsWith("\\settings")
			})
			vi.mocked((fsPromises as any).rename).mockResolvedValue(undefined)

			await migrateSettings(mockContext, mockOutputChannel)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Renamed cline_custom_modes.json to custom_modes.json"),
			)
		})

		it("旧・新の両方が存在すれば rename せず『new file already exists』でスキップする", async () => {
			const fsPromises = await import("fs/promises")
			const { fileExistsAtPath } = await import("../fs")

			// cline_custom_modes.json（旧）も custom_modes.json（新）も存在 → rename しない。
			vi.mocked(fileExistsAtPath).mockImplementation(async (p: string) => {
				if (p.endsWith("cline_custom_modes.json")) return true
				if (p.endsWith(".yaml")) return true // YAML もある扱いにして変換も走らせない
				if (p.endsWith("custom_modes.json")) return true
				return p.endsWith("/settings") || p.endsWith("\\settings")
			})

			await migrateSettings(mockContext, mockOutputChannel)

			expect((fsPromises as any).rename).not.toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("new file already exists"),
			)
		})

		it("settings ディレクトリ取得が失敗すると最外周 catch でログして握りつぶす", async () => {
			const fsPromises = await import("fs/promises")

			// getSettingsDirectoryPath 内の fs.mkdir を失敗させ、最外周の try/catch を通す。
			vi.mocked((fsPromises as any).mkdir).mockRejectedValueOnce(new Error("mkdir boom"))

			await expect(migrateSettings(mockContext, mockOutputChannel)).resolves.toBeUndefined()

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Error migrating settings files"),
			)
		})
	})

	describe("custom_modes.json → YAML 変換", () => {
		// migrateCustomModesToYaml へ到達させる共通条件:
		// settingsDir はあり、cline_* の移管対象は無し（rename を走らせない）。
		function baseExists(p: string): boolean | null {
			if (p.endsWith("cline_custom_modes.json")) return false
			if (p.endsWith("cline_mcp_settings.json")) return false
			return null // 個別判定に委ねる
		}

		it("json があり yaml が無ければ YAML を書き出して成功ログを出す", async () => {
			const fsPromises = await import("fs/promises")
			const yamlMod = await import("yaml")
			const { fileExistsAtPath } = await import("../fs")

			vi.mocked(fileExistsAtPath).mockImplementation(async (p: string) => {
				const b = baseExists(p)
				if (b !== null) return b
				if (p.endsWith(".yaml")) return false // YAML はまだ無い
				if (p.endsWith("custom_modes.json")) return true // JSON はある
				return p.endsWith("/settings") || p.endsWith("\\settings")
			})
			vi.mocked((fsPromises as any).readFile).mockResolvedValue('{"customModes":[{"slug":"a"}]}')
			vi.mocked((fsPromises as any).writeFile).mockResolvedValue(undefined)

			await migrateSettings(mockContext, mockOutputChannel)

			// yaml.parse → yaml.stringify → writeFile(custom_modes.yaml) が走る。
			expect(yamlMod.parse).toHaveBeenCalledWith('{"customModes":[{"slug":"a"}]}')
			expect(yamlMod.stringify).toHaveBeenCalled()
			expect((fsPromises as any).writeFile).toHaveBeenCalledWith(
				expect.stringContaining("custom_modes.yaml"),
				expect.any(String),
				"utf-8",
			)
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Successfully migrated custom_modes.json to YAML format"),
			)
		})

		it("yaml が既に存在すれば変換せずスキップログを出す", async () => {
			const fsPromises = await import("fs/promises")
			const { fileExistsAtPath } = await import("../fs")

			vi.mocked(fileExistsAtPath).mockImplementation(async (p: string) => {
				const b = baseExists(p)
				if (b !== null) return b
				if (p.endsWith(".yaml")) return true // YAML が既にある
				if (p.endsWith("custom_modes.json")) return true // JSON もある
				return p.endsWith("/settings") || p.endsWith("\\settings")
			})

			await migrateSettings(mockContext, mockOutputChannel)

			expect((fsPromises as any).writeFile).not.toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("custom_modes.yaml already exists, skipping migration"),
			)
		})

		it("json が無ければ変換をスキップする", async () => {
			const fsPromises = await import("fs/promises")
			const { fileExistsAtPath } = await import("../fs")

			vi.mocked(fileExistsAtPath).mockImplementation(async (p: string) => {
				const b = baseExists(p)
				if (b !== null) return b
				if (p.endsWith(".yaml")) return false
				if (p.endsWith("custom_modes.json")) return false // JSON が無い
				return p.endsWith("/settings") || p.endsWith("\\settings")
			})

			await migrateSettings(mockContext, mockOutputChannel)

			expect((fsPromises as any).readFile).not.toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("No custom_modes.json found, skipping YAML migration"),
			)
		})

		it("JSON パースに失敗すると parseError の catch でログし、書き込まない", async () => {
			const fsPromises = await import("fs/promises")
			const yamlMod = await import("yaml")
			const { fileExistsAtPath } = await import("../fs")

			vi.mocked(fileExistsAtPath).mockImplementation(async (p: string) => {
				const b = baseExists(p)
				if (b !== null) return b
				if (p.endsWith(".yaml")) return false
				if (p.endsWith("custom_modes.json")) return true
				return p.endsWith("/settings") || p.endsWith("\\settings")
			})
			vi.mocked((fsPromises as any).readFile).mockResolvedValue("{ broken json")
			vi.mocked(yamlMod.parse).mockImplementationOnce(() => {
				throw new Error("parse boom")
			})

			await migrateSettings(mockContext, mockOutputChannel)

			// 不変条件: パース失敗時は YAML を書かない（旧 JSON を保持）。
			expect((fsPromises as any).writeFile).not.toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Error parsing custom_modes.json"),
			)
		})
	})
})
