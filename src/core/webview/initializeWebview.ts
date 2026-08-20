import * as vscode from "vscode"

import { Terminal } from "../../integrations/terminal/Terminal"
import { getTheme } from "../../integrations/theme/getTheme"
import { setPanel } from "../../activate/webviewPanelRegistry"

import type { ExtensionMessage } from "@openai-agent/types"
import type { WebviewContentGenerator } from "./WebviewContentGenerator"
import type { CodeIndexStatusSubscriber } from "./CodeIndexStatusSubscriber"
import type { ContextProxy } from "../config/ContextProxy"
import type { Task } from "../task/Task"

/**
 * `ClineProvider.resolveWebviewView` から抽出した webview 初期化ロジック。
 *
 * 責務: panel 種別の判定 / terminal & TTS 設定の apply / webview options と HTML の
 * セットアップ / message listener と code index subscription / visibility & dispose
 * リスナ登録 / color theme 変更リスナ / 起動時 stale task cleanup。
 *
 * ClineProvider 側の resolveWebviewView は `await initializeWebview(this, webviewView)`
 * の 1 行 wrapper になる。host は ClineProvider が構造的に満たす narrow interface。
 */
export interface InitializeWebviewHost {
	view?: vscode.WebviewView | vscode.WebviewPanel
	readonly contextProxy: ContextProxy
	readonly webviewContent: WebviewContentGenerator
	readonly codeIndexStatus: CodeIndexStatusSubscriber
	webviewDisposables: vscode.Disposable[]
	disposables: vscode.Disposable[]
	getState(): Promise<Record<string, unknown>>
	postMessageToWebview(message: ExtensionMessage): Promise<unknown>
	setWebviewMessageListener(webview: vscode.Webview): void
	updateCodeIndexStatusSubscription(): void
	clearWebviewResources(): void
	getCurrentTask(): Task | undefined
	removeClineFromStack(options?: { skipDelegationRepair?: boolean }): Promise<void>
	log(message: string): void
	dispose(): Promise<void>
}

export async function initializeWebview(
	host: InitializeWebviewHost,
	webviewView: vscode.WebviewView | vscode.WebviewPanel,
): Promise<void> {
	host.view = webviewView
	const inTabMode = "onDidChangeViewState" in webviewView

	if (inTabMode) {
		setPanel(webviewView, "tab")
	} else if ("onDidChangeVisibility" in webviewView) {
		setPanel(webviewView, "sidebar")
	}

	// Initialize out-of-scope variables that need to receive persistent
	// global state values.
	host.getState().then((state) => {
		const {
			terminalShellIntegrationTimeout = Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled = false,
			terminalCommandDelay = 0,
			terminalZdotdir = false,
		} = state as Record<string, unknown>
		Terminal.setShellIntegrationTimeout(terminalShellIntegrationTimeout as number)
		Terminal.setShellIntegrationDisabled(terminalShellIntegrationDisabled as boolean)
		Terminal.setCommandDelay(terminalCommandDelay as number)
		Terminal.setTerminalZdotdir(terminalZdotdir as boolean)
	})

	// Set up webview options with proper resource roots
	const resourceRoots = [host.contextProxy.extensionUri]

	// Add workspace folders to allow access to workspace files
	if (vscode.workspace.workspaceFolders) {
		resourceRoots.push(...vscode.workspace.workspaceFolders.map((folder) => folder.uri))
	}

	webviewView.webview.options = {
		enableScripts: true,
		localResourceRoots: resourceRoots,
	}

	webviewView.webview.html =
		host.contextProxy.extensionMode === vscode.ExtensionMode.Development
			? await host.webviewContent.getHMRHtmlContent(webviewView.webview)
			: await host.webviewContent.getHtmlContent(webviewView.webview)

	// Sets up an event listener to listen for messages passed from the webview view context
	// and executes code based on the message that is received.
	host.setWebviewMessageListener(webviewView.webview)

	// Initialize code index status subscription for the current workspace.
	host.updateCodeIndexStatusSubscription()

	// Listen for active editor changes to update code index status for the
	// current workspace.
	const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
		// Update subscription when workspace might have changed.
		host.updateCodeIndexStatusSubscription()
	})
	host.webviewDisposables.push(activeEditorSubscription)

	// Listen for when the panel becomes visible.
	// https://github.com/microsoft/vscode-discussions/discussions/840
	if ("onDidChangeViewState" in webviewView) {
		// WebviewView and WebviewPanel have all the same properties except
		// for this visibility listener panel.
		const viewStateDisposable = webviewView.onDidChangeViewState(() => {
			if (host.view?.visible) {
				host.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
			}
		})

		host.webviewDisposables.push(viewStateDisposable)
	} else if ("onDidChangeVisibility" in webviewView) {
		// sidebar
		const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
			if (host.view?.visible) {
				host.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
			}
		})

		host.webviewDisposables.push(visibilityDisposable)
	}

	// Listen for when the view is disposed
	// This happens when the user closes the view or when the view is closed programmatically
	webviewView.onDidDispose(
		async () => {
			if (inTabMode) {
				host.log("Disposing ClineProvider instance for tab view")
				await host.dispose()
			} else {
				host.log("Clearing webview resources for sidebar view")
				host.clearWebviewResources()
				// Reset current workspace manager reference when view is disposed
				host.codeIndexStatus.reset()
			}
		},
		null,
		host.disposables,
	)

	// Listen for when color changes
	const configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
		if (e && e.affectsConfiguration("workbench.colorTheme")) {
			// Sends latest theme name to webview
			await host.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
		}
	})
	host.webviewDisposables.push(configDisposable)

	// If the extension is starting a new session, clear previous task state.
	// But don't clear if there's already an active task (e.g., resumed via IPC/bridge).
	const currentTask = host.getCurrentTask()
	if (!currentTask || currentTask.abandoned || currentTask.abort) {
		await host.removeClineFromStack()
	}
}
