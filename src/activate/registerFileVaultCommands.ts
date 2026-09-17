import * as vscode from "vscode"

import { getPiiCommand } from "../utils/commands"
import type { FileVaultController } from "../services/pii/fileVault"
import type { PiiVault } from "../services/pii/maskConversation"

/**
 * File Vault の消去コマンドを登録する（`FR-PII-27`）。
 *
 * **目的。** 消去を VS Code へ差し出す。ファイルを選んで消す、または全部を消す。
 * File Vault の入/切は設定 `piiMasking.fileVault.enabled`（右下のトグル）で切り替える。
 *
 * **対応表を渡す理由。** 全消去は Session Vault の対応も触る。会話と同じ番号の場所を
 * 使わないと、消し残った伏せ字が別の値を指す。
 */
export const registerFileVaultCommands = (
	context: vscode.ExtensionContext,
	controller: FileVaultController,
	/** いま動いているタスクの対応表。会話が無ければ Session Vault。 */
	getVault: () => PiiVault,
) => {
	context.subscriptions.push(
		vscode.commands.registerCommand(getPiiCommand("clearSelectedFileVault"), () => controller.clearSelected()),
		vscode.commands.registerCommand(getPiiCommand("clearAllFileVault"), () => controller.clearAll(getVault())),
	)
}
