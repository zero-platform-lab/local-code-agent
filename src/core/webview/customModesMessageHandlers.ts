import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { type WebviewMessage } from "@openai-agent/types"

import { t } from "../../i18n"
import { openFile } from "../../integrations/misc/open-file"
import { Mode, defaultModeSlug } from "../../shared/modes"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { fileExistsAtPath } from "../../utils/fs"
import { isSafePathSegment } from "../../utils/pathUtils"
import { getWorkspacePath } from "../../utils/path"

import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * カスタムモード関連の webview メッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。モードの CRUD は
 * CustomModesManager が持ち、ここはそれに加えてルールフォルダの削除、
 * YAML のエクスポート / インポート（ファイルダイアログを含む）を担う。
 */
type CustomModesMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * モードのルールフォルダのパスを決める。
 * project スコープはワークスペース直下、global スコープは OS のホーム直下。
 */
const resolveRulesFolderPath = (slug: string, scope: string): string => {
	// slug は webview 由来。`rules-` の接頭辞があってもセパレータを含む値は正規化で
	// 親へ抜ける（`rules-../../..` は 3 階層上）。ここが返すパスには
	// fs.rm(recursive, force) が飛ぶので、抜けた先はワークスペースごと黙って消える。
	// zod スキーマ（packages/types/src/mode.ts の slug 正規表現）でも弾いているが、
	// 検証を通らない経路が 1 つ増えるだけで復元不能な削除になるため、ここでも止める。
	if (!isSafePathSegment(slug)) {
		throw new Error(`Refusing to build a rules folder path for an unsafe mode slug: ${JSON.stringify(slug)}`)
	}

	if (scope === "project") {
		const workspacePath = getWorkspacePath()
		// ワークスペース未オープン時に相対パスを返すと、fs.rm が拡張ホストの cwd 基準で
		// 解決してしまい、どこが消えるかが実行環境依存になる。絶対パスにできないなら組まない。
		if (!workspacePath) {
			throw new Error("Refusing to build a relative rules folder path with no workspace open")
		}
		return path.join(workspacePath, ".agent", `rules-${slug}`)
	}

	return path.join(os.homedir(), ".agent", `rules-${slug}`)
}

export const customModesMessageHandlers: Partial<Record<WebviewMessage["type"], CustomModesMessageHandler>> = {
	openCustomModesSettings: async (provider) => {
		const customModesFilePath = await provider.customModesManager.getCustomModesFilePath()

		if (customModesFilePath) {
			openFile(customModesFilePath)
		}
	},

	mode: async (provider, message) => {
		await provider.handleModeSwitch(message.text as Mode)
	},

	hasOpenedModeSelector: async (provider, message) => {
		await provider.contextProxy.setValue("hasOpenedModeSelector", message.bool ?? true)
		await provider.postStateToWebview()
	},

	requestModes: async (provider) => {
		try {
			const modes = await provider.getModes()
			await provider.postMessageToWebview({ type: "modes", modes })
		} catch (error) {
			provider.log(`Error fetching modes: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			await provider.postMessageToWebview({ type: "modes", modes: [] })
		}
	},

	checkRulesDirectory: async (provider, message) => {
		if (!message.slug) {
			return
		}

		const hasContent = await provider.customModesManager.checkRulesDirectoryHasContent(message.slug)

		provider.postMessageToWebview({
			type: "checkRulesDirectoryResult",
			slug: message.slug,
			hasContent: hasContent,
		})
	},

	updateCustomMode: async (provider, message) => {
		if (!message.modeConfig) {
			return
		}

		try {
			await provider.customModesManager.updateCustomMode(message.modeConfig.slug, message.modeConfig)
			// Update state after saving the mode
			const customModes = await provider.customModesManager.getCustomModes()
			await provider.contextProxy.setValue("customModes", customModes)
			await provider.contextProxy.setValue("mode", message.modeConfig.slug)
			await provider.postStateToWebview()
		} catch {
			// Error already shown to user by updateCustomMode
			// Just prevent unhandled rejection and skip state updates
		}
	},

	deleteCustomMode: async (provider, message) => {
		if (!message.slug) {
			return
		}

		// Get the mode details to determine source and rules folder path
		const customModes = await provider.customModesManager.getCustomModes()
		const modeToDelete = customModes.find((mode) => mode.slug === message.slug)

		if (!modeToDelete) {
			return
		}

		// Determine the scope based on source (project or global)
		const rulesFolderPath = resolveRulesFolderPath(message.slug, modeToDelete.source || "global")

		// Check if the rules folder exists
		const rulesFolderExists = await fileExistsAtPath(rulesFolderPath)

		// If this is a check request, send back the folder info
		if (message.checkOnly) {
			await provider.postMessageToWebview({
				type: "deleteCustomModeCheck",
				slug: message.slug,
				rulesFolderPath: rulesFolderExists ? rulesFolderPath : undefined,
			})
			return
		}

		// Delete the mode
		await provider.customModesManager.deleteCustomMode(message.slug)

		// Delete the rules folder if it exists
		if (rulesFolderExists) {
			try {
				await fs.rm(rulesFolderPath, { recursive: true, force: true })
				provider.log(`Deleted rules folder for mode ${message.slug}: ${rulesFolderPath}`)
			} catch (error) {
				provider.log(`Failed to delete rules folder for mode ${message.slug}: ${error}`)
				// Notify the user about the failure
				vscode.window.showErrorMessage(
					t("common:errors.delete_rules_folder_failed", {
						rulesFolderPath,
						error: toErrorMessage(error),
					}),
				)
				// Continue with mode deletion even if folder deletion fails
			}
		}

		// Switch back to default mode after deletion
		await provider.contextProxy.setValue("mode", defaultModeSlug)
		await provider.postStateToWebview()
	},

	exportMode: async (provider, message) => {
		if (!message.slug) {
			return
		}

		try {
			// Get custom mode prompts to check if built-in mode has been customized
			const customModePrompts = provider.contextProxy.getValue("customModePrompts") || {}
			const customPrompt = customModePrompts[message.slug]

			// Export the mode with any customizations merged directly
			const result = await provider.customModesManager.exportModeWithRules(message.slug, customPrompt)

			if (!result.success || !result.yaml) {
				// Send error message to webview
				provider.postMessageToWebview({
					type: "exportModeResult",
					success: false,
					error: result.error,
					slug: message.slug,
				})
				return
			}

			const defaultUri = await resolveDefaultSaveUri(
				provider.contextProxy,
				"lastModeExportPath",
				`${message.slug}-export.yaml`,
				{
					useWorkspace: true,
					fallbackDir: path.join(os.homedir(), "Downloads"),
				},
			)

			// Show save dialog
			const saveUri = await vscode.window.showSaveDialog({
				defaultUri,
				filters: {
					"YAML files": ["yaml", "yml"],
				},
				title: "Save mode export",
			})

			if (!saveUri) {
				// User cancelled the save dialog
				provider.postMessageToWebview({
					type: "exportModeResult",
					success: false,
					error: "Export cancelled",
					slug: message.slug,
				})
				return
			}

			// Save the directory for next time
			await saveLastExportPath(provider.contextProxy, "lastModeExportPath", saveUri)

			// Write the file to the selected location
			await fs.writeFile(saveUri.fsPath, result.yaml, "utf-8")

			// Send success message to webview
			provider.postMessageToWebview({
				type: "exportModeResult",
				success: true,
				slug: message.slug,
			})

			// Show info message
			vscode.window.showInformationMessage(t("common:info.mode_exported", { mode: message.slug }))
		} catch (error) {
			const errorMessage = toErrorMessage(error)
			provider.log(`Failed to export mode ${message.slug}: ${errorMessage}`)

			// Send error message to webview
			provider.postMessageToWebview({
				type: "exportModeResult",
				success: false,
				error: errorMessage,
				slug: message.slug,
			})
		}
	},

	importMode: async (provider, message) => {
		try {
			// Get last used directory for import
			const lastImportPath = provider.contextProxy.getValue("lastModeImportPath")
			let defaultUri: vscode.Uri | undefined

			if (lastImportPath) {
				// Use the directory from the last import
				defaultUri = vscode.Uri.file(path.dirname(lastImportPath))
			} else {
				// Default to workspace or home directory
				const workspaceFolders = vscode.workspace.workspaceFolders
				if (workspaceFolders && workspaceFolders.length > 0) {
					defaultUri = vscode.Uri.file(workspaceFolders[0].uri.fsPath)
				}
			}

			// Show file picker to select YAML file
			const fileUri = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				defaultUri,
				filters: {
					"YAML files": ["yaml", "yml"],
				},
				title: "Select mode export file to import",
			})

			if (!fileUri || !fileUri[0]) {
				// User cancelled the file dialog - reset the importing state
				provider.postMessageToWebview({
					type: "importModeResult",
					success: false,
					error: "cancelled",
				})
				return
			}

			// Save the directory for next time
			await provider.contextProxy.setValue("lastModeImportPath", fileUri[0].fsPath)

			// Read the file content
			const yamlContent = await fs.readFile(fileUri[0].fsPath, "utf-8")

			// Import the mode with the specified source level
			const result = await provider.customModesManager.importModeWithRules(
				yamlContent,
				message.source || "project", // Default to project if not specified
			)

			if (result.success) {
				// Update state after importing
				const customModes = await provider.customModesManager.getCustomModes()
				await provider.contextProxy.setValue("customModes", customModes)
				await provider.postStateToWebview()

				// Send success message to webview, include the imported slug so UI can switch
				provider.postMessageToWebview({
					type: "importModeResult",
					success: true,
					slug: result.slug,
				})

				// Show success message
				vscode.window.showInformationMessage(t("common:info.mode_imported"))
			} else {
				// Send error message to webview
				provider.postMessageToWebview({
					type: "importModeResult",
					success: false,
					error: result.error,
				})

				// Show error message
				vscode.window.showErrorMessage(t("common:errors.mode_import_failed", { error: result.error }))
			}
		} catch (error) {
			const errorMessage = toErrorMessage(error)
			provider.log(`Failed to import mode: ${errorMessage}`)

			// Send error message to webview
			provider.postMessageToWebview({
				type: "importModeResult",
				success: false,
				error: errorMessage,
			})

			// Show error message
			vscode.window.showErrorMessage(t("common:errors.mode_import_failed", { error: errorMessage }))
		}
	},
}
