import { seekSequence } from "../seek-sequence"

describe("seek-sequence", () => {
	describe("seekSequence", () => {
		function toVec(strings: string[]): string[] {
			return strings
		}

		it("should match exact sequence", () => {
			const lines = toVec(["foo", "bar", "baz"])
			const pattern = toVec(["bar", "baz"])
			expect(seekSequence(lines, pattern, 0, false)).toBe(1)
		})

		it("should return start for empty pattern", () => {
			const lines = toVec(["foo", "bar"])
			const pattern = toVec([])
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
			expect(seekSequence(lines, pattern, 5, false)).toBe(5)
		})

		it("should return null when pattern is longer than input", () => {
			const lines = toVec(["just one line"])
			const pattern = toVec(["too", "many", "lines"])
			expect(seekSequence(lines, pattern, 0, false)).toBeNull()
		})

		it("should match ignoring trailing whitespace", () => {
			const lines = toVec(["foo   ", "bar\t\t"])
			const pattern = toVec(["foo", "bar"])
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
		})

		it("should match ignoring leading and trailing whitespace", () => {
			const lines = toVec(["    foo   ", "   bar\t"])
			const pattern = toVec(["foo", "bar"])
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
		})

		it("should respect start parameter", () => {
			const lines = toVec(["foo", "bar", "foo", "baz"])
			const pattern = toVec(["foo"])
			// Starting at 0 should find first foo
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
			// Starting at 1 should find second foo
			expect(seekSequence(lines, pattern, 1, false)).toBe(2)
		})

		it("should search from end when eof is true", () => {
			const lines = toVec(["foo", "bar", "foo", "baz"])
			const pattern = toVec(["foo", "baz"])
			// With eof=true, should find at the end
			expect(seekSequence(lines, pattern, 0, true)).toBe(2)
		})

		it("should prefer the last match when eof is true and the pattern repeats", () => {
			// 同じ並びがファイル内で複数回現れる場合、eof=true は末尾側の一致を選ぶ。
			// (パターンが 1 度しか一致しない従来テストでは start=0 と end 起点を区別できないため、
			//  複数一致で「末尾優先」を固定する)
			const lines = toVec(["foo", "baz", "mid", "foo", "baz"])
			const pattern = toVec(["foo", "baz"])
			// eof=false は先頭一致(0)、eof=true は末尾一致(3)。
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
			expect(seekSequence(lines, pattern, 0, true)).toBe(3)
		})

		it("should handle Unicode normalization - dashes", () => {
			// EN DASH (\u2013) and NON-BREAKING HYPHEN (\u2011) → ASCII '-'
			const lines = toVec(["hello \u2013 world \u2011 test"])
			const pattern = toVec(["hello - world - test"])
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
		})

		it("should handle Unicode normalization - quotes", () => {
			// Fancy single quotes → ASCII '\''
			const lines = toVec(["it\u2019s working"]) // RIGHT SINGLE QUOTATION MARK
			const pattern = toVec(["it's working"])
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
		})

		it("should handle Unicode normalization - double quotes", () => {
			// Fancy double quotes → ASCII '"'
			const lines = toVec(["\u201Chello\u201D"]) // LEFT/RIGHT DOUBLE QUOTATION MARK
			const pattern = toVec(['"hello"'])
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
		})

		it("should handle Unicode normalization - non-breaking space", () => {
			// Non-breaking space (\u00A0) → normal space
			const lines = toVec(["hello\u00A0world"])
			const pattern = toVec(["hello world"])
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
		})

		it("should return null when pattern not found", () => {
			const lines = toVec(["foo", "bar", "baz"])
			const pattern = toVec(["qux"])
			expect(seekSequence(lines, pattern, 0, false)).toBeNull()
		})

		it("should return null when start is past possible match", () => {
			const lines = toVec(["foo", "bar", "baz"])
			const pattern = toVec(["foo", "bar"])
			// Starting at 2, there's not enough room for a 2-line pattern
			expect(seekSequence(lines, pattern, 2, false)).toBeNull()
		})

		// Unicode 正規化パス(Pass 4)は行/パターンが undefined でも例外を出さず
		// 空文字扱いにフォールバックする防御的契約。異常入力でも壊さない不変条件を固定する。
		it("should tolerate an undefined line entry in the normalized pass", () => {
			// index 0 は EN DASH でしか一致しないため Pass 1-3 を全て素通りし Pass 4 に到達する。
			// index 1 の行は undefined なので `lines[i] ?? ""` の空文字フォールバックが働く。
			const lines = ["–", undefined as unknown as string]
			const pattern = ["-", ""]
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
		})

		it("should tolerate an undefined pattern entry in the normalized pass", () => {
			// 対になる `pattern[i] ?? ""` 側のフォールバックを踏む。
			const lines = ["–", ""]
			const pattern = ["-", undefined as unknown as string]
			expect(seekSequence(lines, pattern, 0, false)).toBe(0)
		})
	})
})
