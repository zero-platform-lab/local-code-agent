import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"

import { getGlobalAgentDirectory } from "../agent-config"

import type { PiiTerm } from "./types"

/**
 * 伏せる語の辞書を読む。
 *
 * **目的。** 設定へ直接書くほかに、ファイルからも語を読む（`FR-PII-03b`）。行単位なので
 * 差分が読め、チームで 1 つの辞書を git で共有できる。
 *
 * **仕組み。** 1 行 1 語。タブの後ろに種類（`person` / `org`）を書ける。`#` で始まる行と
 * 空行は読み飛ばす（`FR-PII-03c`）。`/EMP-\d{5}/` と囲めば正規表現として扱う
 * （`FR-PII-03f`）。囲まなければ普通の語なので、`.` を含む社名がいきなり正規表現として
 * 動くことはない。
 *
 * **符号化を判別する**（`FR-PII-03e`）。辞書が Shift_JIS で保存されていることがあり、
 * UTF-8 として読むと文字化けして 1 件も一致しない。伏せているつもりのまま素通りする、
 * いちばん気づけない失敗である。UTF-8 として厳密に読み、失敗したら Shift_JIS として読む。
 *
 * **黙って読み飛ばさない。** 読めない辞書も、書き間違えた正規表現の行も、呼び出し側へ
 * 返して利用者に示す（`FR-PII-03d` `FR-PII-03g`）。読めた分の置き換えは続ける。辞書が
 * 無いことを理由に、メールアドレスの伏せ字まで止めない。
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
/** `/EMP-\d{5}/` の形。囲んだときだけ正規表現として扱う（`FR-PII-03f`）。 */
const REGEX_LINE = /^\/(.+)\/$/

export type ParsedDictionary = {
	terms: PiiTerm[]
	/** 読めなかった行（`FR-PII-03g`）。黙って読み飛ばさない。 */
	problems: { line: number; value: string; reason: string }[]
}

export function parseDictionaryLines(text: string): ParsedDictionary {
	const terms: PiiTerm[] = []
	const problems: ParsedDictionary["problems"] = []

	text.split(/\r?\n/).forEach((line, index) => {
		const stripped = line.trim()
		if (stripped.length === 0 || stripped.startsWith("#")) return

		// **分割を先に行う。** 行ごと trim すると、値が空白だけの行でタブが消え、
		// 種類として書いた語が値として読まれる。
		const [value, rawKind] = line.split("\t", 2)
		const trimmed = value.trim()
		if (trimmed.length === 0) return

		const kind = KINDS[(rawKind ?? "").trim().toLowerCase()] ?? "term"
		const asRegex = REGEX_LINE.exec(trimmed)
		if (!asRegex) {
			terms.push({ value: trimmed, kind })
			return
		}

		const source = asRegex[1]
		const problem = regexProblem(source)
		if (problem) {
			problems.push({ line: index + 1, value: trimmed, reason: problem })
			return
		}

		terms.push({ value: source, kind, regex: true })
	})

	return { terms, problems }
}

/** 使えない正規表現の理由を返す。使えるなら `undefined`。 */
function regexProblem(source: string): string | undefined {
	let pattern: RegExp
	try {
		pattern = new RegExp(source)
	} catch (error) {
		return String(error)
	}
	// 空に一致すると全ての位置に当たり、文書が伏せ字で埋まる（`FR-PII-03h`）。
	return pattern.test("") ? "空の文字列に一致します" : undefined
}

export function parseDictionary(text: string): PiiTerm[] {
	return parseDictionaryLines(text).terms
}

export type DictionaryResult = {
	terms: PiiTerm[]
	/** 読めなかった辞書のパスと理由（`FR-PII-03d`）。 */
	failures: { path: string; error: string }[]
	/** 読めなかった行（`FR-PII-03g`）。辞書は読めたが、その行だけ使えない。 */
	problems: { path: string; line: number; value: string; reason: string }[]
}

/**
 * 辞書をまとめて読む。
 *
 * **読めない辞書があっても、ほかの種類の置き換えは続ける**（`FR-PII-03d`）。辞書が
 * 無いことを理由に、メールアドレスの伏せ字まで止めない。読めなかったことは呼び出し側へ
 * 返して、利用者へ示す。
 */
/**
 * 設定に書かれたパスを、実際に読める形へ直す。
 *
 * **`~` を展開する。** 設定の画面が `~/.agent/pii-dictionary.txt` を例示するので、その
 * とおりに書いた利用者の辞書が読めないと、伏せているつもりで素通りする。
 *
 * **空の行は落とす。** 画面の「辞書を足す」は空のパスを積むので、そのまま読むと毎回
 * 失敗の警告が出る。
 */
export function resolveDictionaryPath(raw: string): string | undefined {
	const trimmed = raw.trim()
	if (trimmed.length === 0) return undefined
	if (trimmed === "~") return os.homedir()
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.join(os.homedir(), trimmed.slice(2))
	}
	return trimmed
}

/**
 * 辞書が 1 つも設定されていないときに足す先（`FR-PII-15b`）。
 *
 * **読むほうでも必ず見る。** 右クリックで語を足した先をここが返すのに、読む側が見なければ、
 * 足した語は二度と効かない。利用者は足したつもりのまま送信する。
 */
export function defaultDictionaryPath(): string {
	return path.join(getGlobalAgentDirectory(), "pii-dictionary.txt")
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target)
		return true
	} catch {
		return false
	}
}

export async function readDictionaries(rawPaths: readonly string[]): Promise<DictionaryResult> {
	const paths = rawPaths.map(resolveDictionaryPath).filter((one): one is string => one !== undefined)

	// 既定の辞書は、あるときだけ足す。無いときに足すと、使っていない利用者へ毎回
	// 「読めません」と出る。
	const fallback = defaultDictionaryPath()
	if (!paths.includes(fallback) && (await exists(fallback))) {
		paths.push(fallback)
	}

	const terms: PiiTerm[] = []
	const failures: DictionaryResult["failures"] = []
	const problems: DictionaryResult["problems"] = []

	for (const path of paths) {
		try {
			const parsed = parseDictionaryLines(decodeText(await fs.readFile(path)))
			terms.push(...parsed.terms)
			problems.push(...parsed.problems.map((problem) => ({ path, ...problem })))
		} catch (error) {
			failures.push({ path, error: String(error) })
		}
	}

	return { terms, failures, problems }
}
