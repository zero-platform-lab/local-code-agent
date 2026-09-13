/**
 * 機密情報の伏せ字で扱う種類。
 *
 * 設定（`piiMasking.kinds`）と検出の層で同じ一覧を使う。別々に持つと、設定に書けるのに
 * 効かない種類が生まれる。
 */

export const piiKinds = [
	/** 利用者が挙げた語のうち、人名と指定したもの。 */
	"person",
	/** 利用者が挙げた語のうち、組織名と指定したもの。 */
	"org",
	/** 利用者が挙げた語のうち、種類の指定が無いもの。 */
	"term",
	"email",
	"phone",
	"host",
	"ip",
	"card",
	"secret",
	"zip",
	"address",
	"mynumber",
] as const

export type PiiKind = (typeof piiKinds)[number]

/**
 * 利用者が挙げた語 1 つ（`FR-PII-03`）。種類は伏せ字の見え方だけを決める。
 *
 * `regex` が真なら `value` を正規表現として扱う（`FR-PII-03f`）。社員番号や案件コードの
 * ような形は、語を並べても追いつかない。
 */
export type PiiTerm = {
	value: string
	kind?: Extract<PiiKind, "person" | "org" | "term">
	regex?: boolean
}

/**
 * 固有名詞の検出（第 2 層）が返す区分。
 *
 * 設定（`piiMasking.properNouns.entities`）と検出の層で同じ一覧を使う。別々に持つと、
 * 設定に書けるのに効かない区分が生まれる。
 */
export const nerEntities = [
	/** 人名。 */
	"PER",
	/** 会社などの組織。 */
	"ORG",
	/** 政治的な組織。 */
	"ORG-P",
	/** その他の組織。 */
	"ORG-O",
	/** 地名。 */
	"LOC",
	/** 施設名。 */
	"INS",
	/** 製品名。既定では伏せない（`FR-PII-21b`）。 */
	"PRD",
	/** イベント名。既定では伏せない（`FR-PII-21b`）。 */
	"EVT",
] as const

export type NerEntity = (typeof nerEntities)[number]
