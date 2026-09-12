import * as vscode from "vscode"

import { getPiiCommand } from "../utils/commands"
import type { PlaceholderAllocator } from "../services/pii/maskText"
import {
	maskSecretsInActiveEditor,
	restoreSecretsInActiveEditor,
	type MaskEditorSettings,
} from "../services/pii/maskEditor"
import { addSelectionToDictionary, exportDictionary } from "../services/pii/dictionaryEditor"

/**
 * 機密情報の伏せ字のコマンドを登録する。
 *
 * **目的。** 3 つのコマンドを VS Code へ差し出す。ファイルの置き換え（`FR-PII-11`）、
 * 辞書への追加（`FR-PII-15`）、辞書の書き出し（`FR-PII-17`）である。
 *
 * **仕組み。** 設定は登録の時点ではなく、呼ばれた時点で読む。登録時に読むと、設定を
 * 変えても効かない。
 *
 * `registerCommands` とは別に置く。あちらのコマンドはどれも「見えている provider が
 * 無ければ何もしない」で揃えてあるが、こちらは編集中のファイルだけを見るので provider を
 * 必要としない。同じ規則へ混ぜると、その揃え方の意味が失われる。
 */
export const registerPiiCommands = (
	context: vscode.ExtensionContext,
	readSettings: () => MaskEditorSettings,
	/** いま動いているタスクの戻し方。会話が無ければ `undefined`（`FR-PII-20b`）。 */
	getUnmask: () => ((text: string) => string) | undefined = () => undefined,
	/**
	 * いま動いているタスクの対応表。ファイルの置き換えでも同じ番号の場所を使う。
	 *
	 * 分けると、この操作で付けた伏せ字と会話の伏せ字が同じ形になり、あとで別人の値が
	 * 書き込まれる。
	 */
	getAllocator: () => PlaceholderAllocator | undefined = () => undefined,
) => {
	context.subscriptions.push(
		vscode.commands.registerCommand(getPiiCommand("maskSecretsInFile"), () =>
			maskSecretsInActiveEditor(readSettings(), getAllocator()),
		),
		vscode.commands.registerCommand(getPiiCommand("restoreSecretsInFile"), () =>
			restoreSecretsInActiveEditor(getUnmask()),
		),
		vscode.commands.registerCommand(getPiiCommand("addToDictionary"), () =>
			addSelectionToDictionary(readSettings()),
		),
		vscode.commands.registerCommand(getPiiCommand("exportDictionary"), () => exportDictionary(readSettings())),
	)
}
