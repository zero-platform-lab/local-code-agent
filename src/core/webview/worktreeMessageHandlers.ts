import * as vscode from "vscode"

import { type WebviewMessage } from "@openai-agent/types"

import { t } from "../../i18n"

import type { WebviewMessageHost } from "./webviewMessageHost"
import {
	handleListWorktrees,
	handleCreateWorktree,
	handleDeleteWorktree,
	handleSwitchWorktree,
	handleGetAvailableBranches,
	handleGetWorktreeDefaults,
	handleGetWorktreeIncludeStatus,
	handleCheckBranchWorktreeInclude,
	handleCreateWorktreeInclude,
	handleCheckoutBranch,
} from "./worktree"

/**
 * worktree 関連の webview メッセージハンドラ。
 *
 * git worktree の操作そのものは `./worktree` に実装済みで、ここはそれを呼んで結果を
 * webview へ返すグルー層。webviewMessageHandler の巨大 switch から切り出している。
 *
 * 例外は各ハンドラ内で捕捉し、webview には必ず対応する結果メッセージを返す
 * （返さないと webview 側が応答待ちのまま固まるため）。
 */
type WorktreeMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const worktreeMessageHandlers: Partial<Record<WebviewMessage["type"], WorktreeMessageHandler>> = {
	listWorktrees: async (provider) => {
		try {
			const { worktrees, isGitRepo, isMultiRoot, isSubfolder, gitRootPath, error } =
				await handleListWorktrees(provider)

			await provider.postMessageToWebview({
				type: "worktreeList",
				worktrees,
				isGitRepo,
				isMultiRoot,
				isSubfolder,
				gitRootPath,
				error,
			})
		} catch (error) {
			await provider.postMessageToWebview({
				type: "worktreeList",
				worktrees: [],
				isGitRepo: false,
				isMultiRoot: false,
				isSubfolder: false,
				gitRootPath: "",
				error: toErrorMessage(error),
			})
		}
	},

	createWorktree: async (provider, message) => {
		try {
			const { success, message: text } = await handleCreateWorktree(
				provider,
				{
					path: message.worktreePath!,
					branch: message.worktreeBranch,
					baseBranch: message.worktreeBaseBranch,
					createNewBranch: message.worktreeCreateNewBranch,
				},
				(progress) => {
					provider.postMessageToWebview({
						type: "worktreeCopyProgress",
						copyProgressBytesCopied: progress.bytesCopied,
						copyProgressItemName: progress.itemName,
					})
				},
			)

			await provider.postMessageToWebview({ type: "worktreeResult", success, text })
		} catch (error) {
			await provider.postMessageToWebview({
				type: "worktreeResult",
				success: false,
				text: toErrorMessage(error),
			})
		}
	},

	deleteWorktree: async (provider, message) => {
		try {
			const { success, message: text } = await handleDeleteWorktree(
				provider,
				message.worktreePath!,
				message.worktreeForce ?? false,
			)

			await provider.postMessageToWebview({ type: "worktreeResult", success, text })
		} catch (error) {
			await provider.postMessageToWebview({
				type: "worktreeResult",
				success: false,
				text: toErrorMessage(error),
			})
		}
	},

	switchWorktree: async (provider, message) => {
		try {
			const { success, message: text } = await handleSwitchWorktree(
				provider,
				message.worktreePath!,
				message.worktreeNewWindow ?? true,
			)

			await provider.postMessageToWebview({ type: "worktreeResult", success, text })
		} catch (error) {
			await provider.postMessageToWebview({
				type: "worktreeResult",
				success: false,
				text: toErrorMessage(error),
			})
		}
	},

	getAvailableBranches: async (provider) => {
		try {
			const { localBranches, remoteBranches, currentBranch } = await handleGetAvailableBranches(provider)

			await provider.postMessageToWebview({
				type: "branchList",
				localBranches,
				remoteBranches,
				currentBranch,
			})
		} catch (error) {
			await provider.postMessageToWebview({
				type: "branchList",
				localBranches: [],
				remoteBranches: [],
				currentBranch: "",
				error: toErrorMessage(error),
			})
		}
	},

	getWorktreeDefaults: async (provider) => {
		try {
			const { suggestedBranch, suggestedPath } = await handleGetWorktreeDefaults(provider)
			await provider.postMessageToWebview({ type: "worktreeDefaults", suggestedBranch, suggestedPath })
		} catch (error) {
			await provider.postMessageToWebview({
				type: "worktreeDefaults",
				suggestedBranch: "",
				suggestedPath: "",
				error: toErrorMessage(error),
			})
		}
	},

	getWorktreeIncludeStatus: async (provider) => {
		try {
			const worktreeIncludeStatus = await handleGetWorktreeIncludeStatus(provider)
			await provider.postMessageToWebview({ type: "worktreeIncludeStatus", worktreeIncludeStatus })
		} catch (error) {
			await provider.postMessageToWebview({
				type: "worktreeIncludeStatus",
				worktreeIncludeStatus: {
					exists: false,
					hasGitignore: false,
					gitignoreContent: undefined,
				},
				error: toErrorMessage(error),
			})
		}
	},

	checkBranchWorktreeInclude: async (provider, message) => {
		try {
			const branch = message.worktreeBranch
			if (!branch) {
				await provider.postMessageToWebview({
					type: "branchWorktreeIncludeResult",
					hasWorktreeInclude: false,
					error: "No branch specified",
				})
				return
			}
			const hasWorktreeInclude = await handleCheckBranchWorktreeInclude(provider, branch)
			await provider.postMessageToWebview({
				type: "branchWorktreeIncludeResult",
				branch,
				hasWorktreeInclude,
			})
		} catch (error) {
			await provider.postMessageToWebview({
				type: "branchWorktreeIncludeResult",
				hasWorktreeInclude: false,
				error: toErrorMessage(error),
			})
		}
	},

	createWorktreeInclude: async (provider, message) => {
		try {
			const { success, message: text } = await handleCreateWorktreeInclude(
				provider,
				message.worktreeIncludeContent ?? "",
			)

			await provider.postMessageToWebview({ type: "worktreeResult", success, text })
		} catch (error) {
			const errorMessage = toErrorMessage(error)
			provider.log(`Error creating worktree include: ${errorMessage}`)
			await provider.postMessageToWebview({ type: "worktreeResult", success: false, text: errorMessage })
		}
	},

	checkoutBranch: async (provider, message) => {
		try {
			const { success, message: text } = await handleCheckoutBranch(provider, message.worktreeBranch!)
			await provider.postMessageToWebview({ type: "worktreeResult", success, text })
		} catch (error) {
			await provider.postMessageToWebview({
				type: "worktreeResult",
				success: false,
				text: toErrorMessage(error),
			})
		}
	},

	browseForWorktreePath: async (provider) => {
		try {
			const options: vscode.OpenDialogOptions = {
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: t("worktrees:selectWorktreeLocation"),
				title: t("worktrees:selectFolderForWorktree"),
				defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
					? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "..")
					: undefined,
			}

			const result = await vscode.window.showOpenDialog(options)
			if (result && result[0]) {
				await provider.postMessageToWebview({
					type: "folderSelected",
					path: result[0].fsPath,
				})
			}
		} catch (error) {
			provider.log(`Error opening folder picker: ${toErrorMessage(error)}`)
		}
	},
}
