import * as vscode from "vscode"

import { getPiiCommand } from "../utils/commands"
import { maskSecretsInActiveEditor, type MaskEditorSettings } from "../services/pii/maskEditor"

/**
 * 機密情報を伏せ字へ置き換えるコマンドを登録する（`FR-PII-11`）。
 *
 * 編集中のファイルだけを見るので、webview の provider を必要としない。`registerCommands`
 * とは別に置く。あちらのコマンドはどれも「見えている provider が無ければ何もしない」で
 * 揃えてあり、その規則へ混ぜると意味が合わなくなる。
 */
export const registerPiiCommands = (context: vscode.ExtensionContext, readSettings: () => MaskEditorSettings) => {
	context.subscriptions.push(
		vscode.commands.registerCommand(getPiiCommand("maskSecretsInFile"), () =>
			maskSecretsInActiveEditor(readSettings()),
		),
	)
}
