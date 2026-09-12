import * as path from "path"
import { promises as fs } from "fs"

import * as vscode from "vscode"

import { t } from "../../i18n"

import { defaultDictionaryPath, readDictionaries, resolveDictionaryPath } from "./dictionary"
import type { PiiTerm } from "./types"

/**
 * 辞書への語の追加と、辞書の書き出し。
 *
 * **目的。** 辞書を使いながら育てられるようにする（`FR-PII-15`）。最初に全部を書き出す
 * 必要をなくす。書き出し（`FR-PII-17`）はチームへ渡すためのものである。
 *
 * **仕組み。** 追加はエディタの右クリックから行う。文書を読んでいて伏せられていない社名を
 * 見つけたら、選んでその場で足す。マスクを実行した直後に「これが伏せられていない」と
 * 気づくことがいちばん多い。足す先と種類はその都度選び（`FR-PII-15a`）、辞書が 1 つも
 * 設定されていなければ既定の場所に作る（`FR-PII-15b`）。
 *
 * 新しく作る辞書には書き方を先頭に入れる。空のファイルを渡されても、何をどう書けばよいか
 * 分からない。
 *
 * **Shift_JIS の辞書へは書き足さない**（`FR-PII-15c`）。UTF-8 のバイト列を書き足すと、
 * 1 つのファイルに 2 つの符号化が混ざって読めなくなる。読むほうは判別できるが、書くほうは
 * 壊すので止める。
 *
 * **書き出しは右クリックに出さない。** ここの 2 つはエディタの中身を対象にするが、
 * 書き出しは何も対象にしない。設定の画面から呼ぶ。
 */

/** 新しく作る辞書の先頭に置く説明。書き方が分からないまま空のファイルを渡さない。 */
export const DICTIONARY_HEADER = [
	"# マスクの辞書。1 行 1 語。",
	"# タブの後ろに種類（person / org）を書ける。省略すると term になる。",
	"# `/EMP-\\d{5}/` のようにスラッシュで囲むと正規表現として扱う。",
	"# `#` で始まる行と空行は読み飛ばす。",
	"",
].join("\n")

/** 辞書へ書き足す 1 行。 */
export function dictionaryLine(term: PiiTerm): string {
	return term.kind && term.kind !== "term" ? `${term.value}\t${term.kind}\n` : `${term.value}\n`
}

/**
 * その辞書へ書き足してよいかを見る（`FR-PII-15c`）。
 *
 * **Shift_JIS の辞書へは書き足さない。** UTF-8 のバイト列を書き足すと、1 つのファイルに
 * 2 つの符号化が混ざって読めなくなる。読むほうは判別できるが、書くほうは壊す。
 */
export async function canAppend(dictionaryPath: string): Promise<boolean> {
	let bytes: Uint8Array
	try {
		bytes = await fs.readFile(dictionaryPath)
	} catch {
		// まだ無いなら、こちらが UTF-8 で作る。
		return true
	}

	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		return true
	} catch {
		return false
	}
}

export type AddTermOptions = {
	dictionaryPaths?: readonly string[]
}

/** エディタで選んだ語を辞書へ足す（`FR-PII-15`）。 */
export async function addSelectionToDictionary(options: AddTermOptions = {}): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		await vscode.window.showInformationMessage(t("common:pii.noEditor"))
		return
	}

	const value = editor.document.getText(editor.selection).trim()
	if (value.length === 0) {
		await vscode.window.showInformationMessage(t("common:pii.noSelection"))
		return
	}

	// **改行とタブを含む選択は受け付けない。** 辞書は 1 行 1 語で、タブの後ろが種類である。
	// そのまま書き足すと、2 行目が種類の無い語として読まれ、タブの後ろは種類として
	// 読まれる。どちらも利用者の意図と違う語が辞書に入る。
	if (/[\t\r\n]/.test(value)) {
		await vscode.window.showWarningMessage(t("common:pii.selectionNotOneTerm"))
		return
	}

	const target = await pickDictionary(options.dictionaryPaths ?? [])
	if (!target) {
		return
	}

	if (!(await canAppend(target))) {
		// 壊さないために止める。手で足すか、UTF-8 で保存し直してもらう。
		await vscode.window.showWarningMessage(t("common:pii.dictionaryNotUtf8", { path: target }))
		return
	}

	const kind = await pickKind()
	if (!kind) {
		return
	}

	await fs.mkdir(path.dirname(target), { recursive: true })
	// **前の行が改行で終わっていなければ、改行を足してから書く。** 足さないと、前の語と
	// 繋がって 1 つの語になり、どちらも二度と一致しなくなる。
	const head = await headFor(target)
	await fs.appendFile(target, head + dictionaryLine({ value, kind }), "utf8")

	await vscode.window.showInformationMessage(t("common:pii.termAdded", { value, path: target }))
}

/** 辞書を 1 つのファイルへ書き出す（`FR-PII-17`）。 */
export async function exportDictionary(options: { terms?: readonly PiiTerm[]; dictionaryPaths?: readonly string[] }) {
	const fromFiles = await readDictionaries(options.dictionaryPaths ?? [])
	const all = [...(options.terms ?? []), ...fromFiles.terms]

	// 同じ語は 1 つにまとめる（`FR-PII-17b`）。設定と辞書の両方に書いてあることがある。
	const seen = new Map<string, PiiTerm>()
	for (const term of all) {
		const key = `${term.regex ? "/" : ""}${term.value}`
		if (!seen.has(key)) seen.set(key, term)
	}

	if (seen.size === 0) {
		await vscode.window.showInformationMessage(t("common:pii.nothingToExport"))
		return
	}

	const uri = await vscode.window.showSaveDialog({
		filters: { テキスト: ["txt"] },
		defaultUri: vscode.Uri.file(defaultDictionaryPath()),
	})
	if (!uri) {
		return
	}

	const body = [...seen.values()]
		.map((term) => dictionaryLine(term.regex ? { ...term, value: `/${term.value}/` } : term))
		.join("")

	// 書き出しは UTF-8 で行う（`FR-PII-17b`）。読むほうは Shift_JIS も読めるが、
	// こちらから作るものは 1 つに揃える。
	await fs.writeFile(uri.fsPath, DICTIONARY_HEADER + body, "utf8")

	await vscode.window.showInformationMessage(t("common:pii.exported", { count: seen.size, path: uri.fsPath }))
}

/** 書き足す前に置くもの。新しく作るなら説明、続きなら足りない改行。 */
async function headFor(target: string): Promise<string> {
	let current: string
	try {
		current = await fs.readFile(target, "utf8")
	} catch {
		// まだ無い。書き方が分からないまま空のファイルを渡さない。
		return DICTIONARY_HEADER
	}

	return current.length === 0 || current.endsWith("\n") ? "" : "\n"
}

/** 足す先を選ぶ（`FR-PII-15a`）。設定が無ければ既定の場所に作る（`FR-PII-15b`）。 */
async function pickDictionary(rawPaths: readonly string[]): Promise<string | undefined> {
	const paths = rawPaths.map(resolveDictionaryPath).filter((one): one is string => one !== undefined)
	if (paths.length === 0) {
		return defaultDictionaryPath()
	}
	if (paths.length === 1) {
		return paths[0]
	}

	return await vscode.window.showQuickPick([...paths], { placeHolder: t("common:pii.pickDictionary") })
}

/** 語の種類を選ぶ（`FR-PII-15a`）。伏せ字の見え方だけが変わる。 */
async function pickKind(): Promise<PiiTerm["kind"] | undefined> {
	// `kind` は `QuickPickItem` が区切り線のために使う名前なので、別の名前で持つ。
	const items = [
		{ label: t("common:pii.kind.person"), termKind: "person" as const },
		{ label: t("common:pii.kind.org"), termKind: "org" as const },
		{ label: t("common:pii.kind.term"), termKind: "term" as const },
	]

	const picked = await vscode.window.showQuickPick(items, { placeHolder: t("common:pii.pickKind") })
	return picked?.termKind
}
