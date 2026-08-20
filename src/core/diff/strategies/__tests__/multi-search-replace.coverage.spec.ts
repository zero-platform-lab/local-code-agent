// npx vitest run core/diff/strategies/__tests__/multi-search-replace.coverage.spec.ts
//
// 既存 spec が届かない分岐を埋める:
// - getName / getProgressStatus
// - validateMarkerSequencing の各遷移（merge-conflict / invalid の別）
// - applyDiff: validseq 失敗の早期 return・行番号 startLine 復元・同一内容・空 search・
//   バッファ探索・一致なし・aggressive strip で search が空になる経路

import { MultiSearchReplaceDiffStrategy } from "../multi-search-replace"

const SEARCH = "<<<<<<< SEARCH"
const SEP = "======="
const REPLACE = ">>>>>>> REPLACE"

describe("MultiSearchReplaceDiffStrategy 追加カバレッジ", () => {
	let strategy: MultiSearchReplaceDiffStrategy

	beforeEach(() => {
		strategy = new MultiSearchReplaceDiffStrategy() // 既定 threshold 1.0
	})

	describe("getName", () => {
		it("戦略名を返す", () => {
			expect(strategy.getName()).toBe("MultiSearchReplace")
		})
	})

	describe("getProgressStatus", () => {
		it("diff 無しなら空オブジェクト", () => {
			expect(strategy.getProgressStatus({ params: {} } as any)).toEqual({})
		})

		it("partial かつ length/10%10===0 なら SEARCH 数を返す", () => {
			// 短い diff（length<10）→ floor(len/10)=0 → 0%10===0
			const status = strategy.getProgressStatus({ params: { diff: "SEARCH" }, partial: true } as any)
			expect(status).toEqual({ icon: "diff-multiple", text: "1" })
		})

		it("partial だが length/10%10!==0 なら空（モジュロ非0）", () => {
			// length 12 → floor(12/10)=1 → 1%10=1 → 条件不成立
			const status = strategy.getProgressStatus({ params: { diff: "abcdefghijkl" }, partial: true } as any)
			expect(status).toEqual({})
		})

		it("非 partial・result に failParts があれば成功数/総数を返す", () => {
			const diff = "aa SEARCH bb SEARCH cc" // SEARCH 2 個
			const status = strategy.getProgressStatus(
				{ params: { diff }, partial: false } as any,
				{
					success: false,
					failParts: [{ success: false }],
				} as any,
			)
			expect(status).toEqual({ icon: "diff-multiple", text: "1/2" })
		})

		it("非 partial・result に failParts が無ければ総数を返す", () => {
			const diff = "one SEARCH here"
			const status = strategy.getProgressStatus(
				{ params: { diff }, partial: false } as any,
				{
					success: true,
				} as any,
			)
			expect(status).toEqual({ icon: "diff-multiple", text: "1" })
		})

		it("非 partial・result 無しなら空", () => {
			const status = strategy.getProgressStatus({ params: { diff: "SEARCH" }, partial: false } as any)
			expect(status).toEqual({})
		})

		it("partial・SEARCH を含まない diff なら数は 0（match が null → [] の既定側）", () => {
			// "abc"(len 3) → floor(3/10)=0 → 条件成立。SEARCH は含まないので 0。
			const status = strategy.getProgressStatus({ params: { diff: "abc" }, partial: true } as any)
			expect(status).toEqual({ icon: "diff-multiple", text: "0" })
		})

		it("非 partial・SEARCH を含まない diff なら数は 0（match が null → [] の既定側）", () => {
			const status = strategy.getProgressStatus(
				{ params: { diff: "no marker here" }, partial: false } as any,
				{
					success: true,
				} as any,
			)
			expect(status).toEqual({ icon: "diff-multiple", text: "0" })
		})
	})

	describe("validateMarkerSequencing の各遷移", () => {
		const validate = (diff: string) => strategy["validateMarkerSequencing"](diff)

		it("START: 先頭が SEP かつ構造が整合的なら merge-conflict 扱い", () => {
			const diff = [SEP, SEARCH, "content", SEP, "new", REPLACE].join("\n")
			const r = validate(diff)
			expect(r.success).toBe(false)
			expect(r.error).toContain("When removing merge conflict markers")
		})

		it("START: 先頭が REPLACE なら malformed", () => {
			const r = validate(REPLACE)
			expect(r.success).toBe(false)
			expect(r.error).toContain("Diff block is malformed")
		})

		it("START: '>>>>>>>' で始まる別マーカーは merge-conflict", () => {
			const r = validate(">>>>>>> mine")
			expect(r.success).toBe(false)
			expect(r.error).toContain("When removing merge conflict markers")
		})

		it("AFTER_SEARCH: 再度 SEARCH は malformed", () => {
			const diff = [SEARCH, SEARCH].join("\n")
			const r = validate(diff)
			expect(r.success).toBe(false)
			expect(r.error).toContain("Diff block is malformed")
		})

		it("AFTER_SEARCH: '<<<<<<<' で始まる別マーカーは merge-conflict", () => {
			const diff = [SEARCH, "<<<<<<< theirs"].join("\n")
			const r = validate(diff)
			expect(r.success).toBe(false)
			expect(r.error).toContain("When removing merge conflict markers")
		})

		it("AFTER_SEPARATOR: SEARCH が来たら malformed", () => {
			const diff = [SEARCH, "content", SEP, SEARCH].join("\n")
			const r = validate(diff)
			expect(r.success).toBe(false)
			expect(r.error).toContain("Diff block is malformed")
		})

		it("AFTER_SEPARATOR: '<<<<<<<' で始まる別マーカーは merge-conflict", () => {
			const diff = [SEARCH, "content", SEP, "<<<<<<< theirs"].join("\n")
			const r = validate(diff)
			expect(r.success).toBe(false)
			expect(r.error).toContain("When removing merge conflict markers")
		})

		it("AFTER_SEPARATOR: SEP 重複かつ構造不整合なら malformed", () => {
			// SEARCH=1, SEP=2, REPLACE=0 → likelyBadStructure=true
			const diff = [SEARCH, "content", SEP, SEP].join("\n")
			const r = validate(diff)
			expect(r.success).toBe(false)
			expect(r.error).toContain("Diff block is malformed")
		})

		it("AFTER_SEPARATOR: '>>>>>>>' で始まる別マーカーは merge-conflict", () => {
			const diff = [SEARCH, "content", SEP, "new", ">>>>>>> theirs"].join("\n")
			const r = validate(diff)
			expect(r.success).toBe(false)
			expect(r.error).toContain("When removing merge conflict markers")
		})

		it("末尾が AFTER_SEARCH 状態なら '=======' を期待するメッセージ", () => {
			const diff = [SEARCH, "content only, no separator"].join("\n")
			const r = validate(diff)
			expect(r.success).toBe(false)
			expect(r.error).toContain("Expected '======='")
		})
	})

	describe("applyDiff の分岐", () => {
		it("validateMarkerSequencing が失敗すると適用せずエラーを返す（早期 return）", async () => {
			const result = await strategy.applyDiff("original\n", REPLACE)
			expect(result.success).toBe(false)
			expect((result as any).error).toBeTruthy()
		})

		it("search と replace が同一なら失敗（識別不能）", async () => {
			const diff = [SEARCH, "same line", SEP, "same line", REPLACE].join("\n")
			const result = await strategy.applyDiff("same line\n", diff)
			expect(result.success).toBe(false)
			expect(JSON.stringify(result)).toContain("identical")
		})

		it("空の search 内容は許可しない", async () => {
			const diff = [SEARCH, SEP, "insert me", REPLACE].join("\n")
			const result = await strategy.applyDiff("line1\nline2\n", diff)
			expect(result.success).toBe(false)
			expect(JSON.stringify(result)).toContain("Empty search content is not allowed")
		})

		it("行番号付き（:start_line: なし）は先頭行番号から startLine を復元して適用", async () => {
			const original = "const x = 1\n"
			const diff = [SEARCH, "1 | const x = 1", SEP, "1 | const x = 2", REPLACE].join("\n")
			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(true)
			expect((result as any).content).toContain("const x = 2")
		})

		it(":start_line: が実際の位置とずれても、バッファ探索で見つけて適用", async () => {
			const original = ["line0", "line1", "TARGET", "line3"].join("\n")
			const diff = [SEARCH, ":start_line:1", "-------", "TARGET", SEP, "REPLACED", REPLACE].join("\n")
			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(true)
			expect((result as any).content).toContain("REPLACED")
		})

		it("一致なし（:start_line: あり）: 行番号付きのエラーと '(no match)' を返す", async () => {
			const original = ["aaaa", "bbbb", "cccc"].join("\n")
			// original と 1 文字も共有しない検索語 → 類似度 0 → bestMatchContent は空
			const diff = [SEARCH, ":start_line:2", "-------", "zzzz", SEP, "yyyy", REPLACE].join("\n")
			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(false)
			const text = JSON.stringify(result)
			expect(text).toContain("No sufficiently similar match found")
			expect(text).toContain("at line: 2")
			expect(text).toContain("(no match)")
		})

		it("一致なし（:start_line: なし）: 行範囲表記なしのエラー", async () => {
			const original = ["aaaa", "bbbb", "cccc"].join("\n")
			const diff = [SEARCH, "zzzz", SEP, "yyyy", REPLACE].join("\n")
			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(false)
			const text = JSON.stringify(result)
			expect(text).toContain("No sufficiently similar match found")
			expect(text).toContain("start to end")
		})

		it("aggressive strip で一致し、replace が空になれば削除として適用（replaceContent 空の既定側）", async () => {
			// "| foo": everyLineHasLineNumbers=false（数字が無い）→ 通常 strip されない。
			// 通常検索 "| foo" は original "foo" と 0.6 類似で閾値 1.0 未満 → aggressive strip。
			// aggressive strip: search "| foo"→"foo"（一致）, replace "| "→""（空）→ replaceLines=[] で削除。
			const original = "foo"
			const diff = [SEARCH, "| foo", SEP, "| ", REPLACE].join("\n")
			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(true)
			// "foo" 行が削除され空になる
			expect((result as any).content).toBe("")
		})

		it("aggressive strip で search が空になっても落ちず、一致なしを返す（getSimilarity の空検索経路）", async () => {
			// "5 | "（行番号のみ・本文なし）: 通常検索は失敗、aggressive strip で "" になり
			// getSimilarity(search="") → 0。例外を出さず一致なしで返る。
			const original = ["totally different content here"].join("\n")
			const diff = [SEARCH, "5 | ", SEP, "replacement", REPLACE].join("\n")
			const result = await strategy.applyDiff(original, diff)
			expect(result.success).toBe(false)
		})
	})
})
