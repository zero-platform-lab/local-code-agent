import * as path from "path"

import * as vscode from "vscode"

import { arePathsEqual } from "../../utils/path"

/**
 * MCP 設定ファイル（global settings と project `.agent/mcp.json`）の監視プランビング。
 *
 * 「ファイルが変わったら debounce して reconcile を促す」という配管だけを持ち、
 * 実際の再取り込み（updateServerConnections 等）は {@link McpConfigWatchHost} 経由で
 * McpHub 側に委ねる。vscode の watcher と debounce タイマだけに閉じているので、
 * fake vscode を注入すれば単体テストできる（McpHub 本体は NODE_ENV=test のとき
 * {@link start} を呼ばないことで本番だけ監視を張る）。
 */
export interface McpConfigWatchHost {
	/** グローバル設定ファイルのパス（無ければ作成して返す）。 */
	getGlobalSettingsPath(): Promise<string>
	/** プロジェクト設定を探す基準ワークスペースパス。 */
	getProjectCwd(): string
	/** 拡張自身の書き込み中か（true の間はファイル変更を無視する）。 */
	isProgrammaticWrite(): boolean
	/** 設定ファイルが変わった＝再 reconcile せよ。 */
	reloadConfig(filePath: string, source: "global" | "project"): Promise<void>
	/** ワークスペースフォルダが変わった＝プロジェクト設定を読み直せ。 */
	reloadProjectConfig(): Promise<void>
	/** プロジェクト設定ファイルが消えた。 */
	handleProjectConfigDeleted(): Promise<void>
}

export class McpConfigWatcher {
	private settingsWatcher?: vscode.FileSystemWatcher
	private projectMcpWatcher?: vscode.FileSystemWatcher
	private readonly debounceTimers = new Map<string, NodeJS.Timeout>()
	private readonly disposables: vscode.Disposable[] = []

	constructor(private readonly host: McpConfigWatchHost) {}

	/** 監視を張る。fire-and-forget（初回接続を待たせない）。 */
	start(): void {
		void this.watchGlobalSettings()
		this.watchProjectFile().catch(console.error)
		this.watchWorkspaceFolders()
	}

	async watchGlobalSettings(): Promise<void> {
		if (!vscode.workspace.createFileSystemWatcher) {
			return
		}

		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
			this.settingsWatcher = undefined
		}

		const settingsPath = await this.host.getGlobalSettingsPath()
		const settingsPattern = new vscode.RelativePattern(path.dirname(settingsPath), path.basename(settingsPath))

		this.settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPattern)

		const changeDisposable = this.settingsWatcher.onDidChange((uri) => {
			if (arePathsEqual(uri.fsPath, settingsPath)) {
				this.debounce(settingsPath, "global")
			}
		})

		const createDisposable = this.settingsWatcher.onDidCreate((uri) => {
			if (arePathsEqual(uri.fsPath, settingsPath)) {
				this.debounce(settingsPath, "global")
			}
		})

		this.disposables.push(vscode.Disposable.from(changeDisposable, createDisposable, this.settingsWatcher))
	}

	async watchProjectFile(): Promise<void> {
		if (!vscode.workspace.createFileSystemWatcher) {
			return
		}

		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}

		if (!vscode.workspace.workspaceFolders?.length) {
			return
		}

		const projectMcpPattern = new vscode.RelativePattern(this.host.getProjectCwd(), ".agent/mcp.json")
		this.projectMcpWatcher = vscode.workspace.createFileSystemWatcher(projectMcpPattern)

		const changeDisposable = this.projectMcpWatcher.onDidChange((uri) => this.debounce(uri.fsPath, "project"))
		const createDisposable = this.projectMcpWatcher.onDidCreate((uri) => this.debounce(uri.fsPath, "project"))
		const deleteDisposable = this.projectMcpWatcher.onDidDelete(async () => {
			await this.host.handleProjectConfigDeleted()
		})

		this.disposables.push(
			vscode.Disposable.from(changeDisposable, createDisposable, deleteDisposable, this.projectMcpWatcher),
		)
	}

	watchWorkspaceFolders(): void {
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(async () => {
				await this.host.reloadProjectConfig()
				await this.watchProjectFile()
			}),
		)
	}

	/** 500ms のデバウンス。拡張自身の書き込み中は無視して不要な再起動を防ぐ。 */
	debounce(filePath: string, source: "global" | "project"): void {
		if (this.host.isProgrammaticWrite()) {
			return
		}

		const key = `${source}-${filePath}`

		const existingTimer = this.debounceTimers.get(key)
		if (existingTimer) {
			clearTimeout(existingTimer)
		}

		const timer = setTimeout(async () => {
			this.debounceTimers.delete(key)
			await this.host.reloadConfig(filePath, source)
		}, 500)

		this.debounceTimers.set(key, timer)
	}

	dispose(): void {
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer)
		}
		this.debounceTimers.clear()

		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
			this.settingsWatcher = undefined
		}

		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}

		this.disposables.forEach((d) => d.dispose())
	}
}
