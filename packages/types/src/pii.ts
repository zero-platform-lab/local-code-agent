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
