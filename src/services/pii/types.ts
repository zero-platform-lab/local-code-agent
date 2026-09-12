/**
 * 伏せる情報の種類と、見つけた位置の表し方。
 *
 * 検出する側は「どこからどこまでが何か」だけを返し、伏せ字の割り当ては
 * `maskText` が行う。分けておくと、種類を足しても割り当ての規則を触らずに済む。
 */

/** 伏せる情報の種類（`FR-PII-07`）。伏せ字の `{{種類-番号}}` の種類にそのまま使う。 */
export type PiiKind =
	/** 利用者が挙げた語のうち、人名と指定したもの。 */
	| "person"
	/** 利用者が挙げた語のうち、組織名と指定したもの。 */
	| "org"
	/** 利用者が挙げた語のうち、種類の指定が無いもの。 */
	| "term"
	| "email"
	| "phone"
	| "host"
	| "ip"
	| "card"
	| "secret"
	| "zip"
	| "address"
	| "mynumber"

export const PII_KINDS: readonly PiiKind[] = [
	"person",
	"org",
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
]

/**
 * 見つけた 1 件。
 *
 * `start` と `end` は元の文字列の索引で、`end` は含まない。**伏せるのはこの範囲だけ**で、
 * 手がかりにした語（`password` など）は範囲へ入れない（`FR-PII-10c`）。IP も割り当て先を
 * 表す先頭 2 オクテットだけが範囲になる（`FR-PII-06d`）。
 */
export type PiiMatch = {
	kind: PiiKind
	start: number
	end: number
	value: string
}

/** 利用者が挙げた語 1 つ（`FR-PII-03`）。種類は伏せ字の見え方だけを決める。 */
export type PiiTerm = {
	value: string
	kind?: Extract<PiiKind, "person" | "org" | "term">
}
