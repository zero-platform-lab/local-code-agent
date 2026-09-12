import { promises as fs } from "fs"

import type { PiiTerm } from "./types"

/**
 * 伏せる語の辞書を読む（`FR-PII-03b`）。
 *
 * 設定へ直接書くほかに、ファイルからも読めるようにする。チームで 1 つの辞書を共有できる。
 *
 * **符号化を判別する**（`FR-PII-03e`）。辞書が Shift_JIS で保存されていることがあり、
 * UTF-8 として読むと文字化けして 1 件も一致しない。伏せているつもりのまま素通りする。
 */

/** 1 行に書ける種類（`FR-PII-03b`）。伏せ字の見え方だけを決める。 */
const KINDS: Record<string, PiiTerm["kind"]> = {
	person: "person",
	org: "org",
	term: "term",
}

/**
 * UTF-8 として厳密に読み、失敗したら Shift_JIS として読む。
 *
 * Shift_JIS の多バイトの並びは UTF-8 として妥当にならないので、この順で判別できる。
 * ASCII だけの辞書はどちらで読んでも同じ結果になる。依存は足さない。`TextDecoder` が
 * `shift_jis` を扱える。
 */
export function decodeText(bytes: Uint8Array): string {
	try {
		// `TextDecoder` は既定で BOM を落とすので、1 語目の先頭に BOM は残らない。
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
	} catch {
		return new TextDecoder("shift_jis").decode(bytes)
	}
}

/**
 * 1 行 1 語で読む（`FR-PII-03c`）。`#` で始まる行と空行は読み飛ばす。
 * タブの後ろに種類を書ける。種類が無い、または読めない場合は `term` として扱う。
 */
export function parseDictionary(text: string): PiiTerm[] {
	const terms: PiiTerm[] = []

	for (const line of text.split(/\r?\n/)) {
		const stripped = line.trim()
		if (stripped.length === 0 || stripped.startsWith("#")) continue

		// **分割を先に行う。** 行ごと trim すると、値が空白だけの行でタブが消え、
		// 種類として書いた語が値として読まれる。
		const [value, rawKind] = line.split("\t", 2)
		const trimmed = value.trim()
		if (trimmed.length === 0) continue

		terms.push({ value: trimmed, kind: KINDS[(rawKind ?? "").trim().toLowerCase()] ?? "term" })
	}

	return terms
}

export type DictionaryResult = {
	terms: PiiTerm[]
	/** 読めなかった辞書のパスと理由（`FR-PII-03d`）。 */
	failures: { path: string; error: string }[]
}

/**
 * 辞書をまとめて読む。
 *
 * **読めない辞書があっても、ほかの種類の置き換えは続ける**（`FR-PII-03d`）。辞書が
 * 無いことを理由に、メールアドレスの伏せ字まで止めない。読めなかったことは呼び出し側へ
 * 返して、利用者へ示す。
 */
export async function readDictionaries(paths: readonly string[]): Promise<DictionaryResult> {
	const terms: PiiTerm[] = []
	const failures: DictionaryResult["failures"] = []

	for (const path of paths) {
		try {
			terms.push(...parseDictionary(decodeText(await fs.readFile(path))))
		} catch (error) {
			failures.push({ path, error: String(error) })
		}
	}

	return { terms, failures }
}
