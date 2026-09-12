import * as vscode from "vscode"

import { t } from "../../i18n"

import { readDictionaries } from "./dictionary"
import { planMasking } from "./maskText"
import type { PiiKind, PiiTerm } from "./types"

/**
 * 開いているファイルの機密情報を、その場で伏せ字へ置き換える（`FR-PII-11`）。
 *
 * **対応表を持たない**（`FR-PII-11d`）。持てば、その対応表が伏せた値を抱えることになり、
 * 伏せた意味が無くなる。元へ戻す手段は、編集の取り消しと git に任せる。
 *
 * 戻せない操作なので、置き換える前に種類ごとの件数を示して選ばせる（`FR-PII-11b`）。
 */

export type MaskEditorSettings = {
	kinds?: readonly PiiKind[]
	terms?: readonly PiiTerm[]
	dictionaryPaths?: readonly string[]
	secretLabels?: readonly string[]
}

/** 種類ごとの件数を「メールアドレス 2 件、住所 1 件」の形へ組み立てる。 */
export function describeCounts(counts: Partial<Record<PiiKind, number>>): string {
	// 値を入れるのは `planMasking` だけで、未定義は入らない。分けて扱わない。
	return Object.entries(counts as Record<string, number>)
		.filter(([, count]) => count > 0)
		.map(([kind, count]) => t(`common:pii.kind.${kind}`) + ` ${count}`)
		.join("、")
}

export async function maskSecretsInActiveEditor(settings: MaskEditorSettings = {}): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		await vscode.window.showInformationMessage(t("common:pii.noEditor"))
		return
	}

	const document = editor.document
	const text = document.getText()

	// 辞書が読めなくても、ほかの種類の置き換えは続ける（`FR-PII-03d`）。
	const dictionary = await readDictionaries(settings.dictionaryPaths ?? [])
	if (dictionary.failures.length > 0) {
		await vscode.window.showWarningMessage(
			t("common:pii.dictionaryFailed", { paths: dictionary.failures.map((one) => one.path).join(", ") }),
		)
	}

	// 選択している範囲があるときは、その中だけを対象にする（`FR-PII-11a`）。
	const selection = editor.selection
	const range = selection.isEmpty
		? undefined
		: { start: document.offsetAt(selection.start), end: document.offsetAt(selection.end) }

	const plan = planMasking(
		text,
		{
			terms: [...(settings.terms ?? []), ...dictionary.terms],
			kinds: settings.kinds,
			secretLabels: settings.secretLabels,
		},
		range,
	)

	if (plan.edits.length === 0) {
		await vscode.window.showInformationMessage(t("common:pii.nothingFound"))
		return
	}

	// 戻せない操作なので、確認を挟む。件数は種類ごとに出す。
	const confirm = t("common:pii.confirmReplace")
	const answer = await vscode.window.showWarningMessage(
		t("common:pii.confirm", { summary: describeCounts(plan.counts) }),
		{ modal: true },
		confirm,
	)
	if (answer !== confirm) {
		return
	}

	// 1 つの `WorkspaceEdit` にまとめる。取り消しの操作 1 回で元へ戻る（`FR-PII-11c`）。
	const workspaceEdit = new vscode.WorkspaceEdit()
	for (const edit of plan.edits) {
		workspaceEdit.replace(
			document.uri,
			new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
			edit.placeholder,
		)
	}

	if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
		await vscode.window.showErrorMessage(t("common:pii.replaceFailed"))
		return
	}

	await vscode.window.showInformationMessage(t("common:pii.replaced", { summary: describeCounts(plan.counts) }))
}
