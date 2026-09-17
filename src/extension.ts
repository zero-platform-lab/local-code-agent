import * as vscode from "vscode"
import * as dotenvx from "@dotenvx/dotenvx"
import * as fs from "fs"
import * as path from "path"

// Load environment variables from .env file
// The extension-level .env is optional (not shipped in production builds).
// Avoid calling dotenvx when the file doesn't exist, otherwise dotenvx emits
// a noisy [MISSING_ENV_FILE] error to the extension host console.
const envPath = path.join(__dirname, "..", ".env")
if (fs.existsSync(envPath)) {
	try {
		dotenvx.config({ path: envPath })
	} catch (e) {
		// Best-effort only: never fail extension activation due to optional env loading.
		console.warn("Failed to load environment variables:", e)
	}
}

import "./utils/path" // Necessary to have access to String.prototype.toPosix.
import { initializeNetworkProxy } from "./utils/networkProxy"

import { Package } from "./shared/package"
import { formatLanguage } from "./shared/language"
import { ContextProxy } from "./core/config/ContextProxy"
import { ClineProvider } from "./core/webview/ClineProvider"
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/DiffViewProvider"
import { TerminalRegistry } from "./integrations/terminal/TerminalRegistry"
import { McpServerManager } from "./services/mcp/McpServerManager"
import { CodeIndexManager } from "./services/code-index/manager"
import { autoImportSettings } from "./utils/autoImportSettings"
import { API } from "./extension/api"

import {
	registerCommands,
	registerCodeActions,
	registerPiiCommands,
	registerFileMappingCommands,
	registerTerminalActions,
	CodeActionProvider,
} from "./activate"
import { initializeI18n, t } from "./i18n"
import { sessionMapping } from "./services/pii/maskConversation"
import { FileMappingController, setFileMappingController } from "./services/pii/fileMapping"
import { DEFAULT_FILE_MAPPING_LIMITS } from "./services/pii/fileMappingStore"
import { piiMaskerFor } from "./core/webview/promptMessageHandlers"

/**
 * Built using https://github.com/microsoft/vscode-webview-ui-toolkit
 *
 * Inspired by:
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
 *  - https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra
 */

let outputChannel: vscode.OutputChannel
let extensionContext: vscode.ExtensionContext

/**
 * Check if we should auto-open the Agent sidebar after switching to a worktree.
 * This is called during extension activation to handle the worktree auto-open flow.
 */
async function checkWorktreeAutoOpen(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	try {
		const worktreeAutoOpenPath = context.globalState.get<string>("worktreeAutoOpenPath")
		if (!worktreeAutoOpenPath) {
			return
		}

		const workspaceFolders = vscode.workspace.workspaceFolders
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return
		}

		const currentPath = workspaceFolders[0].uri.fsPath

		// Normalize paths for comparison
		const normalizePath = (p: string) => p.replace(/\/+$/, "").replace(/\\+/g, "/").toLowerCase()

		// Check if current workspace matches the worktree path
		if (normalizePath(currentPath) === normalizePath(worktreeAutoOpenPath)) {
			// Clear the state first to prevent re-triggering
			await context.globalState.update("worktreeAutoOpenPath", undefined)

			outputChannel.appendLine(`[Worktree] Auto-opening Agent sidebar for worktree: ${worktreeAutoOpenPath}`)

			// Open the Agent sidebar with a slight delay to ensure UI is ready
			setTimeout(async () => {
				try {
					await vscode.commands.executeCommand(`${Package.name}.plusButtonClicked`)
				} catch (error) {
					outputChannel.appendLine(
						`[Worktree] Error auto-opening sidebar: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}, 500)
		}
	} catch (error) {
		outputChannel.appendLine(
			`[Worktree] Error checking worktree auto-open: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

// This method is called when your extension is activated.
// Your extension is activated the very first time the command is executed.
export async function activate(context: vscode.ExtensionContext) {
	extensionContext = context
	outputChannel = vscode.window.createOutputChannel(Package.outputChannel)
	context.subscriptions.push(outputChannel)
	outputChannel.appendLine(`${Package.name} extension activated - ${JSON.stringify(Package)}`)

	// Initialize network proxy configuration early, before any network requests.
	// When proxyUrl is configured, all HTTP/HTTPS traffic will be routed through it.
	// Only applied in debug mode (F5).
	await initializeNetworkProxy(context, outputChannel)

	// Initialize i18n for internationalization support.
	initializeI18n(context.globalState.get("language") ?? formatLanguage(vscode.env.language))

	// Initialize terminal shell execution handlers.
	TerminalRegistry.initialize()

	// Get default commands from configuration.
	const defaultCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>("allowedCommands") || []

	// Initialize global state if not already set.
	if (!context.globalState.get("allowedCommands")) {
		context.globalState.update("allowedCommands", defaultCommands)
	}

	const contextProxy = await ContextProxy.getInstance(context)

	// Initialize code index managers for all workspace folders.
	const codeIndexManagers: CodeIndexManager[] = []

	if (vscode.workspace.workspaceFolders) {
		for (const folder of vscode.workspace.workspaceFolders) {
			const manager = CodeIndexManager.getInstance(context, folder.uri.fsPath)

			if (manager) {
				codeIndexManagers.push(manager)

				// Initialize in background; do not block extension activation
				void manager.initialize(contextProxy).catch((error) => {
					const message = error instanceof Error ? error.message : String(error)
					outputChannel.appendLine(
						`[CodeIndexManager] Error during background CodeIndexManager configuration/indexing for ${folder.uri.fsPath}: ${message}`,
					)
				})

				context.subscriptions.push(manager)
			}
		}
	}

	const provider = new ClineProvider(context, outputChannel, "sidebar", contextProxy)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ClineProvider.sideBarId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// The view lives in the Secondary Side Bar (right), which is collapsed by default.
	// On first run, reveal it once so the chat appears on the right out of the box.
	if (!context.globalState.get("hasRevealedSidebar")) {
		void context.globalState.update("hasRevealedSidebar", true)
		void vscode.commands
			.executeCommand(`workbench.view.extension.${Package.name}-ActivityBar`)
			.then(undefined, () => {
				/* View container may not be ready yet; ignore. */
			})
	}

	// Check for worktree auto-open path (set when switching to a worktree)
	await checkWorktreeAutoOpen(context, outputChannel)

	// Auto-import configuration if specified in settings.
	try {
		await autoImportSettings(outputChannel, {
			providerSettingsManager: provider.providerSettingsManager,
			contextProxy: provider.contextProxy,
		})
	} catch (error) {
		outputChannel.appendLine(
			`[AutoImport] Error during auto-import: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	registerCommands({ context, outputChannel, provider })

	/**
	 * We use the text document content provider API to show the left side for diff
	 * view by creating a virtual document for the original content. This makes it
	 * readonly so users know to edit the right side if they want to keep their changes.
	 *
	 * This API allows you to create readonly documents in VSCode from arbitrary
	 * sources, and works by claiming an uri-scheme for which your provider then
	 * returns text contents. The scheme must be provided when registering a
	 * provider and cannot change afterwards.
	 *
	 * Note how the provider doesn't create uris for virtual documents - its role
	 * is to provide contents given such an uri. In return, content providers are
	 * wired into the open document logic so that providers are always considered.
	 *
	 * https://code.visualstudio.com/api/extension-guides/virtual-documents
	 */
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider),
	)

	// Register code actions provider.
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider({ pattern: "**/*" }, new CodeActionProvider(), {
			providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds,
		}),
	)

	registerCodeActions(context)
	registerTerminalActions(context)
	// 機密情報の伏せ字は編集中のファイルだけを見る。provider を必要としない。
	registerPiiCommands(
		context,
		() => contextProxy.getValue("piiMasking") ?? {},
		// 戻せるのは、いま動いているタスクで割り当てた伏せ字だけ（`FR-PII-20a`）。
		() => {
			// 明示的に戻す操作は、戻さない設定でも動かす（`FR-PII-20`）。戻さないまま
			// 進めて最後にまとめて戻すのが、この操作の使い道である。
			//
			// **会話が無くても戻せる（`FR-PII-20a`）。** 右クリックで伏せ、他の道具へ渡し、
			// 戻ってきてから元へ戻す使い方がある。会話が動いていることを条件にすると、
			// その間に会話を閉じただけで戻せなくなる。
			const task = provider.getCurrentTask()
			return task
				? (text: string) => task.restoreExplicitly(text)
				: (text: string) => sessionMapping().restore(text)
		},
		// ファイルの置き換えでも、会話と同じ番号の場所を使う。分けると同じ形の伏せ字が
		// 別の値を指す。
		() => provider.getCurrentTask()?.piiMasker.allocator ?? sessionMapping(),
		// **会話が無くても第 2 層を実行する（`FR-PII-11e`）。** 会話が動いているときだけに
		// すると、右クリックのファイルの置き換えでは人名がほとんど残る。第 1 層は敬称から
		// 人名を当てる規則を持たないので、辞書に書いた名前しか消えない。
		() => {
			const masker = piiMaskerFor(provider)
			return async (texts) => {
				const properNouns = await masker.properNounsFor(texts)
				// **理由をそのまま出す。** ここへ集まるのは辞書の失敗だけではない。第 2 層を
				// 動かせない配布物、読み込みの失敗、時間で切られたこと、の 3 つも来る。
				// 「辞書を読めませんでした」で包むと、辞書が正しいのに辞書を疑わせる。
				for (const trouble of masker.takeDictionaryTroubles()) {
					await vscode.window.showWarningMessage(t("common:pii.maskingTrouble", { detail: trouble }))
				}
				return properNouns
			}
		},
	)

	// ファイル対応表（ファイルごとの永続。`FR-PII-24`）。起動時の掃除と、移動・削除への追従を
	// 開始し、送信経路と右クリックが使う共有のコントローラとして 1 つだけ登録する。
	const fileMapping = new FileMappingController(context, {
		retentionDays: () => contextProxy.getValue("piiMasking")?.fileMapping?.retentionDays ?? 30,
		limits: () => {
			const settings = contextProxy.getValue("piiMasking")?.fileMapping
			return {
				maxFiles: settings?.maxFiles ?? DEFAULT_FILE_MAPPING_LIMITS.maxFiles,
				maxEntriesPerFile: settings?.maxEntriesPerFile ?? DEFAULT_FILE_MAPPING_LIMITS.maxEntriesPerFile,
				maxBytes: settings?.maxBytes ?? DEFAULT_FILE_MAPPING_LIMITS.maxBytes,
			}
		},
	})
	setFileMappingController(fileMapping)
	context.subscriptions.push(...fileMapping.start())
	registerFileMappingCommands(
		context,
		fileMapping,
		() => provider.getCurrentTask()?.piiMasker.allocator ?? sessionMapping(),
	)

	// Allows other extensions to activate once Agent is ready.
	vscode.commands.executeCommand(`${Package.name}.activationCompleted`)

	// Implements the `AgentAPI` interface.
	const socketPath = process.env.ROO_CODE_IPC_SOCKET_PATH
	const enableLogging = typeof socketPath === "string"

	// Watch the core files and automatically reload the extension host.
	if (process.env.NODE_ENV === "development") {
		const watchPaths = [
			{ path: context.extensionPath, pattern: "**/*.ts" },
			{ path: path.join(context.extensionPath, "../packages/types"), pattern: "**/*.ts" },
		]

		console.log(
			`♻️♻️♻️ Core auto-reloading: Watching for changes in ${watchPaths.map(({ path }) => path).join(", ")}`,
		)

		// Create a debounced reload function to prevent excessive reloads
		let reloadTimeout: NodeJS.Timeout | undefined
		const DEBOUNCE_DELAY = 1_000

		const debouncedReload = (uri: vscode.Uri) => {
			if (reloadTimeout) {
				clearTimeout(reloadTimeout)
			}

			console.log(`♻️ ${uri.fsPath} changed; scheduling reload...`)

			reloadTimeout = setTimeout(() => {
				console.log(`♻️ Reloading host after debounce delay...`)
				vscode.commands.executeCommand("workbench.action.reloadWindow")
			}, DEBOUNCE_DELAY)
		}

		watchPaths.forEach(({ path: watchPath, pattern }) => {
			const relPattern = new vscode.RelativePattern(vscode.Uri.file(watchPath), pattern)
			const watcher = vscode.workspace.createFileSystemWatcher(relPattern, false, false, false)

			// Listen to all change types to ensure symlinked file updates trigger reloads.
			watcher.onDidChange(debouncedReload)
			watcher.onDidCreate(debouncedReload)
			watcher.onDidDelete(debouncedReload)

			context.subscriptions.push(watcher)
		})

		// Clean up the timeout on deactivation
		context.subscriptions.push({
			dispose: () => {
				if (reloadTimeout) {
					clearTimeout(reloadTimeout)
				}
			},
		})
	}

	// Initialize background model cache refresh

	return new API(outputChannel, provider, socketPath, enableLogging)
}

// This method is called when your extension is deactivated.
export async function deactivate() {
	outputChannel.appendLine(`${Package.name} extension deactivated`)

	await McpServerManager.cleanup(extensionContext)
	TerminalRegistry.cleanup()
}
