// npx vitest run services/pii/__tests__/nerDetector.spec.ts
//
// 判定した固有名詞の絞り込み。
//
// **誤って伏せないことを確かめる試験である。** 取りこぼしは利用者が語を挙げて補えるが、
// 誤検出は補えない。確度・区分・第 1 層との重なりの 3 つで落とす。

import type { PiiMatch } from "../types"
import type { EntitySpan } from "../nerSpans"
import { DEFAULT_MIN_SCORE, dropOverlapping, toPiiMatches, type NerEntity } from "../nerDetector"

const span = (entity: string, value: string, score = 0.99, start = 0): EntitySpan => ({
	entity,
	score,
	start,
	end: start + value.length,
	value,
})

describe("toPiiMatches（FR-PII-21）", () => {
	it.each([
		["PER", "person"],
		["ORG", "org"],
		["ORG-P", "org"],
		["ORG-O", "org"],
		["INS", "org"],
		["LOC", "address"],
	])("%s は %s になる", (entity, kind) => {
		expect(toPiiMatches([span(entity, "サンプル")])).toEqual([{ kind, start: 0, end: 4, value: "サンプル" }])
	})

	it("確度が下限に満たなければ採らない（FR-PII-21d）", () => {
		expect(toPiiMatches([span("PER", "森", DEFAULT_MIN_SCORE - 0.01)])).toEqual([])
	})

	it("下限はちょうどの値を含む", () => {
		expect(toPiiMatches([span("PER", "森", DEFAULT_MIN_SCORE)])).toHaveLength(1)
	})

	it("下限は設定できる", () => {
		expect(toPiiMatches([span("PER", "森", 0.5)], { minScore: 0.4 })).toHaveLength(1)
	})

	it.each([["PRD"], ["EVT"]])("%s は既定では採らない（FR-PII-21b）", (entity) => {
		// React が伏せ字になると、モデルは何の話か判断できなくなる。
		expect(toPiiMatches([span(entity, "React")])).toEqual([])
	})

	it("区分を指定すれば製品名も採れる（FR-PII-21a）", () => {
		expect(toPiiMatches([span("PRD", "React")], { entities: ["PRD"] })).toEqual([
			{ kind: "term", start: 0, end: 5, value: "React" },
		])
	})

	it("区分を絞れば、外したものは採らない", () => {
		const spans = [span("PER", "森"), span("ORG", "サンプル", 0.99, 2)]

		expect(toPiiMatches(spans, { entities: ["PER"] })).toEqual([{ kind: "person", start: 0, end: 1, value: "森" }])
	})

	it("知らない区分は、指定されていても採らない", () => {
		// モデルを差し替えたとき、対応の分からないものを黙って伏せないため。
		const unknown = ["MISC"] as unknown as NerEntity[]

		expect(toPiiMatches([span("MISC", "何か")], { entities: unknown })).toEqual([])
	})

	it("幅の無い範囲は採らない", () => {
		expect(toPiiMatches([{ entity: "PER", score: 0.99, start: 3, end: 3, value: "" }])).toEqual([])
	})
})

describe("dropOverlapping（FR-PII-21f）", () => {
	const layerOne: PiiMatch[] = [{ kind: "email", start: 10, end: 20, value: "a@b.example" }]
	const at = (start: number, end: number): PiiMatch => ({ kind: "person", start, end, value: "x" })

	it.each([
		["前が重なる", 5, 12],
		["後ろが重なる", 18, 25],
		["内側に入る", 12, 15],
		["外側から包む", 5, 25],
		["端がちょうど重なる", 19, 21],
	])("%s なら捨てる", (_label, start, end) => {
		expect(dropOverlapping([at(start, end)], layerOne)).toEqual([])
	})

	it.each([
		["手前で終わる", 0, 10],
		["後ろから始まる", 20, 30],
	])("%s なら残す", (_label, start, end) => {
		// 接しているだけで重なっていない。
		expect(dropOverlapping([at(start, end)], layerOne)).toHaveLength(1)
	})

	it("第 1 層が空なら、そのまま残す", () => {
		expect(dropOverlapping([at(0, 5)], [])).toHaveLength(1)
	})
})
