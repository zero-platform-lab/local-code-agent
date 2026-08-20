import * as vscode from "vscode"

import type { CodeIndexManager } from "../../services/code-index/manager"
import type { IndexProgressUpdate } from "../../services/code-index/interfaces/manager"

export interface CodeIndexStatusDeps {
	/** 現在のワークスペースに対応する CodeIndexManager（無ければ undefined）。 */
	getCurrentManager(): CodeIndexManager | undefined
	/** インデックス状況を webview へ送る。 */
	postIndexingStatus(values: ReturnType<CodeIndexManager["getCurrentStatus"]>): void
	/** webview が存在するか（存在時のみ subscription を webviewDisposables に載せる）。 */
	hasView(): boolean
	/** subscription を webview ライフサイクルの disposables に登録する。 */
	registerDisposable(disposable: vscode.Disposable): void
}

/**
 * コードインデックスの進捗 subscription を所有・更新する。
 * ワークスペース切替で現在の CodeIndexManager が変わったら、旧 subscription を破棄して
 * 新 manager に張り替え、初期状態を webview へ送る。ClineProvider から分離。
 */
export class CodeIndexStatusSubscriber {
	private manager?: CodeIndexManager
	private subscription?: vscode.Disposable

	constructor(private readonly deps: CodeIndexStatusDeps) {}

	/** 現在のワークスペース manager に subscription を同期する（変化が無ければ no-op）。 */
	update(): void {
		const currentManager = this.deps.getCurrentManager()

		// If the manager hasn't changed, no need to update subscription
		if (currentManager === this.manager) {
			return
		}

		// Dispose the old subscription if it exists
		if (this.subscription) {
			this.subscription.dispose()
			this.subscription = undefined
		}

		// Update the current workspace manager reference
		this.manager = currentManager

		// Subscribe to the new manager's progress updates if it exists
		if (currentManager) {
			this.subscription = currentManager.onProgressUpdate((_update: IndexProgressUpdate) => {
				// Only send updates if this manager is still the current one
				if (currentManager === this.deps.getCurrentManager()) {
					// Get the full status from the manager to ensure we have all fields correctly formatted
					this.deps.postIndexingStatus(currentManager.getCurrentStatus())
				}
			})

			if (this.deps.hasView()) {
				this.deps.registerDisposable(this.subscription)
			}

			// Send initial status for the current workspace
			this.deps.postIndexingStatus(currentManager.getCurrentStatus())
		}
	}

	/** view 破棄時などに manager 参照をリセットし、次回 update で再購読させる。 */
	reset(): void {
		this.manager = undefined
	}
}
