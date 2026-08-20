import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { type WebviewMessage } from "@openai-agent/types"

import { t } from "../../i18n"
import { openFile } from "../../integrations/misc/open-file"
import { openImage, saveImage } from "../../integrations/misc/image-handler"
import { selectImages } from "../../integrations/misc/process-images"
import { searchWorkspaceFiles } from "../../services/search/file-search"
import { fileExistsAtPath } from "../../utils/fs"
import { searchCommits } from "../../utils/git"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { AgentIgnoreController } from "../ignore/AgentIgnoreController"
import { openMention } from "../mentions"

import { generateErrorDiagnostics } from "./diagnosticsHandler"
import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * ファイル / エディタ操作関連の webview メッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。webview からの
 * 「開く・読む・保存する・探す」をエディタ側（VS Code API と integrations/ 配下の
 * ヘルパー）へ振り分ける層で、タスクの状態そのものは持たない。
 *
 * 相対パスの解決基準は「実行中タスクの cwd → provider の cwd」の順。切り出し前は
 * switch 前段のローカルクロージャ getCurrentCwd がこれを担っていたため、
 * ここでは resolveCurrentCwd として同じ規則を再定義している。
 */
type FileEditorMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

/** 失敗時のログ整形。catch した値のプロパティを全て拾う（Error 以外も来るため）。 */
const formatError = (error: unknown): string => JSON.stringify(error, Object.getOwnPropertyNames(error), 2)

/** catch した値から表示用メッセージを取り出す（Error 以外も来るため）。 */
const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 実行中タスクがあればその cwd、無ければ provider の cwd。 */
const resolveCurrentCwd = (provider: WebviewMessageHost): string => provider.getCurrentTask()?.cwd || provider.cwd

/**
 * openDebugApiHistory / openDebugUiHistory は元の switch でフォールスルーして
 * 同じ本体を共有していたので、1 つの関数を両方のキーに割り当てる。
 * どちらの履歴を開くかは原文どおり message.type で分岐する。
 */
const openDebugHistory: FileEditorMessageHandler = async (provider, message) => {
	const currentTask = provider.getCurrentTask()
	if (!currentTask) {
		vscode.window.showErrorMessage("No active task to view history for")
		return
	}

	try {
		const { getTaskDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, currentTask.taskId)

		const fileName = message.type === "openDebugApiHistory" ? "api_conversation_history.json" : "ui_messages.json"
		const sourceFilePath = path.join(taskDirPath, fileName)

		// Check if file exists
		if (!(await fileExistsAtPath(sourceFilePath))) {
			vscode.window.showErrorMessage(`File not found: ${fileName}`)
			return
		}

		// Read the source file
		const content = await fs.readFile(sourceFilePath, "utf8")
		let jsonContent: unknown

		try {
			jsonContent = JSON.parse(content)
		} catch {
			vscode.window.showErrorMessage(`Failed to parse ${fileName}`)
			return
		}

		// Prettify the JSON
		const prettifiedContent = JSON.stringify(jsonContent, null, 2)

		// Create a temporary file
		const tmpDir = os.tmpdir()
		const timestamp = Date.now()
		const tempFileName = `roo-debug-${message.type === "openDebugApiHistory" ? "api" : "ui"}-${currentTask.taskId.slice(0, 8)}-${timestamp}.json`
		const tempFilePath = path.join(tmpDir, tempFileName)

		await fs.writeFile(tempFilePath, prettifiedContent, "utf8")

		// Open the temp file in VS Code
		const doc = await vscode.workspace.openTextDocument(tempFilePath)
		await vscode.window.showTextDocument(doc, { preview: true })
	} catch (error) {
		const errorMessage = toErrorMessage(error)
		provider.log(`Error opening debug history: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to open debug history: ${errorMessage}`)
	}
}

export const fileEditorMessageHandlers: Partial<Record<WebviewMessage["type"], FileEditorMessageHandler>> = {
	openFile: async (provider, message) => {
		let filePath: string = message.text!
		if (!path.isAbsolute(filePath)) {
			filePath = path.join(resolveCurrentCwd(provider), filePath)
		}
		openFile(filePath, message.values as { create?: boolean; content?: string; line?: number })
	},

	readFileContent: async (provider, message) => {
		const relPath = message.text || ""
		if (!relPath) {
			provider.postMessageToWebview({
				type: "fileContent",
				fileContent: { path: relPath, content: null, error: "No path provided" },
			})
			return
		}
		try {
			const cwd = resolveCurrentCwd(provider)
			if (!cwd) {
				provider.postMessageToWebview({
					type: "fileContent",
					fileContent: { path: relPath, content: null, error: "No workspace path available" },
				})
				return
			}
			const absPath = path.resolve(cwd, relPath)
			// Workspace-boundary validation: prevent path traversal attacks
			if (isPathOutsideWorkspace(absPath)) {
				provider.postMessageToWebview({
					type: "fileContent",
					fileContent: { path: relPath, content: null, error: "Path is outside workspace" },
				})
				return
			}
			const content = await fs.readFile(absPath, "utf-8")
			provider.postMessageToWebview({ type: "fileContent", fileContent: { path: relPath, content } })
		} catch (err) {
			const errorMsg = toErrorMessage(err)
			provider.postMessageToWebview({
				type: "fileContent",
				fileContent: { path: relPath, content: null, error: errorMsg },
			})
		}
	},

	openMention: async (provider, message) => {
		openMention(resolveCurrentCwd(provider), message.text)
	},

	openExternal: async (_provider, message) => {
		if (!message.url) {
			return
		}

		vscode.env.openExternal(vscode.Uri.parse(message.url))
	},

	openImage: async (_provider, message) => {
		openImage(message.text!, { values: message.values })
	},

	saveImage: async (provider, message) => {
		if (!message.dataUri) {
			return
		}

		const matches = message.dataUri.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/)
		if (!matches) {
			// Let saveImage handle invalid URI error
			saveImage(message.dataUri, vscode.Uri.file(""))
			return
		}
		const format = matches[1]
		const defaultFileName = `img_${Date.now()}.${format}`

		const defaultUri = await resolveDefaultSaveUri(provider.contextProxy, "lastImageSavePath", defaultFileName, {
			useWorkspace: false,
			fallbackDir: path.join(os.homedir(), "Downloads"),
		})

		const savedUri = await saveImage(message.dataUri, defaultUri)

		if (savedUri) {
			await saveLastExportPath(provider.contextProxy, "lastImageSavePath", savedUri)
		}
	},

	selectImages: async (provider, message) => {
		const images = await selectImages()
		await provider.postMessageToWebview({
			type: "selectedImages",
			images,
			context: message.context,
			messageTs: message.messageTs,
		})
	},

	openMarkdownPreview: async (provider, message) => {
		if (!message.text) {
			return
		}

		try {
			const tmpDir = os.tmpdir()
			const timestamp = Date.now()
			const tempFileName = `roo-preview-${timestamp}.md`
			const tempFilePath = path.join(tmpDir, tempFileName)

			await fs.writeFile(tempFilePath, message.text, "utf8")

			const doc = await vscode.workspace.openTextDocument(tempFilePath)
			await vscode.commands.executeCommand("markdown.showPreview", doc.uri)
		} catch (error) {
			const errorMessage = toErrorMessage(error)
			provider.log(`Error opening markdown preview: ${errorMessage}`)
			vscode.window.showErrorMessage(`Failed to open markdown preview: ${errorMessage}`)
		}
	},

	openKeyboardShortcuts: async (_provider, message) => {
		// Open VSCode keyboard shortcuts settings and optionally filter to show the Agent commands
		const searchQuery = message.text || ""
		if (searchQuery) {
			// Open with a search query pre-filled
			await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", searchQuery)
		} else {
			// Just open the keyboard shortcuts settings
			await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings")
		}
	},

	insertTextIntoTextarea: async (provider, message) => {
		const text = message.text
		if (!text) {
			return
		}

		// Send message to insert text into the chat textarea
		await provider.postMessageToWebview({
			type: "insertTextIntoTextarea",
			text: text,
		})
	},

	searchCommits: async (provider, message) => {
		const cwd = resolveCurrentCwd(provider)
		if (!cwd) {
			return
		}

		try {
			const commits = await searchCommits(message.query || "", cwd)
			await provider.postMessageToWebview({
				type: "commitSearchResults",
				commits,
			})
		} catch (error) {
			provider.log(`Error searching commits: ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.search_commits"))
		}
	},

	searchFiles: async (provider, message) => {
		const workspacePath = resolveCurrentCwd(provider)

		if (!workspacePath) {
			// Handle case where workspace path is not available
			await provider.postMessageToWebview({
				type: "fileSearchResults",
				results: [],
				requestId: message.requestId,
				error: "No workspace path available",
			})
			return
		}
		try {
			// Call file search service with query from message
			const results = await searchWorkspaceFiles(
				message.query || "",
				workspacePath,
				20, // Use default limit, as filtering is now done in the backend
			)

			// Get the AgentIgnoreController from the current task, or create a new one
			const currentTask = provider.getCurrentTask()
			let rooIgnoreController = currentTask?.rooIgnoreController
			let tempController: AgentIgnoreController | undefined

			// If no current task or no controller, create a temporary one
			if (!rooIgnoreController) {
				tempController = new AgentIgnoreController(workspacePath)
				await tempController.initialize()
				rooIgnoreController = tempController
			}

			try {
				// Get showAgentIgnoredFiles setting from state
				const { showAgentIgnoredFiles = false } = (await provider.getState()) ?? {}

				// Filter results using AgentIgnoreController if showAgentIgnoredFiles is false
				let filteredResults = results
				if (!showAgentIgnoredFiles && rooIgnoreController) {
					const allowedPaths = rooIgnoreController.filterPaths(results.map((r) => r.path))
					filteredResults = results.filter((r) => allowedPaths.includes(r.path))
				}

				// Send results back to webview
				await provider.postMessageToWebview({
					type: "fileSearchResults",
					results: filteredResults,
					requestId: message.requestId,
				})
			} finally {
				// Dispose temporary controller to prevent resource leak
				tempController?.dispose()
			}
		} catch (error) {
			const errorMessage = toErrorMessage(error)

			// Send error response to webview
			await provider.postMessageToWebview({
				type: "fileSearchResults",
				results: [],
				error: errorMessage,
				requestId: message.requestId,
			})
		}
	},

	openDebugApiHistory: openDebugHistory,
	openDebugUiHistory: openDebugHistory,

	downloadErrorDiagnostics: async (provider, message) => {
		const currentTask = provider.getCurrentTask()
		if (!currentTask) {
			vscode.window.showErrorMessage("No active task to generate diagnostics for")
			return
		}

		await generateErrorDiagnostics({
			taskId: currentTask.taskId,
			globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
			values: message.values,
			log: (msg) => provider.log(msg),
		})
	},
}
