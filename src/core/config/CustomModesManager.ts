import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"

import * as yaml from "yaml"

import { type ModeConfig, type PromptComponent, customModesSettingsSchema, modeConfigSchema } from "@openai-agent/types"

import { fileExistsAtPath } from "../../utils/fs"
import { getWorkspacePath } from "../../utils/path"
import { getGlobalAgentDirectory } from "../../services/agent-config"
import { logger } from "../../utils/logging"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { ensureSettingsDirectoryExists } from "../../utils/globalContext"
import { t } from "../../i18n"

import { mergeCustomModes } from "./customModesMerge"
import { applyPromptOverrides } from "./modePromptOverrides"
import { resolveModeRulesDir, resolveRuleFileTarget, type ModeScope } from "./modeRulesPaths"
import { parseModesYaml } from "./modeYaml"
import { TtlCache } from "./TtlCache"
import { WriteQueue } from "./WriteQueue"

const AGENTMODES_FILENAME = ".agentmodes"

// Type definitions for import/export functionality
interface RuleFile {
	relativePath: string
	content: string
}

interface ExportedModeConfig extends ModeConfig {
	rulesFiles?: RuleFile[]
}

interface ImportData {
	customModes: ExportedModeConfig[]
}

interface ExportResult {
	success: boolean
	yaml?: string
	error?: string
}

interface ImportResult {
	success: boolean
	slug?: string
	error?: string
}

export class CustomModesManager {
	private static readonly cacheTTL = 10_000

	private disposables: vscode.Disposable[] = []
	private readonly writeQueue = new WriteQueue()
	private readonly modesCache = new TtlCache<ModeConfig[]>(CustomModesManager.cacheTTL)

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onUpdate: () => Promise<void>,
	) {
		this.watchCustomModesFiles().catch((error) => {
			console.error("[CustomModesManager] Failed to setup file watchers:", error)
		})
	}

	private async getWorkspaceAgentmodes(): Promise<string | undefined> {
		const workspaceFolders = vscode.workspace.workspaceFolders

		if (!workspaceFolders || workspaceFolders.length === 0) {
			return undefined
		}

		const workspaceRoot = getWorkspacePath()
		const agentmodesPath = path.join(workspaceRoot, AGENTMODES_FILENAME)
		const exists = await fileExistsAtPath(agentmodesPath)
		return exists ? agentmodesPath : undefined
	}

	/**
	 * YAML をパースし、失敗したらログ + (`.agentmodes` のみ) ユーザー通知して `{}` を返す。
	 * パース規則自体は `modeYaml.ts` の純関数側にある。
	 */
	private parseYamlSafely(content: string, filePath: string): any {
		const isAgentmodes = filePath.endsWith(AGENTMODES_FILENAME)
		const result = parseModesYaml(content, { allowJsonFallback: isAgentmodes })

		if (result.ok) {
			return result.value
		}

		this.lastLoadFailed = true
		console.error(`[CustomModesManager] Failed to parse YAML from ${filePath}:`, result.message)

		if (isAgentmodes) {
			vscode.window.showErrorMessage(t("common:customModes.errors.yamlParseError", { line: result.line }))
		}

		// Return empty object to prevent duplicate error handling
		return {}
	}

	/**
	 * 直近の読み込みで、YAML パース失敗・スキーマ違反・I/O 失敗のいずれかが起きたか。
	 *
	 * 失敗時は customModes が `[]` に落ちるが、これは「カスタムモードが 1 件も無い」
	 * 状態と区別が付かない。保存済み mode slug の解決側がこの 2 つを取り違えると、
	 * 制限付きモードが既定モード（全権限）へ黙って昇格する。
	 */
	public hasLoadError(): boolean {
		return this.lastLoadFailed
	}

	private lastLoadFailed = false

	private async loadModesFromFile(filePath: string): Promise<ModeConfig[]> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			const settings = this.parseYamlSafely(content, filePath)

			// Ensure settings has customModes property
			if (!settings || typeof settings !== "object" || !settings.customModes) {
				return []
			}

			const result = customModesSettingsSchema.safeParse(settings)

			if (!result.success) {
				this.lastLoadFailed = true
				console.error(`[CustomModesManager] Schema validation failed for ${filePath}:`, result.error)

				// Show user-friendly error for .agentmodes files
				if (filePath.endsWith(AGENTMODES_FILENAME)) {
					const issues = result.error.issues
						.map((issue) => `• ${issue.path.join(".")}: ${issue.message}`)
						.join("\n")

					vscode.window.showErrorMessage(t("common:customModes.errors.schemaValidationError", { issues }))
				}

				return []
			}

			// Determine source based on file path
			const isAgentmodes = filePath.endsWith(AGENTMODES_FILENAME)
			const source = isAgentmodes ? ("project" as const) : ("global" as const)

			// Add source to each mode
			return result.data.customModes.map((mode) => ({ ...mode, source }))
		} catch (error) {
			this.lastLoadFailed = true

			// Only log if the error wasn't already handled in parseYamlSafely
			if (!(error as any).alreadyHandled) {
				const errorMsg = `Failed to load modes from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
				console.error(`[CustomModesManager] ${errorMsg}`)
			}
			return []
		}
	}

	public async getCustomModesFilePath(): Promise<string> {
		const settingsDir = await ensureSettingsDirectoryExists(this.context)
		const filePath = path.join(settingsDir, GlobalFileNames.customModes)
		const fileExists = await fileExistsAtPath(filePath)

		if (!fileExists) {
			await this.writeQueue.enqueue(() =>
				fs.writeFile(filePath, yaml.stringify({ customModes: [] }, { lineWidth: 0 })),
			)
		}

		return filePath
	}

	/**
	 * settings YAML と `.agentmodes` の両方を読んでマージ規則を適用した結果を返す。
	 * 「読み込み」「watcher 由来の再構築」「書き込み後の再構築」の 3 経路が共有する。
	 */
	private async loadMergedModes(): Promise<ModeConfig[]> {
		this.lastLoadFailed = false

		const settingsPath = await this.getCustomModesFilePath()
		const agentmodesPath = await this.getWorkspaceAgentmodes()

		const settingsModes = await this.loadModesFromFile(settingsPath)
		const agentmodesModes = agentmodesPath ? await this.loadModesFromFile(agentmodesPath) : []

		return mergeCustomModes(agentmodesModes, settingsModes)
	}

	/**
	 * マージ済みの mode 一覧を「確定」させる: globalState へ反映 → キャッシュ破棄 → 購読者へ通知。
	 * この 3 手はセットでしか意味を持たないので必ずここを通す（分割前は 4 箇所に重複していた）。
	 */
	private async publishModes(modes: ModeConfig[]): Promise<void> {
		await this.context.globalState.update("customModes", modes)
		this.modesCache.clear()
		await this.onUpdate()
	}

	private async watchCustomModesFiles(): Promise<void> {
		// Skip if test environment is detected
		if (process.env.NODE_ENV === "test") {
			return
		}

		const settingsPath = await this.getCustomModesFilePath()

		// Watch settings file
		const settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPath)

		const handleSettingsChange = async () => {
			try {
				// Ensure that the settings file exists (especially important for delete events)
				await this.getCustomModesFilePath()
				const content = await fs.readFile(settingsPath, "utf-8")

				const errorMessage = t("common:customModes.errors.invalidFormat")

				let config: any

				try {
					config = this.parseYamlSafely(content, settingsPath)
				} catch (error) {
					console.error(error)
					vscode.window.showErrorMessage(errorMessage)
					return
				}

				const result = customModesSettingsSchema.safeParse(config)

				if (!result.success) {
					vscode.window.showErrorMessage(errorMessage)
					return
				}

				// Get modes from .agentmodes if it exists (takes precedence)
				const agentmodesPath = await this.getWorkspaceAgentmodes()
				const agentmodesModes = agentmodesPath ? await this.loadModesFromFile(agentmodesPath) : []

				// 検証済みの settings 側 mode を使うのでここだけ loadMergedModes を通さない。
				await this.publishModes(mergeCustomModes(agentmodesModes, result.data.customModes))
			} catch (error) {
				console.error(`[CustomModesManager] Error handling settings file change:`, error)
			}
		}

		this.disposables.push(settingsWatcher.onDidChange(handleSettingsChange))
		this.disposables.push(settingsWatcher.onDidCreate(handleSettingsChange))
		this.disposables.push(settingsWatcher.onDidDelete(handleSettingsChange))
		this.disposables.push(settingsWatcher)

		// Watch .agentmodes file - watch the path even if it doesn't exist yet
		const workspaceFolders = vscode.workspace.workspaceFolders
		if (workspaceFolders && workspaceFolders.length > 0) {
			const workspaceRoot = getWorkspacePath()
			const agentmodesPath = path.join(workspaceRoot, AGENTMODES_FILENAME)
			const agentmodesWatcher = vscode.workspace.createFileSystemWatcher(agentmodesPath)

			// 変更も削除も「両ファイルを読み直してマージし直す」で足りる。削除後は
			// getWorkspaceAgentmodes() が undefined を返すので settings 側だけが残る。
			const handleAgentmodesChange = async () => {
				try {
					await this.refreshMergedState()
				} catch (error) {
					console.error(`[CustomModesManager] Error handling .agentmodes file change:`, error)
				}
			}

			this.disposables.push(agentmodesWatcher.onDidChange(handleAgentmodesChange))
			this.disposables.push(agentmodesWatcher.onDidCreate(handleAgentmodesChange))
			this.disposables.push(agentmodesWatcher.onDidDelete(handleAgentmodesChange))
			this.disposables.push(agentmodesWatcher)
		}
	}

	public async getCustomModes(): Promise<ModeConfig[]> {
		const cached = this.modesCache.get()

		if (cached) {
			return cached
		}

		const mergedModes = await this.loadMergedModes()

		await this.context.globalState.update("customModes", mergedModes)
		this.modesCache.set(mergedModes)

		return mergedModes
	}

	public async updateCustomMode(slug: string, config: ModeConfig): Promise<void> {
		try {
			// Validate the mode configuration before saving
			const validationResult = modeConfigSchema.safeParse(config)
			if (!validationResult.success) {
				const errorMessages = validationResult.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join(", ")
				const errorMessage = `Invalid mode configuration: ${errorMessages}`
				logger.error("Mode validation failed", { slug, errors: validationResult.error.errors })
				vscode.window.showErrorMessage(t("common:customModes.errors.updateFailed", { error: errorMessage }))
				throw new Error(errorMessage)
			}

			const isProjectMode = config.source === "project"
			let targetPath: string

			if (isProjectMode) {
				const workspaceFolders = vscode.workspace.workspaceFolders

				if (!workspaceFolders || workspaceFolders.length === 0) {
					logger.error("Failed to update project mode: No workspace folder found", { slug })
					throw new Error(t("common:customModes.errors.noWorkspaceForProject"))
				}

				const workspaceRoot = getWorkspacePath()
				targetPath = path.join(workspaceRoot, AGENTMODES_FILENAME)
				const exists = await fileExistsAtPath(targetPath)

				logger.info(`${exists ? "Updating" : "Creating"} project mode in ${AGENTMODES_FILENAME}`, {
					slug,
					workspace: workspaceRoot,
				})
			} else {
				targetPath = await this.getCustomModesFilePath()
			}

			await this.writeQueue.enqueue(async () => {
				// Ensure source is set correctly based on target file.
				const modeWithSource = {
					...config,
					source: isProjectMode ? ("project" as const) : ("global" as const),
				}

				await this.updateModesInFile(targetPath, (modes) => {
					const updatedModes = modes.filter((m) => m.slug !== slug)
					updatedModes.push(modeWithSource)
					return updatedModes
				})

				this.modesCache.clear()
				await this.refreshMergedState()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to update custom mode", { slug, error: errorMessage })
			vscode.window.showErrorMessage(t("common:customModes.errors.updateFailed", { error: errorMessage }))
			throw error
		}
	}

	private async updateModesInFile(filePath: string, operation: (modes: ModeConfig[]) => ModeConfig[]): Promise<void> {
		let content = "{}"

		try {
			content = await fs.readFile(filePath, "utf-8")
		} catch (_error) {
			// File might not exist yet.
			content = yaml.stringify({ customModes: [] }, { lineWidth: 0 })
		}

		let settings

		try {
			settings = this.parseYamlSafely(content, filePath)
		} catch (_error) {
			// Error already logged in parseYamlSafely
			settings = { customModes: [] }
		}

		// Ensure settings is an object and has customModes property
		if (!settings || typeof settings !== "object") {
			settings = { customModes: [] }
		}
		if (!settings.customModes) {
			settings.customModes = []
		}

		settings.customModes = operation(settings.customModes)
		await fs.writeFile(filePath, yaml.stringify(settings, { lineWidth: 0 }), "utf-8")
	}

	private async refreshMergedState(): Promise<void> {
		await this.publishModes(await this.loadMergedModes())
	}

	public async deleteCustomMode(slug: string): Promise<void> {
		try {
			const settingsPath = await this.getCustomModesFilePath()
			const agentmodesPath = await this.getWorkspaceAgentmodes()

			const settingsModes = await this.loadModesFromFile(settingsPath)
			const agentmodesModes = agentmodesPath ? await this.loadModesFromFile(agentmodesPath) : []

			// Find the mode in either file
			const projectMode = agentmodesModes.find((m) => m.slug === slug)
			const globalMode = settingsModes.find((m) => m.slug === slug)

			if (!projectMode && !globalMode) {
				throw new Error(t("common:customModes.errors.modeNotFound"))
			}

			// Determine which mode to use for rules folder path calculation
			const modeToDelete = projectMode || globalMode

			await this.writeQueue.enqueue(async () => {
				// Delete from project first if it exists there
				if (projectMode && agentmodesPath) {
					await this.updateModesInFile(agentmodesPath, (modes) => modes.filter((m) => m.slug !== slug))
				}

				// Delete from global settings if it exists there
				if (globalMode) {
					await this.updateModesInFile(settingsPath, (modes) => modes.filter((m) => m.slug !== slug))
				}

				// Delete associated rules folder
				if (modeToDelete) {
					await this.deleteRulesFolder(slug, modeToDelete)
				}

				// Clear cache when modes are deleted
				this.modesCache.clear()
				await this.refreshMergedState()
			})
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(t("common:customModes.errors.deleteFailed", { error: errorMessage }))
		}
	}

	/** mode の rules フォルダの絶対パス。project scope でワークスペースが無ければ undefined。 */
	private modeRulesDir(slug: string, scope: ModeScope): string | undefined {
		return resolveModeRulesDir({
			slug,
			scope,
			workspacePath: getWorkspacePath(),
			globalAgentDir: getGlobalAgentDirectory(),
		})
	}

	/**
	 * Deletes the rules folder for a specific mode
	 * @param slug - The mode slug
	 * @param mode - The mode configuration to determine the scope
	 */
	private async deleteRulesFolder(slug: string, mode: ModeConfig): Promise<void> {
		try {
			const rulesFolderPath = this.modeRulesDir(slug, mode.source || "global")

			if (!rulesFolderPath) {
				return // No workspace, can't delete project rules
			}

			// Check if the rules folder exists and delete it
			const rulesFolderExists = await fileExistsAtPath(rulesFolderPath)
			if (rulesFolderExists) {
				try {
					await fs.rm(rulesFolderPath, { recursive: true, force: true })
					logger.info(`Deleted rules folder for mode ${slug}: ${rulesFolderPath}`)
				} catch (error) {
					logger.error(`Failed to delete rules folder for mode ${slug}: ${error}`)
					// Notify the user about the failure
					vscode.window.showWarningMessage(
						t("common:customModes.errors.rulesCleanupFailed", { rulesFolderPath }),
					)
					// Continue even if folder deletion fails
				}
			}
		} catch (error) {
			logger.error(`Error deleting rules folder for mode ${slug}`, {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	public async resetCustomModes(): Promise<void> {
		try {
			const filePath = await this.getCustomModesFilePath()
			await fs.writeFile(filePath, yaml.stringify({ customModes: [] }, { lineWidth: 0 }))
			await this.context.globalState.update("customModes", [])
			this.modesCache.clear()
			await this.onUpdate()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(t("common:customModes.errors.resetFailed", { error: errorMessage }))
		}
	}

	/**
	 * `.agentmodes` を直接読んで slug 一致の mode を探す。getCustomModes() のマージ結果に
	 * 載っていない mode（組み込み mode を project で上書きしただけの場合など）を拾うための
	 * フォールバック経路。読めない・壊れている・見つからない、はすべて undefined。
	 */
	private async findModeInAgentmodesFile(slug: string): Promise<ModeConfig | undefined> {
		const workspacePath = getWorkspacePath()

		if (!workspacePath) {
			return undefined
		}

		try {
			const agentmodesPath = path.join(workspacePath, AGENTMODES_FILENAME)

			if (!(await fileExistsAtPath(agentmodesPath))) {
				return undefined
			}

			const agentmodesData = yaml.parse(await fs.readFile(agentmodesPath, "utf-8"))
			const agentmodesModes: ModeConfig[] = agentmodesData?.customModes || []

			return agentmodesModes.find((m) => m.slug === slug)
		} catch (_error) {
			return undefined
		}
	}

	/**
	 * rules フォルダ直下の「中身が空でないファイル」を列挙する。ディレクトリが無い/壊れている
	 * 場合は空配列（呼び出し側はどちらも「rules 無し」として扱う）。
	 *
	 * 途中で読めないファイルに当たった場合はそこまでに集めた分を返す（export の従来動作）。
	 */
	private async readRulesFiles(rulesDir: string): Promise<RuleFile[]> {
		const files: RuleFile[] = []

		try {
			const stats = await fs.stat(rulesDir)

			if (!stats.isDirectory()) {
				return files
			}

			const entries = await fs.readdir(rulesDir, { withFileTypes: true })

			for (const entry of entries) {
				if (!entry.isFile()) {
					continue
				}

				// Use path.join with rulesDir and entry.name for compatibility
				const filePath = path.join(rulesDir, entry.name)
				const content = await fs.readFile(filePath, "utf-8")

				if (!content.trim()) {
					continue
				}

				// rules-{slug} フォルダ自体はパスに含めない。Windows でも同じ形にするため
				// 区切りを "/" に正規化する。
				const relativePath = path.relative(rulesDir, filePath).replace(/\\/g, "/")
				files.push({ relativePath, content: content.trim() })
			}
		} catch (_error) {
			// Directory doesn't exist / unreadable — mode might simply have no rules.
		}

		return files
	}

	/**
	 * Checks if a mode has associated rules files in the .agent/rules-{slug}/ directory
	 * @param slug - The mode identifier to check
	 * @returns True if the mode has rules files with content, false otherwise
	 */
	public async checkRulesDirectoryHasContent(slug: string): Promise<boolean> {
		try {
			// First, find the mode to determine its source
			const allModes = await this.getCustomModes()
			const mode = allModes.find((m) => m.slug === slug)

			// カスタム mode に無ければ .agentmodes を直接見る。そこにも無ければ「どこにも無い」。
			// 見つかった場合も scope は project 固定（fallback 側の source は見ない従来動作）。
			if (!mode && !(await this.findModeInAgentmodesFile(slug))) {
				return false
			}

			const modeRulesDir = this.modeRulesDir(slug, mode?.source === "global" ? "global" : "project")

			if (!modeRulesDir) {
				return false
			}

			return (await this.readRulesFiles(modeRulesDir)).length > 0
		} catch (error) {
			logger.error("Failed to check rules directory for mode", {
				slug,
				error: error instanceof Error ? error.message : String(error),
			})
			return false
		}
	}

	/**
	 * Exports a mode configuration with its associated rules files into a shareable YAML format
	 * @param slug - The mode identifier to export
	 * @param customPrompts - Optional custom prompts to merge into the export
	 * @returns Success status with YAML content or error message
	 */
	public async exportModeWithRules(slug: string, customPrompts?: PromptComponent): Promise<ExportResult> {
		try {
			// Import modes from shared to check built-in modes
			const { modes: builtInModes } = await import("../../shared/modes")

			// Get all current modes
			const allModes = await this.getCustomModes()
			let mode = allModes.find((m) => m.slug === slug)

			// If mode not found in custom modes, check if it's a built-in mode that has been customized
			if (!mode) {
				mode = await this.findModeInAgentmodesFile(slug)

				// If still not found, check if it's a built-in mode
				if (!mode) {
					const builtInMode = builtInModes.find((m) => m.slug === slug)
					if (builtInMode) {
						// Use the built-in mode as the base
						mode = { ...builtInMode }
					} else {
						return { success: false, error: "Mode not found" }
					}
				}
			}

			const modeRulesDir = this.modeRulesDir(slug, mode.source === "global" ? "global" : "project")

			if (!modeRulesDir) {
				return { success: false, error: "No workspace found" }
			}

			const rulesFiles = await this.readRulesFiles(modeRulesDir)

			// Create an export mode with rules files preserved, then layer the user's overrides on top.
			const exportMode: ExportedModeConfig = applyPromptOverrides(
				{
					...mode,
					// Remove source property for export
					source: "project" as const,
				},
				customPrompts,
			)

			// Add rules files if any exist
			if (rulesFiles.length > 0) {
				exportMode.rulesFiles = rulesFiles
			}

			// Generate YAML
			const exportData = {
				customModes: [exportMode],
			}

			const yamlContent = yaml.stringify(exportData)

			return { success: true, yaml: yamlContent }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to export mode with rules", { slug, error: errorMessage })
			return { success: false, error: errorMessage }
		}
	}

	/**
	 * Helper method to import rules files for a mode
	 * @param importMode - The mode being imported
	 * @param rulesFiles - The rules files to import
	 * @param source - The import source ("global" or "project")
	 */
	private async importRulesFiles(
		importMode: ExportedModeConfig,
		rulesFiles: RuleFile[],
		source: "global" | "project",
	): Promise<void> {
		const rulesFolderPath = this.modeRulesDir(importMode.slug, source)

		if (!rulesFolderPath) {
			return
		}

		// Always remove the existing rules folder for this mode if it exists
		// This ensures that if the imported mode has no rules, the folder is cleaned up
		try {
			await fs.rm(rulesFolderPath, { recursive: true, force: true })
			logger.info(`Removed existing ${source} rules folder for mode ${importMode.slug}`)
		} catch (_error) {
			// It's okay if the folder doesn't exist
			logger.debug(`No existing ${source} rules folder to remove for mode ${importMode.slug}`)
		}

		// Only proceed with file creation if there are rules files to import
		if (!rulesFiles || !Array.isArray(rulesFiles) || rulesFiles.length === 0) {
			return
		}

		// Import the new rules files with path validation
		for (const ruleFile of rulesFiles) {
			if (!ruleFile.relativePath || !ruleFile.content) {
				continue
			}

			const target = resolveRuleFileTarget(rulesFolderPath, ruleFile.relativePath)

			if (!target.ok) {
				// Skip this file but continue with others
				logger.error(
					target.reason === "invalid-path"
						? `Invalid file path detected: ${ruleFile.relativePath}`
						: `Path traversal attempt detected: ${ruleFile.relativePath}`,
				)
				continue
			}

			if (target.strippedLegacyPrefix) {
				logger.info(`Detected old export format, stripping ${target.strippedLegacyPrefix} from path`)
			}

			await fs.mkdir(path.dirname(target.targetPath), { recursive: true })
			await fs.writeFile(target.targetPath, ruleFile.content, "utf-8")
		}
	}

	/**
	 * Imports modes from YAML content, including their associated rules files
	 * @param yamlContent - The YAML content containing mode configurations
	 * @param source - Target level for import: "global" (all projects) or "project" (current workspace only)
	 * @returns Success status with optional error message
	 */
	public async importModeWithRules(
		yamlContent: string,
		source: "global" | "project" = "project",
	): Promise<ImportResult> {
		try {
			// Parse the YAML content with proper type validation
			let importData: ImportData
			try {
				const parsed = yaml.parse(yamlContent)

				// Validate the structure
				if (!parsed?.customModes || !Array.isArray(parsed.customModes) || parsed.customModes.length === 0) {
					return { success: false, error: "Invalid import format: Expected 'customModes' array in YAML" }
				}

				importData = parsed as ImportData
			} catch (parseError) {
				return {
					success: false,
					error: `Invalid YAML format: ${parseError instanceof Error ? parseError.message : "Failed to parse YAML"}`,
				}
			}

			// Check workspace availability early if importing at project level
			if (source === "project") {
				const workspacePath = getWorkspacePath()
				if (!workspacePath) {
					return { success: false, error: "No workspace found" }
				}
			}

			// Process each mode in the import
			for (const importMode of importData.customModes) {
				const { rulesFiles, ...modeConfig } = importMode

				// Validate the mode configuration
				const validationResult = modeConfigSchema.safeParse(modeConfig)
				if (!validationResult.success) {
					logger.error(`Invalid mode configuration for ${modeConfig.slug}`, {
						errors: validationResult.error.errors,
					})
					return {
						success: false,
						error: `Invalid mode configuration for ${modeConfig.slug}: ${validationResult.error.errors.map((e) => e.message).join(", ")}`,
					}
				}

				// Check for existing mode conflicts
				const existingModes = await this.getCustomModes()
				const existingMode = existingModes.find((m) => m.slug === importMode.slug)
				if (existingMode) {
					logger.info(`Overwriting existing mode: ${importMode.slug}`)
				}

				// Import the mode configuration with the specified source
				await this.updateCustomMode(importMode.slug, {
					...modeConfig,
					source: source, // Use the provided source parameter
				})

				// Import rules files (this also handles cleanup of existing rules folders)
				await this.importRulesFiles(importMode, rulesFiles || [], source)
			}

			// Refresh the modes after import
			await this.refreshMergedState()

			// Return the imported mode's slug so the UI can activate it
			return { success: true, slug: importData.customModes[0]?.slug }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			logger.error("Failed to import mode with rules", { error: errorMessage })
			return { success: false, error: errorMessage }
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose()
		}

		this.disposables = []
	}
}
