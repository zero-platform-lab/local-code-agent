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
 * **誤って伏せないことを重く扱う。** 伏せることと同じ重さである。 検査や語で絞っているのは全て
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
 * **引用符か数字を要求する。** どちらも無いものは採らない。 そうしないと、
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
 * 辞書が 300 語で履歴が 200 件なら 1 回の要求で 6 万回になる。送信の直前に同期で実行されるので、
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
 * 敬称と肩書きの手前を人名として採る（`FR-PII-24`）。
 *
 * **辞書に無い氏名を拾う唯一の規則である。** 氏名は増え続けるので並べきれない。ただし
 * `〜さん` `〜部長` の直前に来るものは、高い見込みで人名である。
 *
 * **伏せるのは名前だけで、敬称と肩書きは残す。** `{{person-001}}部長` なら、モデルは
 * 役職を読める。まとめて伏せると、誰に何を頼む話か分からなくなる。
 *
 * **3 つで誤検出を抑える。**
 *
 * | 抑え方             | 何を防ぐか                                   |
 * | ------------------ | -------------------------------------------- |
 * | 前に区切りを要する | 直前の語を巻き込む（`担当は森さん` の `は`） |
 * | 4 文字まで         | 文の一部を名前として採る                     |
 * | 人名でない語を除く | `お客様` `営業部長`                          |
 *
 * **肩書きのほうが危ない。** `営業部長` は「営業部」＋「長」で、形では `山田部長` と
 * 区別が付かない。部署名を並べて除くしかない。
 */

/**
 * 名前に使う文字。カタカナ・漢字・踊り字。
 *
 * **ひらがなを入れない。** 入れると助詞が区切りとして働かず、`鈴木課長と佐藤主任` の
 * `佐藤` を取りこぼす（`と` が名前の一部と見なされる）。代わりに、ひらがなで書いた名前
 * （`たなかさん`）は採れなくなる。取りこぼしは辞書で補える。
 */
const NAME_CHAR = "[ァ-ヿ一-鿿々]"

/** 敬称。付く語は人名である見込みが高い。 */
const HONORIFICS = ["さん", "様", "氏", "くん", "ちゃん"]

/** 肩書き。長いものを先に置く。`本部長` を `部長` として採らないため。 */
const TITLES = [
	"取締役",
	"本部長",
	"副社長",
	"副部長",
	"准教授",
	"社長",
	"専務",
	"常務",
	"部長",
	"次長",
	"課長",
	"係長",
	"室長",
	"局長",
	"所長",
	"店長",
	"主任",
	"主査",
	"教授",
	"先生",
]

/** 敬称が付いても人名でない語。 */
const NOT_NAME_BEFORE_HONORIFIC = new Set([
	"お客",
	"客",
	"皆",
	"神",
	"王",
	"殿",
	"奥",
	"兄",
	"姉",
	"母",
	"父",
	"姫",
	"嬢",
	"坊",
	"御",
])

/** 肩書きが付いても人名でない語。部署や立場を表すもの。 */
const NOT_NAME_BEFORE_TITLE = new Set([
	"営業",
	"開発",
	"技術",
	"総務",
	"人事",
	"経理",
	"財務",
	"企画",
	"広報",
	"法務",
	"製造",
	"品質",
	"管理",
	"情報",
	"事業",
	"生産",
	"購買",
	"物流",
	"研究",
	"設計",
	"編集",
	"制作",
	"販売",
	"監査",
	"秘書",
	"調達",
	"保守",
	"運用",
	"教育",
	"支援",
	"担当",
	"代表",
	"副",
	"現",
	"前",
	"元",
	"新",
	"各",
	"同",
	"当",
	"弊",
	"貴",
])

/**
 * 直前に区切りを要求する。
 *
 * `(?<!...)` で「名前に使う文字が直前に無いこと」を見る。これが無いと、`昨日森さん` の
 * `昨日` まで巻き込む。
 */
const NAME_BEFORE = (suffixes: readonly string[]) =>
	new RegExp(`(?<!${NAME_CHAR})(?<value>${NAME_CHAR}{1,4})(?:${suffixes.join("|")})`, "g")

export function detectHonorificNames(text: string): PiiMatch[] {
	const matches: PiiMatch[] = []

	for (const [suffixes, deny] of [
		[HONORIFICS, NOT_NAME_BEFORE_HONORIFIC],
		[TITLES, NOT_NAME_BEFORE_TITLE],
	] as const) {
		for (const found of text.matchAll(NAME_BEFORE(suffixes))) {
			const value = found.groups?.value
			if (!value || deny.has(value)) continue

			// **より長い肩書きの一部なら採らない。** `本部長` を `本` ＋ `部長` として
			// 採ってしまう。名前と敬称を繋いだものが肩書きの一覧にあれば、それは名前でない。
			if (TITLES.some((title) => found[0].endsWith(title) && title.length > found[0].length - value.length)) {
				continue
			}

			// **敬称と肩書きは範囲へ入れない。** モデルが役職を読めなくなる。
			matches.push({ kind: "person", start: found.index, end: found.index + value.length, value })
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
 * 地名の見出しの候補。`[都道府県市区町村]` で終わる並びを貪欲に取り、一覧と突き合わせる。
 *
 * **貪欲に取る。** 短く取ると、名前の途中に `市` や `町` を含む地名（`四日市市`
 * `野々市市` `東村山市`）へ二度と届かない。短い側で一覧に当たらず、次の照合はその先から
 * 始まるためである。長く取ってから、前から順に一覧へ当てる。
 */
const PLACE_HEAD = /[぀-ヿ一-鿿ー々ヶケ]{1,9}[都道府県市区町村]/g

/** 町域。**ひらがなは `の` だけ許す。** 許すと「の面積は」のような文がそのまま入る。 */
const CHO = String.raw`[一-鿿ー々ヶケァ-ヿA-Za-z0-9０-９の]{0,12}`

/** 番地。3 つ以上に区切る形、2 つに区切る形、丁目番号の形。 */
const BANCHI_MULTI = String.raw`[0-9０-９]+(?:[-‐−ー－][0-9０-９]+){2,}`
const BANCHI_TWO = String.raw`[0-9０-９]+[-‐−ー－][0-9０-９]+`
const BANCHI_MARK = String.raw`[0-9０-９]+[丁目番地号][0-9０-９丁目番地号ー－‐−-]*`

/**
 * 町域と番地。
 *
 * **離れている場合は強く要求する。** 空白を挟むときの話である。 離れていると町域ではなく文の続き
 * である見込みが高い（「中央区の面積は 1-2 です」）。続けて書いてあるときだけ、2 つに
 * 区切る番地（`銀座1-2`）を認める。
 */
const ADDRESS_TAIL = new RegExp(
	String.raw`(?:${CHO}(?<b1>${BANCHI_MULTI}|${BANCHI_TWO}|${BANCHI_MARK})|${CHO}[ \u3000](?<b2>${BANCHI_MULTI}|${BANCHI_MARK}))`,
	// `y` は `lastIndex` の位置から始まることを要求する。`^` と写しの代わりに使う。
	"y",
)

/**
 * 日付や年度の範囲。番地と同じ形になるので、番地として採らない。
 *
 * 「南区のテスト 2024-01-02 に実施」が丸ごと住所になると、モデルは日付を読めなくなる。
 */
const DATE_LIKE = /^(?:\d{4}[-‐−ー－]\d{1,2}[-‐−ー－]\d{1,2}|\d{4}[-‐−ー－]\d{4})$/

export function detectAddresses(text: string): PiiMatch[] {
	const matches: PiiMatch[] = []

	PLACE_HEAD.lastIndex = 0
	let head: RegExpExecArray | null
	while ((head = PLACE_HEAD.exec(text)) !== null) {
		// 長く取った候補を、前から順に一覧へ当てる。`四日市市石原町` からは `四日市市`。
		let name: string | undefined
		for (let length = head[0].length; length >= 1; length--) {
			const candidate = head[0].slice(0, length)
			if (PLACE_NAMES.has(candidate)) {
				name = candidate
				break
			}
		}

		if (name === undefined) {
			PLACE_HEAD.lastIndex = head.index + 1
			continue
		}

		const start = head.index
		// **写しを作らずに、その位置から当てる。** 長い文書では、候補ごとに残り全部を
		// 写すと桁違いの無駄になる（`y` は指定した位置から始まることを要求する）。
		ADDRESS_TAIL.lastIndex = start + name.length
		const tail = ADDRESS_TAIL.exec(text)
		// 番地へ届かなければ住所ではない（`FR-PII-13c`）。
		if (!tail) {
			PLACE_HEAD.lastIndex = start + name.length
			continue
		}

		// 日付は番地ではない。
		const banchi = tail.groups?.b1 ?? tail.groups?.b2 ?? ""
		if (DATE_LIKE.test(banchi)) {
			PLACE_HEAD.lastIndex = start + name.length
			continue
		}

		const body = tail[0].replace(/\s+$/, "")
		const end = start + name.length + body.length
		matches.push({ kind: "address", start, end, value: text.slice(start, end) })
		PLACE_HEAD.lastIndex = end
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

		// **小文字の索引を借りない。** 元の文字列とずれる。 `İ` のように小文字に
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
		// **大文字小文字を区別しない。** 語をそのまま書く場合と揃える（`FR-PII-03a`）。
		// 揃えないと `/emp-\d{5}/` が `EMP-12345` に一致せず、書いた本人は気づけない。
		pattern = cachedRegExp(`regex\u0000${term.value}`, () => new RegExp(term.value, "gi"))
	} catch {
		return []
	}
	// 覚えた正規表現を共有するので、`test` で汚れた `lastIndex` を戻す。
	pattern.lastIndex = 0
	const matchesEmpty = pattern.test("")
	pattern.lastIndex = 0
	if (matchesEmpty) return []

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
