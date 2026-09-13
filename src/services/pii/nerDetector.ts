import type { PiiKind, PiiMatch } from "./types"

import type { EntitySpan } from "./nerSpans"

/**
 * 判定した固有名詞を、伏せる対象へ絞り込む。
 *
 * **目的。** 第 2 層が返したものから、実際に伏せるものだけを採る（`FR-PII-21`）。位置を
 * 求めるのは `nerSpans`、置き換えるのは `maskText` で、ここは絞り込みだけを行う。
 *
 * **絞り込みは 3 つある。**
 *
 * | 絞り込み     | 何を落とすか                                     | 要件           |
 * | ------------ | ------------------------------------------------ | -------------- |
 * | 確度         | 自信の無い判定                                   | `FR-PII-21d`   |
 * | 区分         | 伏せないと決めた区分（製品名など）               | `FR-PII-21a` `FR-PII-21b` |
 * | 第 1 層と重複 | 形で確実に取れているもの                         | `FR-PII-21f`   |
 *
 * **誤って伏せないことを重く扱う。** 第 1 層と同じ姿勢である。取りこぼしは利用者が語を
 * 挙げて補えるが、誤検出は補えない。迷う場面では採らない側へ倒す。
 */

/** 判定が返す区分。 */
export const NER_ENTITIES = ["PER", "ORG", "ORG-P", "ORG-O", "LOC", "INS", "PRD", "EVT"] as const

export type NerEntity = (typeof NER_ENTITIES)[number]

/**
 * 区分を伏せ字の種類へ対応させる。
 *
 * 組織・政治的組織・その他組織・施設は、利用者から見ればどれも「組織の名前」なので
 * `org` にまとめる。分けても伏せ字の見え方が増えるだけで、守るものは変わらない。
 */
const ENTITY_KIND: Record<NerEntity, PiiKind> = {
	PER: "person",
	ORG: "org",
	"ORG-P": "org",
	"ORG-O": "org",
	LOC: "address",
	INS: "org",
	PRD: "term",
	EVT: "term",
}

/**
 * 既定で伏せる区分（`FR-PII-21b`）。
 *
 * **製品名とイベント名を入れない。** `React` や `Docker` が伏せ字になると、モデルは
 * 何の話か判断できなくなる。守るものも無い。
 */
export const DEFAULT_ENTITIES: readonly NerEntity[] = ["PER", "ORG", "ORG-P", "ORG-O", "LOC", "INS"]

/**
 * 確度の下限の既定（`FR-PII-21d`）。
 *
 * 実測では、電子メールの断片が 0.25 と 0.34 で返り、氏名・社名・住所は 0.93 以上だった。
 * この間に置く。下げると誤検出が入り、誤検出はモデルが読む内容を変える。
 */
export const DEFAULT_MIN_SCORE = 0.9

export type NerOptions = {
	/** 確度の下限。既定は `DEFAULT_MIN_SCORE`。 */
	minScore?: number
	/** 伏せる区分。既定は `DEFAULT_ENTITIES`。 */
	entities?: readonly NerEntity[]
}

/** 区分が判定の返す 8 つのどれかであること。 */
function isKnown(entity: string): entity is NerEntity {
	return (NER_ENTITIES as readonly string[]).includes(entity)
}

/**
 * 判定した固有名詞を、伏せる対象へ直す。
 *
 * 知らない区分は捨てる。モデルを差し替えたときに、対応の分からないものを
 * 黙って伏せないようにするためである。
 */
export function toPiiMatches(spans: readonly EntitySpan[], options: NerOptions = {}): PiiMatch[] {
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE
	const wanted = new Set<string>(options.entities ?? DEFAULT_ENTITIES)

	const matches: PiiMatch[] = []
	for (const span of spans) {
		if (span.score < minScore) continue
		if (!wanted.has(span.entity)) continue
		if (!isKnown(span.entity)) continue
		// 幅の無い範囲は置き換えようがない。
		if (span.end <= span.start) continue

		matches.push({ kind: ENTITY_KIND[span.entity], start: span.start, end: span.end, value: span.value })
	}

	return matches
}

/**
 * 第 1 層と重なるものを捨てる（`FR-PII-21f`）。
 *
 * **第 1 層を優先する。** 第 1 層は形で判定していて確実なので、推定側を採る理由が無い。
 * 少しでも重なれば捨てる。伏せ字の中へ別の伏せ字は置けない。
 */
export function dropOverlapping(found: readonly PiiMatch[], layerOne: readonly PiiMatch[]): PiiMatch[] {
	return found.filter((one) => !layerOne.some((other) => one.start < other.end && other.start < one.end))
}
