import * as vscode from "vscode"

import { t } from "../../i18n"

import { readDictionaries } from "./dictionary"
import { createAllocator, findPii, type PlaceholderAllocator } from "./maskText"
import type { PiiKind, PiiTerm } from "./types"

/**
 * 開いているファイルの機密情報を、その場で置き換える。
 *
 * **目的。** ファイルから値そのものを消す（`FR-PII-11`）。消えていれば、以降どの経路
 * からも出ない。送信の直前に伏せるやり方と違い、実行を忘れたファイルは守られないが、
 * 実行したファイルは確実である。
 *
 * **仕組み。** 設定と辞書から語を集め、`planMasking` で計画を作り、1 つの
 * `WorkspaceEdit` にまとめて当てる。まとめるのは、取り消しの操作 1 回で元へ戻すため
 * である（`FR-PII-11c`）。選択している範囲があれば、その中に収まる箇所だけを対象にする
 * （`FR-PII-11a`）。検出そのものは本文全体で行う。範囲だけを切り出すと、範囲の外から
 * 続く住所や鍵の並びが途中で切れる。
 *
 * **番号は会話と同じものを使う。** 分けると、この操作で付けた `{{email-001}}` と、会話で
 * 別の値へ割り当てた `{{email-001}}` が同じ形になり、あとで別人の値が書き戻される。
 * 割り当てはタスクの対応表へ入るが、ディスクへは書かない（`FR-PII-11d` `FR-PII-02b`）。
 *
 * 戻せない操作なので、置き換える前に種類ごとの件数を示して選ばせる（`FR-PII-11b`）。
 * 件数を出すのは、種類を全部切ったまま実行して「伏せたつもり」になるのを防ぐためでもある。
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

/**
 * 開いているファイルの伏せ字を元の値へ戻す（`FR-PII-20`）。
 *
 * 戻さないまま進めて、最後にまとめて戻す使い方のためにある。**戻せるのはそのタスクで
 * 割り当てた伏せ字だけ**で（`FR-PII-20a`）、タスクが終われば対応表は消える
 * （`FR-PII-20b`）。対応表をディスクへ書かない以上、そこは避けられない。
 */
export async function restoreSecretsInActiveEditor(unmask: ((text: string) => string) | undefined): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		await vscode.window.showInformationMessage(t("common:pii.noEditor"))
		return
	}

	if (!unmask) {
		// 会話が始まっていないか、終わっている。対応表が無いので戻しようがない。
		await vscode.window.showWarningMessage(t("common:pii.noVault"))
		return
	}

	const text = editor.document.getText()
	const restored = unmask(text)
	if (restored === text) {
		await vscode.window.showInformationMessage(t("common:pii.nothingToRestore"))
		return
	}

	// **いまの文書の終わりまでにする。** 写しの長さで測らない。測ると、間に入った
	// 編集の分だけ足りず、末尾が二重になる。全体を置き換えるので、写しを取ったあとの編集は
	// どのみち巻き戻る。
	const workspaceEdit = new vscode.WorkspaceEdit()
	workspaceEdit.replace(
		editor.document.uri,
		new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)),
		restored,
	)

	if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
		await vscode.window.showErrorMessage(t("common:pii.replaceFailed"))
		return
	}

	await vscode.window.showInformationMessage(t("common:pii.restored"))
}

export async function maskSecretsInActiveEditor(
	settings: MaskEditorSettings = {},
	/**
	 * 会話が動いていれば、その対応表から番号を振る。
	 *
	 * **番号の場所を分けない。** 分けると、この操作で付けた `{{email-001}}` と、会話で
	 * 別の値へ割り当てた `{{email-001}}` が同じ形になる。あとでモデルがこのファイルを
	 * 読んで書き戻すと、別人の値が書き込まれる。
	 */
	allocator?: PlaceholderAllocator,
): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		await vscode.window.showInformationMessage(t("common:pii.noEditor"))
		return
	}

	const document = editor.document
	const text = document.getText()
	// **版を控える。** 待ちの間に文書が変わると、ここで求めた位置は別の場所を指す。
	// 当てる直前に確かめ、変わっていたらやり直してもらう。
	const version = document.version

	// 辞書が読めなくても、ほかの種類の置き換えは続ける（`FR-PII-03d`）。
	const dictionary = await readDictionaries(settings.dictionaryPaths ?? [])
	// **読めなかった行も出す**（`FR-PII-03g`）。書き間違えた正規表現を黙って飛ばすと、
	// その語は 1 件も一致しないのに、利用者は伏せたつもりになる。
	const troubles = [
		...dictionary.failures.map((one) => one.path),
		...dictionary.problems.map((one) => `${one.path}:${one.line} ${one.value}`),
	]
	if (troubles.length > 0) {
		await vscode.window.showWarningMessage(t("common:pii.dictionaryFailed", { paths: troubles.join(", ") }))
	}

	// 選択している範囲があるときは、その中だけを対象にする（`FR-PII-11a`）。
	const selection = editor.selection
	const range = selection.isEmpty
		? undefined
		: { start: document.offsetAt(selection.start), end: document.offsetAt(selection.end) }

	const options = {
		terms: [...(settings.terms ?? []), ...dictionary.terms],
		kinds: settings.kinds,
		secretLabels: settings.secretLabels,
	}

	// **検出は 1 回だけにする。** 数えるのに番号は要らない。全部の正規表現と 1,863 件の
	// 地名の照合を、確認の前後で二度走らせない。
	const matches = findPii(text, options).filter(
		(match) => range === undefined || (match.start >= range.start && match.end <= range.end),
	)

	const counts: Partial<Record<PiiKind, number>> = {}
	for (const match of matches) counts[match.kind] = (counts[match.kind] ?? 0) + 1

	if (matches.length === 0) {
		await vscode.window.showInformationMessage(t("common:pii.nothingFound"))
		return
	}

	// 戻せない操作なので、確認を挟む。件数は種類ごとに出す。
	const confirm = t("common:pii.confirmReplace")
	const answer = await vscode.window.showWarningMessage(
		t("common:pii.confirm", { summary: describeCounts(counts) }),
		{ modal: true },
		confirm,
	)
	if (answer !== confirm) {
		return
	}

	if (document.version !== version) {
		// 待ちの間に文書が変わった。古い位置へ当てると、無関係な箇所が伏せ字になり、
		// 機密情報は残る。取り消せない操作なので、やり直してもらう。
		await vscode.window.showWarningMessage(t("common:pii.documentChanged"))
		return
	}

	// **ここで初めて共有の対応表へ入れる。** 断られていれば、ここまで来ない。
	//
	// **書き込みの成否より先に入れるしかない。** 書き込む文字列そのものが伏せ字なので、
	// 番号を決めなければ編集を組み立てられない。書き込みに失敗したときは番号だけが
	// 消費されるが、同じ値には同じ伏せ字が当たるので、指す先が食い違うことは無い。
	// 渡されなければ 1 回限りの割り当てにする。`planMasking` と同じ扱いである。
	const own = allocator ?? createAllocator()

	const workspaceEdit = new vscode.WorkspaceEdit()
	for (const match of matches) {
		workspaceEdit.replace(
			document.uri,
			new vscode.Range(document.positionAt(match.start), document.positionAt(match.end)),
			own.assign(match.kind, match.value),
		)
	}

	if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
		await vscode.window.showErrorMessage(t("common:pii.replaceFailed"))
		return
	}

	await vscode.window.showInformationMessage(t("common:pii.replaced", { summary: describeCounts(counts) }))
}
