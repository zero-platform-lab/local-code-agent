// npx vitest run services/pii/__tests__/nerSpans.spec.ts
//
// 判定した断片から本文の位置を求める処理。
//
// **いちばん確かめたいのは、同じ文字列が 2 回出る文章である。** 判定は `O`（何でもない）の
// 断片を返さないので、返ってきた断片だけを本文から探すと前のほうを掴む。全ての断片を順に
// 突き合わせることで、これが起きないことを見る。

import { alignTokens, groupEntities, type ClassifiedToken, type TokenSpan } from "../nerSpans"

describe("alignTokens（FR-PII-21e）", () => {
	it("断片を順に突き合わせ、範囲を返す", () => {
		expect(alignTokens("担当は鈴木", ["担当", "は", "鈴木"])).toEqual([
			{ start: 0, end: 2 },
			{ start: 2, end: 3 },
			{ start: 3, end: 5 },
		])
	})

	it("特殊な印は幅を持たない", () => {
		const spans = alignTokens("鈴木", ["<s>", "鈴木", "</s>"])

		expect(spans).toEqual([null, { start: 0, end: 2 }, null])
	})

	it("語の切れ目の印は外してから探す", () => {
		// SentencePiece が付ける印で、本文には無い。外さないと 1 つも一致しない。
		expect(alignTokens("Docker と React", ["▁Docker", "▁と", "▁React"])).toEqual([
			{ start: 0, end: 6 },
			{ start: 7, end: 8 },
			{ start: 9, end: 14 },
		])
	})

	it("印だけの断片は幅を持たない", () => {
		expect(alignTokens("鈴木", ["▁", "鈴木"])).toEqual([null, { start: 0, end: 2 }])
	})

	it("本文に無い断片は捨てる", () => {
		// 分け方が本文を正規化していると起きる。推測で範囲を作らない。
		expect(alignTokens("鈴木", ["佐藤", "鈴木"])).toEqual([null, { start: 0, end: 2 }])
	})

	it("同じ文字列が 2 回出ても、後ろのほうを取り違えない", () => {
		// この試験がこのファイルの理由である。
		const text = "森林の話。森さんが来た。"
		const pieces = ["森", "林", "の", "話", "。", "森", "さん", "が", "来", "た", "。"]

		const spans = alignTokens(text, pieces)

		expect(spans[0]).toEqual({ start: 0, end: 1 })
		// 5 文字目の「森」。0 文字目を掴んだら誤りである。
		expect(spans[5]).toEqual({ start: 5, end: 6 })
	})
})

describe("groupEntities（FR-PII-21）", () => {
	const token = (index: number, entity: string, score = 0.99): ClassifiedToken => ({
		index,
		entity,
		score,
		word: "",
	})

	it("同じ種類で隣り合う断片をまとめる", () => {
		const text = "田中太郎"
		const spans: TokenSpan[] = [
			{ start: 0, end: 2 },
			{ start: 2, end: 4 },
		]

		expect(groupEntities(text, spans, [token(0, "PER"), token(1, "PER")])).toEqual([
			{ entity: "PER", score: 0.99, start: 0, end: 4, value: "田中太郎" },
		])
	})

	it("種類が変われば切る", () => {
		const text = "田中アクメ"
		const spans: TokenSpan[] = [
			{ start: 0, end: 2 },
			{ start: 2, end: 5 },
		]

		const groups = groupEntities(text, spans, [token(0, "PER"), token(1, "ORG")])

		expect(groups.map((one) => one.value)).toEqual(["田中", "アクメ"])
	})

	it("本文の上で離れていれば切る", () => {
		// 間に `O` の断片があったということである。
		const text = "鈴木と佐藤"
		const spans: TokenSpan[] = [
			{ start: 0, end: 2 },
			{ start: 3, end: 5 },
		]

		const groups = groupEntities(text, spans, [token(0, "PER"), token(1, "PER")])

		expect(groups.map((one) => one.value)).toEqual(["鈴木", "佐藤"])
	})

	it("区切りの文字で切る（`佐藤。森` を 1 つにしない）", () => {
		// 判定は区切りの文字にも種類を付けることがある。
		const text = "佐藤。森"
		const spans: TokenSpan[] = [
			{ start: 0, end: 2 },
			{ start: 2, end: 3 },
			{ start: 3, end: 4 },
		]

		const groups = groupEntities(text, spans, [token(0, "PER"), token(1, "PER"), token(2, "PER")])

		expect(groups.map((one) => one.value)).toEqual(["佐藤", "森"])
	})

	it("位置を求められなかった断片は捨て、そこで切る", () => {
		const text = "鈴木佐藤"
		const spans: TokenSpan[] = [{ start: 0, end: 2 }, null, { start: 2, end: 4 }]

		const groups = groupEntities(text, spans, [token(0, "PER"), token(1, "PER"), token(2, "PER")])

		expect(groups.map((one) => one.value)).toEqual(["鈴木", "佐藤"])
	})

	it("塊の確度は、最も低い断片に合わせる", () => {
		// 弱い断片が混じった塊を、強い断片の確度で通さない。
		const text = "田中太郎"
		const spans: TokenSpan[] = [
			{ start: 0, end: 2 },
			{ start: 2, end: 4 },
		]

		const groups = groupEntities(text, spans, [token(0, "PER", 0.99), token(1, "PER", 0.42)])

		expect(groups[0].score).toBe(0.42)
	})

	it("並びが前後していても、索引の順に扱う", () => {
		const text = "田中太郎"
		const spans: TokenSpan[] = [
			{ start: 0, end: 2 },
			{ start: 2, end: 4 },
		]

		const groups = groupEntities(text, spans, [token(1, "PER"), token(0, "PER")])

		expect(groups).toHaveLength(1)
		expect(groups[0].value).toBe("田中太郎")
	})
})
