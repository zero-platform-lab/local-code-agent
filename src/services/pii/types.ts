import type { PiiKind } from "@openai-agent/types"

/**
 * 見つけた位置の表し方。
 *
 * 種類そのもの（`PiiKind`）は `@openai-agent/types` が持つ。設定に書ける値と検出の層が
 * 同じ一覧を使わないと、設定に書けるのに効かない種類が生まれる。
 *
 * 検出する側は「どこからどこまでが何か」だけを返し、伏せ字の割り当ては `maskText` が
 * 行う。分けておくと、種類を足しても割り当ての規則を触らずに済む。
 */

export { piiKinds as PII_KINDS } from "@openai-agent/types"
export type { PiiKind, PiiTerm } from "@openai-agent/types"

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
