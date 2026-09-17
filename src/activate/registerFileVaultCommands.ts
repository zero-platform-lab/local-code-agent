import * as vscode from "vscode"

import { getPiiCommand } from "../utils/commands"
import type { FileVaultController } from "../services/pii/fileVault"
import type { PiiVault } from "../services/pii/maskConversation"

/**
 * File Vault のコマンドを登録する（`FR-PII-24` `FR-PII-27`）。
 *
 * **目的。** 有効化・無効化・状態・消去を VS Code へ差し出す。有効化・無効化・状態は
 * いま開いているファイルを対象にし、消去はファイルを選ぶ、または全部を対象にする。
 *
 * **対応表を渡す理由。** 有効化と全消去は Session Vault の対応を触る。会話と同じ番号の
 * 場所を使わないと、この操作で付けた伏せ字と会話の伏せ字が別の値を指す。
 */
export const registerFileVaultCommands = (
	context: vscode.ExtensionContext,
	controller: FileVaultController,
	/** いま動いているタスクの対応表。会話が無ければ Session Vault。 */
	getVault: () => PiiVault,
) => {
	context.subscriptions.push(
		vscode.commands.registerCommand(getPiiCommand("enableFileVault"), () => controller.enable(getVault())),
		vscode.commands.registerCommand(getPiiCommand("disableFileVault"), () => controller.disable()),
		vscode.commands.registerCommand(getPiiCommand("fileVaultStatus"), () => controller.status()),
		vscode.commands.registerCommand(getPiiCommand("clearSelectedFileVault"), () => controller.clearSelected()),
		vscode.commands.registerCommand(getPiiCommand("clearAllFileVault"), () => controller.clearAll(getVault())),
	)
}
