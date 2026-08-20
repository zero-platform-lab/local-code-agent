import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { type Command as SlashCommand, type WebviewMessage } from "@openai-agent/types"

import { t } from "../../i18n"
import { openFile } from "../../integrations/misc/open-file"
import { Package } from "../../shared/package"
import { defaultModeSlug } from "../../shared/modes"
import { isSafePathSegment } from "../../utils/pathUtils"

import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * スラッシュコマンド関連の webview メッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。コマンドファイルの
 * 探索・作成・削除と、許可 / 拒否コマンドリストの保存を担う。
 *
 * `allowedCommands` / `deniedCommands` はグローバル state と VSCode 設定の
 * 両方へ書く。webview は state を見るが、ユーザーが settings.json を直接編集する
 * 経路もあるため両方を同期させている。
 */
type CommandMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

/** 実行中タスクがあればその cwd、無ければ provider の cwd。 */
const resolveCurrentCwd = (provider: WebviewMessageHost): string => provider.getCurrentTask()?.cwd || provider.cwd

/**
 * コマンド探索に使う現在のモード。
 * 実行中タスクのモード → グローバル state のモード → 既定 の順に解決する。
 */
const resolveCurrentMode = async (provider: WebviewMessageHost): Promise<string> => {
	const currentTask = provider.getCurrentTask()

	if (currentTask) {
		try {
			return await currentTask.modeState.getMode()
		} catch (error) {
			provider.log(
				`Error resolving current task mode for command discovery: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)
		}
	}

	try {
		const state = await provider.getState()
		if (typeof state.mode === "string" && state.mode.length > 0) {
			return state.mode
		}
	} catch (error) {
		provider.log(
			`Error resolving global mode for command discovery: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
	}

	return defaultModeSlug
}

/**
 * webview に出すコマンド一覧。
 * ファイルベースのコマンドに加えて、現在のモードで使えるスキルも同じ一覧に混ぜる
 * （名前が衝突する場合はコマンド側を優先）。
 */
const getDiscoveredCommands = async (provider: WebviewMessageHost): Promise<SlashCommand[]> => {
	const { getCommands } = await import("../../services/command/commands")
	const commands = await getCommands(resolveCurrentCwd(provider))

	const commandList: SlashCommand[] = commands.map((command) => ({
		name: command.name,
		source: command.source,
		filePath: command.filePath,
		description: command.description,
		argumentHint: command.argumentHint,
	}))

	const existingCommandNames = new Set(commandList.map((command) => command.name))
	const skillsManager = provider.getSkillsManager()

	if (!skillsManager) {
		return commandList
	}

	const currentMode = await resolveCurrentMode(provider)
	const availableSkills = skillsManager.getSkillsForMode(currentMode)

	for (const skill of availableSkills) {
		if (existingCommandNames.has(skill.name)) {
			continue
		}

		existingCommandNames.add(skill.name)
		commandList.push({
			name: skill.name,
			source: skill.source,
			filePath: skill.path,
			description: skill.description,
		})
	}

	return commandList
}

/**
 * 文字列の配列だけを残す（webview から来る値の防御的な正規化）。
 *
 * 配列でなければ `undefined` を返す。以前は `[]` を返していたため、壊れたメッセージが
 * 1 通届くだけで allowedCommands / deniedCommands が黙って全消えしていた。
 * 「空にする」と「値が壊れている」は区別しないと、拒否リストが消えたことに誰も気づけない。
 */
const sanitizeCommandList = (commands: unknown): string[] | undefined =>
	Array.isArray(commands)
		? commands.filter((cmd): cmd is string => typeof cmd === "string" && cmd.trim().length > 0)
		: undefined

/** コマンド名をファイル名として使える形に整える。 */
const slugifyCommandName = (rawName: string): string => {
	let cleanFileName = rawName.trim()

	// Strip leading slash if present
	if (cleanFileName.startsWith("/")) {
		cleanFileName = cleanFileName.substring(1)
	}

	// Remove .md extension if present BEFORE slugification
	if (cleanFileName.toLowerCase().endsWith(".md")) {
		cleanFileName = cleanFileName.slice(0, -3)
	}

	// Slugify the command name: lowercase, replace spaces with dashes, remove special characters
	const commandName = cleanFileName
		.toLowerCase()
		.replace(/\s+/g, "-") // Replace spaces with dashes
		.replace(/[^a-z0-9-]/g, "") // Remove special characters except dashes
		.replace(/-+/g, "-") // Replace multiple dashes with single dash
		.replace(/^-|-$/g, "") // Remove leading/trailing dashes

	// Ensure we have a valid command name
	return commandName.length > 0 ? commandName : "new-command"
}

const fileExists = (filePath: string): Promise<boolean> =>
	fs
		.access(filePath)
		.then(() => true)
		.catch(() => false)

export const commandMessageHandlers: Partial<Record<WebviewMessage["type"], CommandMessageHandler>> = {
	allowedCommands: async (provider, message) => {
		// Validate and sanitize the commands array
		const validCommands = sanitizeCommandList(message.commands)

		// 壊れたメッセージで許可リストを空にしない（sanitizeCommandList のコメント参照）。
		if (!validCommands) {
			provider.log("allowedCommands: ignoring a message whose `commands` is not an array")
			return
		}

		await provider.contextProxy.setValue("allowedCommands", validCommands)

		// Also update workspace settings.
		await vscode.workspace
			.getConfiguration(Package.name)
			.update("allowedCommands", validCommands, vscode.ConfigurationTarget.Global)
	},

	deniedCommands: async (provider, message) => {
		// Validate and sanitize the commands array
		const validCommands = sanitizeCommandList(message.commands)

		// 拒否リストが黙って消えるのが一番まずい。配列でなければ何もしない。
		if (!validCommands) {
			provider.log("deniedCommands: ignoring a message whose `commands` is not an array")
			return
		}

		await provider.contextProxy.setValue("deniedCommands", validCommands)

		// Also update workspace settings.
		await vscode.workspace
			.getConfiguration(Package.name)
			.update("deniedCommands", validCommands, vscode.ConfigurationTarget.Global)
	},

	requestCommands: async (provider) => {
		try {
			const commandList = await getDiscoveredCommands(provider)
			await provider.postMessageToWebview({ type: "commands", commands: commandList })
		} catch (error) {
			provider.log(`Error fetching commands: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			await provider.postMessageToWebview({ type: "commands", commands: [] })
		}
	},

	openCommandFile: async (provider, message) => {
		try {
			if (message.text) {
				const { getCommand } = await import("../../services/command/commands")
				const command = await getCommand(resolveCurrentCwd(provider), message.text)

				if (command && command.filePath) {
					openFile(command.filePath)
				} else {
					vscode.window.showErrorMessage(t("common:errors.command_not_found", { name: message.text }))
				}
			}
		} catch (error) {
			provider.log(`Error opening command file: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.open_command_file"))
		}
	},

	deleteCommand: async (provider, message) => {
		try {
			if (message.text && message.values?.source) {
				// message.text は webview 由来で、getCommand が path.join(dir, `${name}.md`) を
				// 組む。セパレータや `..` を含む名前ならコマンドディレクトリの外の .md が
				// unlink される。パスを組む前で止める。
				if (!isSafePathSegment(message.text)) {
					provider.log(`deleteCommand: refusing an unsafe command name ${JSON.stringify(message.text)}`)
					vscode.window.showErrorMessage(t("common:errors.command_not_found", { name: message.text }))
					return
				}

				const { getCommand } = await import("../../services/command/commands")
				const command = await getCommand(resolveCurrentCwd(provider), message.text)

				if (command && command.filePath) {
					// Delete the command file
					await fs.unlink(command.filePath)
					provider.log(`Deleted command file: ${command.filePath}`)
				} else {
					vscode.window.showErrorMessage(t("common:errors.command_not_found", { name: message.text }))
				}
			}
		} catch (error) {
			provider.log(`Error deleting command: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.delete_command"))
		}
	},

	createCommand: async (provider, message) => {
		try {
			const source = message.values?.source as "global" | "project"
			const fileName = message.text // Custom filename from user input

			if (!source) {
				provider.log("Missing source for createCommand")
				return
			}

			// Determine the commands directory based on source
			let commandsDir: string
			if (source === "global") {
				commandsDir = path.join(os.homedir(), ".agent", "commands")
			} else {
				if (!vscode.workspace.workspaceFolders?.length) {
					vscode.window.showErrorMessage(t("common:errors.no_workspace"))
					return
				}
				// Project commands
				const workspaceRoot = resolveCurrentCwd(provider)
				if (!workspaceRoot) {
					vscode.window.showErrorMessage(t("common:errors.no_workspace_for_project_command"))
					return
				}
				commandsDir = path.join(workspaceRoot, ".agent", "commands")
			}

			// Ensure the commands directory exists
			await fs.mkdir(commandsDir, { recursive: true })

			// Use provided filename or generate a unique one
			let commandName: string
			if (fileName && fileName.trim()) {
				commandName = slugifyCommandName(fileName)
			} else {
				// Generate a unique command name
				commandName = "new-command"
				let counter = 1

				while (await fileExists(path.join(commandsDir, `${commandName}.md`))) {
					commandName = `new-command-${counter}`
					counter++
				}
			}

			const filePath = path.join(commandsDir, `${commandName}.md`)

			// Check if file already exists
			if (await fileExists(filePath)) {
				vscode.window.showErrorMessage(t("common:errors.command_already_exists", { commandName }))
				return
			}

			// Create the command file with template content
			const templateContent = t("common:errors.command_template_content")

			await fs.writeFile(filePath, templateContent, "utf8")
			provider.log(`Created new command file: ${filePath}`)

			// Open the new file in the editor
			openFile(filePath)

			// Refresh commands list
			const { getCommands } = await import("../../services/command/commands")
			const commands = await getCommands(resolveCurrentCwd(provider) || "")
			const commandList = commands.map((command) => ({
				name: command.name,
				source: command.source,
				filePath: command.filePath,
				description: command.description,
				argumentHint: command.argumentHint,
			}))
			await provider.postMessageToWebview({
				type: "commands",
				commands: commandList,
			})
		} catch (error) {
			provider.log(`Error creating command: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.create_command_failed"))
		}
	},
}
