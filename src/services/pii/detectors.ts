import { PLACE_NAMES } from "./placeNames"
import type { PiiMatch, PiiTerm } from "./types"

/**
 * 型の決まった情報を本文から見つける。
 *
 * **推定に頼る検出は置かない。** 人名と組織名の自動判定は誤検出が避けられず、誤って
 * 伏せるとモデルが読む内容が変わる。ここにあるのは、書式か検査か語の並びで確かめられる
 * ものだけである。
 *
 * どの関数も本文を書き換えない。位置を返すだけで、伏せ字の割り当ては `maskText` が行う。
 */

/** メールアドレス（`FR-PII-04`）。 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

export function detectEmails(text: string): PiiMatch[] {
	return collect(text, EMAIL, "email")
}

/**
 * 日本国内の電話番号（`FR-PII-05`）。
 *
 * `0` か `+81` で始まり、数字が合わせて 10 桁か 11 桁のものだけを採る。桁数を確かめないと、
 * 版番号や日付の並びまで拾う。
 */
const PHONE = /(?:\+81[-\s(]?|0)\d{1,4}[-\s)]?\d{1,4}[-\s]?\d{3,4}/g

export function detectPhones(text: string): PiiMatch[] {
	return collect(text, PHONE, "phone").filter((match) => {
		const digits = match.value.replace(/\D/g, "")
		// `+81` から始まる場合は国番号の 81 を除いて数える。先頭の 0 が無い形である。
		const national = match.value.startsWith("+81") ? `0${digits.slice(2)}` : digits
		return national.length === 10 || national.length === 11
	})
}

/**
 * 公開でないホスト名（`FR-PII-06`）。
 *
 * 内部向けの TLD で終わるものだけを採る。公開されているドメイン名は伏せない
 * （`FR-PII-06b`）。伏せても守るものが無く、`github.com` が伏せ字になると質問の意味が
 * 失われる。
 */
const INTERNAL_TLDS = ["internal", "local", "lan", "corp", "intra", "intranet", "private", "home", "localdomain"]

const INTERNAL_HOST = new RegExp(
	String.raw`\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:${INTERNAL_TLDS.join("|")})\b`,
	"gi",
)

/** 閉じた宛先は伏せない（`FR-PII-06a`）。誰のものでもなく、コードの中で意味を持つ。 */
const CLOSED_HOSTS = new Set(["localhost", "localhost.localdomain", "127.0.0.1", "::1", "0.0.0.0"])

export function detectHosts(text: string): PiiMatch[] {
	return collect(text, INTERNAL_HOST, "host").filter((match) => !CLOSED_HOSTS.has(match.value.toLowerCase()))
}

/**
 * グローバルの IPv4（`FR-PII-06d`）。
 *
 * **範囲は先頭 2 オクテットだけ**にする。割り当て先を表すのはそこで、後ろ 2 つは
 * 伏せなくてよい。プライベート範囲と閉じた宛先は採らない（`FR-PII-06c` `FR-PII-06a`）。
 */
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g

function isPrivateOrClosed(octets: number[]): boolean {
	const [a, b] = octets
	if (a === 10 || a === 127 || a === 0) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 192 && b === 168) return true
	// リンクローカル。設定ファイルに出るが、誰のものでもない。
	if (a === 169 && b === 254) return true
	return false
}

export function detectIps(text: string): PiiMatch[] {
	const matches: PiiMatch[] = []
	for (const found of text.matchAll(IPV4)) {
		const octets = found.slice(1, 5).map((part) => Number(part))
		if (octets.some((value) => value > 255)) continue
		if (isPrivateOrClosed(octets)) continue

		const start = found.index
		// 先頭 2 オクテットの終わりは、3 つ目の `.` ではなく 2 つ目の `.` の手前。
		const prefix = `${octets[0]}.${octets[1]}`
		matches.push({ kind: "ip", start, end: start + prefix.length, value: prefix })
	}
	return matches
}

/**
 * クレジットカード番号（`FR-PII-09`）。
 *
 * 桁数だけで拾うと、注文番号やタイムスタンプまで伏せる。**Luhn 検査に通った並びだけ**を
 * 採る（`FR-PII-09a`）。
 */
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g

export function passesLuhn(digits: string): boolean {
	if (!/^\d+$/.test(digits)) return false

	let sum = 0
	let double = false
	for (let i = digits.length - 1; i >= 0; i--) {
		let value = digits.charCodeAt(i) - 48
		if (double) {
			value *= 2
			if (value > 9) value -= 9
		}
		sum += value
		double = !double
	}
	return sum % 10 === 0
}

export function detectCards(text: string): PiiMatch[] {
	return collect(text, CARD, "card").filter((match) => {
		const digits = match.value.replace(/\D/g, "")
		return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)
	})
}

/**
 * よく知られた形の鍵（`FR-PII-10` `FR-PII-10a`）。
 *
 * 接頭辞で照合する。文字の偏りだけで判定すると、git のハッシュ、base64 の資産、
 * 最小化したコードまで伏せてしまい、モデルが読むコードが壊れる。
 */
const KNOWN_SECRET = new RegExp(
	[
		String.raw`sk-ant-[A-Za-z0-9_-]{16,}`,
		String.raw`sk-[A-Za-z0-9_-]{16,}`,
		String.raw`github_pat_[A-Za-z0-9_]{20,}`,
		String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
		String.raw`glpat-[A-Za-z0-9_-]{16,}`,
		String.raw`xox[abpsr]-[A-Za-z0-9-]{10,}`,
		String.raw`A(?:KIA|SIA)[A-Z0-9]{16}`,
		String.raw`AIza[A-Za-z0-9_-]{20,}`,
		String.raw`npm_[A-Za-z0-9]{30,}`,
		String.raw`dop_v1_[a-f0-9]{32,}`,
		String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
	].join("|"),
	"g",
)

export function detectKnownSecrets(text: string): PiiMatch[] {
	return collect(text, KNOWN_SECRET, "secret")
}

/**
 * 語に続く値（`FR-PII-10b`）。
 *
 * 社内で作った鍵には決まった接頭辞が無い。`password` のような語を手がかりにする。
 * **語そのものは伏せない**（`FR-PII-10c`）。何の値が伏せられたかが読めなくなる。
 */
export const DEFAULT_SECRET_LABELS = [
	"password",
	"passwd",
	"pwd",
	"secret",
	"token",
	"api key",
	"apikey",
	"access key",
	"access token",
	"auth token",
	"client secret",
	"private key",
	"credential",
]

/** ラベルの書き方の揺れを吸収する（`FR-PII-10e`）。`api_key` も `apiKey` も同じものである。 */
function labelPattern(label: string): string {
	return label
		.split(/\s+/)
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[\\s._-]*")
}

/**
 * 値は 8 文字以上の英数字と `-` `_` に限る（`FR-PII-10d`）。`.` と `/` を含むものは値と
 * 見なさない。`password = process.env.PASSWORD` のようなコードの参照まで伏せると、
 * モデルが読むコードが壊れる。
 */
const SECRET_VALUE = String.raw`["'\`]?(?<value>[A-Za-z0-9_-]{8,})["'\`]?`

export function detectLabelledSecrets(text: string, labels: readonly string[] = DEFAULT_SECRET_LABELS): PiiMatch[] {
	const pattern = new RegExp(String.raw`(?:${labels.map(labelPattern).join("|")})\s*[:=]\s*${SECRET_VALUE}`, "gi")

	const matches: PiiMatch[] = []
	for (const found of text.matchAll(pattern)) {
		// 値の位置は、見つかった範囲の中で値を探して求める。ラベルは伏せない。
		matches.push(valueMatch(found, "secret"))
	}
	return matches
}

/** `Authorization` の `Bearer` と `Basic` に続く値（`FR-PII-10f`）。 */
const AUTHORIZATION = /\b(?:Bearer|Basic)\s+(?<value>[A-Za-z0-9._~+/=-]{8,})/g

export function detectAuthorization(text: string): PiiMatch[] {
	const matches: PiiMatch[] = []
	for (const found of text.matchAll(AUTHORIZATION)) {
		matches.push(valueMatch(found, "secret"))
	}
	return matches
}

/**
 * 郵便番号（`FR-PII-12`）。
 *
 * `〒` が付く形は確実に採る。付かない `NNN-NNNN` は電話番号や品番と重なるので、
 * 郵便番号を表す語が前にあるときだけ採る（`FR-PII-12a`）。
 */
const ZIP_WITH_MARK = /〒\s*(?<value>\d{3}-?\d{4})/g
const ZIP_WITH_LABEL = /(?:郵便番号|zip(?:[\s._-]*code)?|postal(?:[\s._-]*code)?)\s*[:=]?\s*(?<value>\d{3}-?\d{4})/gi

export function detectZipCodes(text: string): PiiMatch[] {
	const matches: PiiMatch[] = []
	for (const pattern of [ZIP_WITH_MARK, ZIP_WITH_LABEL]) {
		for (const found of text.matchAll(pattern)) {
			matches.push(valueMatch(found, "zip"))
		}
	}
	return matches
}

/**
 * 日本国内の住所（`FR-PII-13`）。
 *
 * 都道府県名または市区町村名から始まり、番地へ至る並びを 1 つのまとまりとして採る
 * （`FR-PII-13a`）。**番地を含まない並びは採らない**（`FR-PII-13c`）。「中央区の面積」は
 * 住所ではない。
 *
 * 地名の一覧は同梱する（`FR-PII-13b`）。照合のために外部へ取得しに行くのは本末転倒である。
 */
const PLACE_HEAD = /[぀-ヿ一-鿿ー々ヶケ]{1,8}?[都道府県市区町村]/g

/** 番地。`1-2-3` と `1丁目2番3号` の両方を採る。全角の数字も見る。 */
const ADDRESS_TAIL =
	/^[぀-ヿ一-鿿ー々ヶケA-Za-z0-9０-９\-‐−ー－丁目番地号の,、\s]*?[0-9０-９][0-9０-９\-‐−ー－丁目番地号]*/

export function detectAddresses(text: string): PiiMatch[] {
	const matches: PiiMatch[] = []
	for (const head of text.matchAll(PLACE_HEAD)) {
		const name = head[0]
		if (!PLACE_NAMES.has(name)) continue

		const start = head.index
		const rest = text.slice(start + name.length)
		// 数字へ届く前に文が終わっていれば住所ではない。`ADDRESS_TAIL` は数字を必須に
		// しているので、一致しなければその並びは住所ではない。
		const tail = ADDRESS_TAIL.exec(rest)
		if (!tail) continue

		const body = tail[0].replace(/\s+$/, "")
		matches.push({ kind: "address", start, end: start + name.length + body.length, value: name + body })
	}
	return matches
}

/**
 * 利用者が挙げた語（`FR-PII-03`）。
 *
 * 文字列が確定しているので誤検出が起きない。英字の大文字小文字は区別しない
 * （`FR-PII-03a`）。
 */
export function detectTerms(text: string, terms: readonly PiiTerm[]): PiiMatch[] {
	const matches: PiiMatch[] = []
	const lower = text.toLowerCase()

	for (const term of terms) {
		const needle = term.value.trim().toLowerCase()
		if (needle.length === 0) continue

		let from = 0
		for (;;) {
			const at = lower.indexOf(needle, from)
			if (at === -1) break
			matches.push({
				kind: term.kind ?? "term",
				start: at,
				end: at + needle.length,
				value: text.slice(at, at + needle.length),
			})
			from = at + needle.length
		}
	}
	return matches
}

/**
 * 名前付きの `value` を持つ一致から 1 件を作る。
 *
 * 手がかりにした語は範囲へ入れない（`FR-PII-10c`）。`value` はどの書き方でも必須なので、
 * 無い場合を分けて扱わない。
 */
function valueMatch(found: RegExpMatchArray, kind: PiiMatch["kind"]): PiiMatch {
	const value = found.groups!.value
	const start = found.index! + found[0].lastIndexOf(value)
	return { kind, start, end: start + value.length, value }
}

function collect(text: string, pattern: RegExp, kind: PiiMatch["kind"]): PiiMatch[] {
	const matches: PiiMatch[] = []
	for (const found of text.matchAll(pattern)) {
		matches.push({ kind, start: found.index, end: found.index + found[0].length, value: found[0] })
	}
	return matches
}
