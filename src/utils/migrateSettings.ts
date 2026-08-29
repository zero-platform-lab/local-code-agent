import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { fileExistsAtPath } from "./fs"
import { GlobalFileNames } from "../shared/globalFileNames"
import { getSettingsDirectoryPath } from "./storage"

/**
 * Migrates old settings files to new file names and removes commands from old defaults
 *
 * TODO: Remove this migration code in September 2025 (6 months after implementation)
 */
export async function migrateSettings(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	// First, migrate commands from old defaults (security fix)
	await migrateDefaultCommands(context, outputChannel)
	// Legacy file names that need to be migrated to the new names in GlobalFileNames
	const fileMigrations = [{ oldName: "cline_mcp_settings.json", newName: GlobalFileNames.mcpSettings }]

	try {
		const settingsDir = await getSettingsDirectoryPath(context.globalStorageUri.fsPath)

		// Check if settings directory exists first
		if (!(await fileExistsAtPath(settingsDir))) {
			outputChannel.appendLine("No settings directory found, no migrations necessary")
			return
		}

		// Process each file migration
		try {
			for (const migration of fileMigrations) {
				const oldPath = path.join(settingsDir, migration.oldName)
				const newPath = path.join(settingsDir, migration.newName)

				// Only migrate if old file exists and new file doesn't exist yet
				// This ensures we don't overwrite any existing new files
				const oldFileExists = await fileExistsAtPath(oldPath)
				const newFileExists = await fileExistsAtPath(newPath)

				if (oldFileExists && !newFileExists) {
					await fs.rename(oldPath, newPath)
					outputChannel.appendLine(`Renamed ${migration.oldName} to ${migration.newName}`)
				} else {
					outputChannel.appendLine(
						`Skipping migration of ${migration.oldName} to ${migration.newName}: ${oldFileExists ? "new file already exists" : "old file not found"}`,
					)
				}
			}
		} catch (error) {
			outputChannel.appendLine(`Error in file migrations: ${error}`)
		}
	} catch (error) {
		outputChannel.appendLine(`Error migrating settings files: ${error}`)
	}
}

/**
 * Removes commands from old defaults that could execute arbitrary code
 * This addresses the security vulnerability where npm install/test can run malicious postinstall scripts
 */
async function migrateDefaultCommands(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	try {
		// Check if this migration has already been run
		const migrationKey = "defaultCommandsMigrationCompleted"
		if (context.globalState.get(migrationKey)) {
			outputChannel.appendLine("[Default Commands Migration] Migration already completed, skipping")
			return
		}

		const allowedCommands = context.globalState.get<string[]>("allowedCommands")

		if (!allowedCommands || !Array.isArray(allowedCommands)) {
			// Mark migration as complete even if no commands to migrate
			await context.globalState.update(migrationKey, true)
			outputChannel.appendLine("No allowed commands found in global state, marking migration as complete")
			return
		}

		// Only migrate the specific commands that were removed from the defaults
		const oldDefaultCommands = ["npm install", "npm test", "tsc"]

		// Filter out old default commands (case-insensitive exact match only)
		const originalLength = allowedCommands.length
		const filteredCommands = allowedCommands.filter((cmd) => {
			const cmdLower = cmd.toLowerCase().trim()
			return !oldDefaultCommands.some((oldDefault) => cmdLower === oldDefault.toLowerCase())
		})

		if (filteredCommands.length < originalLength) {
			const removedCount = originalLength - filteredCommands.length
			await context.globalState.update("allowedCommands", filteredCommands)

			outputChannel.appendLine(
				`[Default Commands Migration] Removed ${removedCount} command(s) from old defaults to prevent arbitrary code execution vulnerability`,
			)
		} else {
			outputChannel.appendLine("[Default Commands Migration] No old default commands found in allowed list")
		}

		// Mark migration as complete
		await context.globalState.update(migrationKey, true)
		outputChannel.appendLine("[Default Commands Migration] Migration marked as complete")
	} catch (error) {
		outputChannel.appendLine(`[Default Commands Migration] Error migrating default commands: ${error}`)
	}
}
