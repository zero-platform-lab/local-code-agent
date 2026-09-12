import { PLACE_NAMES } from "./placeNames"
import type { PiiMatch, PiiTerm } from "./types"

/**
 * 機密情報の検出。
 *
 * **目的。** 本文のどこに何があるかを見つける（`FR-PII-03`〜`FR-PII-14`）。伏せるかどうか、
 * 何へ置き換えるかは決めない。
 *
 * **仕組み。** 種類ごとに 1 つの関数を持ち、`PiiMatch`（範囲と種類と値）の配列を返す。
 * 拠り所は 4 つある。
 *
 * | 拠り所         | 使う種類                                 |
 * | -------------- | ---------------------------------------- |
 * | 書式           | メールアドレス、電話番号、ホスト名、IP   |
 * | 検査           | クレジットカード（Luhn）、マイナンバー   |
 * | 前に来る語     | 鍵、郵便番号                             |
 * | 同梱の一覧     | 住所（地名）、利用者が挙げた語           |
 *
 * **しないこと。** 推定に頼る検出は置かない。人名と組織名の自動判定は誤検出が避けられず、
 * 誤って伏せるとモデルが読む内容が変わる。本文も書き換えない。位置を返すだけで、伏せ字の
 * 割り当ては `maskText` が行う。分けておくと、検出だけを本文なしで確かめられる。
 *
 * **誤って伏せないことを、伏せることと同じ重さで扱う。** 検査や語で絞っているのは全て
 * そのためである。取りこぼしは利用者が挙げる語で補えるが、誤検出は補えない。
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
/**
 * **前後に英数字が続かないことを要求する。** 無いと長い並びの先頭に一致する。時刻の値
 * `1700000000000` や、`commit 0123456789ab` のような識別子の先頭 10 桁が電話番号として
 * 伏せられ、記録が読めなくなる。
 */
const PHONE = /(?<![0-9])(?:\+81[-\s(]?|0)\d{1,4}[-\s)]?\d{1,4}[-\s]?\d{3,4}(?![0-9A-Za-z_])/g

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
/**
 * 内部向けの TLD。**公開されている TLD の一覧は持たない。**
 *
 * 「公開でないもの」を「公開の一覧に無いもの」として決めると、1,500 を超える一覧を
 * 同梱して更新し続けることになる。新しい TLD が増えるたびに、公開のドメインを誤って
 * 伏せる。こちらを数え上げるほうが小さく、誤って伏せる側にも倒れない。
 *
 * 社内が `.corp.example.co.jp` のように公開 TLD の下にある場合は、この一覧では拾えない。
 * 利用者が挙げる語で受ける（`FR-PII-03`）。
 */
const INTERNAL_TLDS = ["internal", "local", "lan", "corp", "intra", "intranet", "private", "home", "localdomain"]

/**
 * **URL の目印がある場合だけ採る。**
 *
 * `a.b.local` のような並びは、ホスト名か属性の参照かを見分けられない。label の数を数えても
 * 足りず、`this.config.local` も `obj.props.settings.local` も 3 つ以上ある。伏せると
 * モデルが読むコードが壊れる。
 *
 * そこで、ホスト名としてしか現れない目印を要求する。
 *
 * - `//` の直後（`https://git.example.internal/x`）
 * - `@` の直後（`user@host.example.corp`）
 * - 直後がポート番号（`srv.example.lan:8443`）
 *
 * 文章に裸で書かれたホスト名（`git.example.internal へ繋ぐ`）は取りこぼす。取りこぼしは
 * 利用者が挙げる語で補えるが、コードを壊すほうは補えない。
 */
const INTERNAL_HOST = new RegExp(
	String.raw`(?:(?<=//)|(?<=@))(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:${INTERNAL_TLDS.join("|")})(?=$|[\s"'` +
		"`" +
		String.raw`>,;)]|/|:)|(?:(?<=^)|(?<=[\s"'` +
		"`" +
		String.raw`<]))(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:${INTERNAL_TLDS.join("|")})(?=:\d)`,
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
	// 事業者内の共用（CGNAT）。特定の組織を表さない。
	if (a === 100 && b >= 64 && b <= 127) return true
	// マルチキャストと予約。`224.0.0.1` や、サブネットマスクの `255.255.255.0` が入る。
	// マスクを伏せると設定ファイルが読めなくなる。
	if (a >= 224) return true
	return false
}

export function detectIps(text: string): PiiMatch[] {
	const matches: PiiMatch[] = []
	for (const found of text.matchAll(IPV4)) {
		const octets = found.slice(1, 5).map((part) => Number(part))
		if (octets.some((value) => value > 255)) continue
		if (isPrivateOrClosed(octets)) continue

		// **伏せる範囲は、書かれている文字から測る。** 数に直してから長さを測ると、
		// `003.004.5.6` のように 0 で始まる書き方で範囲がずれ、戻したときに別の文字列に
		// なる。2 つ目の `.` の位置を本文から探す。
		const start = found.index
		const secondDot = found[0].indexOf(".", found[0].indexOf(".") + 1)
		const prefix = found[0].slice(0, secondDot)
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
/** 13〜19 桁。先頭の 1 桁を別に数えるので、繰り返しは 12〜18 回になる。 */
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
 * マイナンバー（個人番号、`FR-PII-14`）。
 *
 * 12 桁で、最下位の 1 桁が検査用数字である。**検算に通った並びだけ**を採る
 * （`FR-PII-14a`）。桁数だけで拾うと、連番や識別子まで伏せる。
 *
 * 検査用数字は 11 で割った余りから決まるので、でたらめな 12 桁でも 11 回に 1 回は通る。
 * クレジットカードの Luhn と同程度の絞り込みである。
 */
/**
 * 12 桁。通知カードの表記に合わせて 4 桁ずつ区切った書き方も採る。
 *
 * **語の境界を要求する。** 長い数字列の一部や識別子の中の 12 桁は、番号として書かれた
 * ものではない。境界を外すと、時刻の値や連番まで拾う。
 */
const MY_NUMBER = /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g

/**
 * 検査用数字を計算する（総務省令の定義）。
 *
 * 下位から数えて `n + 1` 桁目を `P`、重みを `Q`（`n` が 1〜6 なら `n + 1`、7〜11 なら
 * `n - 5`）として、`11 - (ΣPQ mod 11)` を採る。余りが 1 以下なら 0 とする。
 */
export function myNumberCheckDigit(first11: string): number {
	let sum = 0
	for (let n = 1; n <= 11; n++) {
		const digit = first11.charCodeAt(11 - n) - 48
		const weight = n <= 6 ? n + 1 : n - 5
		sum += digit * weight
	}
	const remainder = sum % 11
	return remainder <= 1 ? 0 : 11 - remainder
}

export function passesMyNumberCheck(digits: string): boolean {
	if (!/^\d{12}$/.test(digits)) return false
	return myNumberCheckDigit(digits.slice(0, 11)) === digits.charCodeAt(11) - 48
}

export function detectMyNumbers(text: string): PiiMatch[] {
	return collect(text, MY_NUMBER, "mynumber").filter((match) => passesMyNumberCheck(match.value.replace(/\D/g, "")))
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
 * 鍵の値。
 *
 * **引用符で囲まれているか、数字を含むものだけを採る。** そうしないと、
 * `const apiKey = defaultApiKey` の `defaultApiKey` のような普通の識別子まで伏せる。
 * モデルへ渡すコードの識別子が `{{secret-001}}` に変わり、参照の関係が読めなくなる。
 *
 * 後ろが `(` なら関数の呼び出しなので採らない（`secret: buildSecret()`）。`.` と `/` を
 * 含むものも値と見なさない（`password = process.env.PASSWORD`）。
 *
 * 数字を含まない合言葉（`changeme`）は取りこぼす。取りこぼしは利用者が挙げる語で補える。
 */
const SECRET_VALUE =
	String.raw`(?:["'` +
	"`" +
	String.raw`](?<quoted>[A-Za-z0-9_-]{8,})["'` +
	"`" +
	String.raw`]|(?<bare>[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*)(?![\w(]))`

/**
 * 組み立てた正規表現を覚えておく。
 *
 * **要求のたびに組み直さない。** 会話の item ごと、語ごとに `new RegExp` を作ると、
 * 辞書が 300 語で履歴が 200 件なら 1 回の要求で 6 万回になる。送信の直前に同期で走るので、
 * そのぶん待たされる。
 *
 * 上限を決めて、越えたら捨てる。設定を変えながら長く使っても際限なく増えない。
 */
const CACHE_LIMIT = 2000
const compiled = new Map<string, RegExp>()

/** 覚えた正規表現を捨てる。上限に達したときと、試験でこの経路を確かめるときに実行する。 */
export function clearCompiledCache(): void {
	compiled.clear()
}

function cachedRegExp(key: string, build: () => RegExp): RegExp {
	const found = compiled.get(key)
	if (found) return found

	if (compiled.size >= CACHE_LIMIT) clearCompiledCache()
	const built = build()
	compiled.set(key, built)
	return built
}

export function detectLabelledSecrets(text: string, labels: readonly string[] = DEFAULT_SECRET_LABELS): PiiMatch[] {
	// **空のラベルを外す。** 1 つでも混じると選択肢が空になり、ラベルを省略できる形へ
	// 変わって、あらゆる `名前 = 値` に一致する。設定の 1 行を消し忘れただけで起きる。
	const usable = labels.map((one) => one.trim()).filter((one) => one.length > 0)
	if (usable.length === 0) return []

	const pattern = cachedRegExp(
		`labels\u0000${usable.join("\u0000")}`,
		() => new RegExp(String.raw`(?:${usable.map(labelPattern).join("|")})\s*[:=]\s*${SECRET_VALUE}`, "gi"),
	)

	const matches: PiiMatch[] = []
	for (const found of text.matchAll(pattern)) {
		// 値の位置は、見つかった範囲の中で値を探して求める。ラベルは伏せない。
		// どちらか一方は必ず一致する。短い値は鍵ではないので採らない。
		const value = (found.groups?.quoted ?? found.groups?.bare) as string
		if (value.length < 8) continue

		const start = found.index + found[0].lastIndexOf(value)
		matches.push({ kind: "secret", start, end: start + value.length, value })
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
/**
 * 地名の見出し。`[都道府県市区町村]` で終わる 1〜8 文字を候補として拾い、一覧と突き合わせる。
 *
 * **8 文字は、いちばん長い市区町村名に合わせた上限である。** 短く取る（`?`）ので、
 * 「東京都渋谷区」からはまず「東京都」が出る。本文の全体に 1,800 語の正規表現を照合せず、
 * 候補の位置だけを集合で引ける。
 */
const PLACE_HEAD = /[぀-ヿ一-鿿ー々ヶケ]{1,8}?[都道府県市区町村]/g

/**
 * 番地。
 *
 * **番地の形を要求する。** 「まず数字が来るまで」で採ると、地名のあとの普通の文章まで
 * 飲み込む（「東京都の人口は 1400 万人です」が丸ごと住所になる）。裸の数字は番地では
 * ないので、`1-2-3` の形か `1丁目2番3号` の形だけを採る。
 *
 * 町域（`神南` `丸の内`）は 12 文字までとし、番地との間に空白を 1 つだけ許す。全角の
 * 空白は `\u3000` で書く。ソースへ直接置くと読む人に見えない。
 */
const ADDRESS_TAIL =
	/^[぀-ヿ一-鿿ー々ヶケA-Za-z0-9０-９の]{0,12}[ \u3000]?(?<banchi>(?:[0-9０-９]+(?:[-‐−ー－][0-9０-９]+)+|[0-9０-９]+[丁目番地号][0-9０-９丁目番地号ー－‐−-]*))/

/**
 * 日付や年度の範囲。番地と同じ `N-N-N` の形になるので、番地として採らない。
 *
 * 「南区のテスト 2024-01-02 に実施」が丸ごと住所になると、モデルは日付を読めなくなる。
 */
const DATE_LIKE = /^(?:\d{4}[-‐−ー－]\d{1,2}[-‐−ー－]\d{1,2}|\d{4}[-‐−ー－]\d{4})$/

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

		// 日付は番地ではない。`banchi` は正規表現が必ず捉えるので、無い場合は考えない。
		if (DATE_LIKE.test(tail.groups!.banchi)) continue

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

	for (const term of terms) {
		if (term.regex) {
			matches.push(...matchByRegex(text, term))
			continue
		}

		const needle = term.value.trim()
		if (needle.length === 0) continue

		// **小文字に直した文字列の索引を、元の文字列へ当てない。** `İ` のように小文字に
		// すると長さが変わる文字があり、そこから先の位置が全部ずれる。伏せる範囲が
		// 1 文字ずれ、伏せ残しが出て、対応表にも切れた値が入る。
		// 正規表現の `i` を使えば、索引は元の文字列のものになる。
		// `matchAll` は正規表現を写してから使うので、覚えておいても `lastIndex` は汚れない。
		const pattern = cachedRegExp(`term\u0000${needle}`, () => new RegExp(escapeForRegExp(needle), "gi"))
		for (const found of text.matchAll(pattern)) {
			matches.push({
				kind: term.kind ?? "term",
				start: found.index,
				end: found.index + found[0].length,
				value: found[0],
			})
		}
	}
	return matches
}

/**
 * 正規表現として書かれた語（`FR-PII-03f`）。
 *
 * **空に一致する書き方は使わない**（`FR-PII-03h`）。全ての位置に一致して、文書が伏せ字で
 * 埋まる。読み込む側（`parseDictionary`）で弾いてあるが、設定から直接来る場合もあるので
 * ここでも見る。
 */
function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function matchByRegex(text: string, term: PiiTerm): PiiMatch[] {
	let pattern: RegExp
	try {
		pattern = new RegExp(term.value, "g")
	} catch {
		return []
	}
	if (pattern.test("")) return []
	pattern.lastIndex = 0

	const matches: PiiMatch[] = []
	for (const found of text.matchAll(pattern)) {
		if (found[0].length === 0) continue
		matches.push({
			kind: term.kind ?? "term",
			start: found.index,
			end: found.index + found[0].length,
			value: found[0],
		})
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
