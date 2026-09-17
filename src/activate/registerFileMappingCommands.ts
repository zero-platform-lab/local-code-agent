import * as vscode from "vscode"

import { getPiiCommand } from "../utils/commands"
import type { FileMappingController } from "../services/pii/fileMapping"
import type { PiiMapping } from "../services/pii/maskConversation"

/**
 * ファイル対応表の消去コマンドを登録する（`FR-PII-27`）。
 *
 * **目的。** 消去を VS Code へ差し出す。ファイルを選んで消す、または全部を消す。
 * ファイル対応表の入/切は設定 `piiMasking.fileMapping.enabled`（右下のトグル）で切り替える。
 *
 * **対応表を渡す理由。** 全消去は セッション対応表の対応も触る。会話と同じ番号の場所を
 * 使わないと、消し残った伏せ字が別の値を指す。
 */
export const registerFileMappingCommands = (
	context: vscode.ExtensionContext,
	controller: FileMappingController,
	/** いま動いているタスクの対応表。会話が無ければセッション対応表。 */
	getMapping: () => PiiMapping,
) => {
	context.subscriptions.push(
		vscode.commands.registerCommand(getPiiCommand("clearSelectedFileMapping"), () => controller.clearSelected()),
		vscode.commands.registerCommand(getPiiCommand("clearAllFileMapping"), () => controller.clearAll(getMapping())),
	)
}
