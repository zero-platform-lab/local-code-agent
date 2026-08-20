// npx vitest run shared/__tests__/array.spec.ts

import { findLastIndex, findLast } from "../array"

describe("findLastIndex", () => {
	it("述語を満たす最後の要素の添字を返す", () => {
		expect(findLastIndex([1, 2, 3, 2, 1], (v) => v === 2)).toBe(3)
	})

	it("index と array を述語へ渡す", () => {
		const seenIndices: number[] = []
		findLastIndex([10, 20], (_v, i, arr) => {
			seenIndices.push(i)
			expect(arr).toEqual([10, 20])
			return false
		})
		// 降順に走査
		expect(seenIndices).toEqual([1, 0])
	})

	it("該当が無ければ -1", () => {
		expect(findLastIndex([1, 2, 3], (v) => v === 99)).toBe(-1)
	})

	it("空配列は -1", () => {
		expect(findLastIndex([], () => true)).toBe(-1)
	})
})

describe("findLast", () => {
	it("述語を満たす最後の要素を返す", () => {
		expect(findLast([1, 2, 3, 2], (v) => v === 2)).toBe(2)
		expect(findLast(["a", "bb", "c"], (v) => v.length === 1)).toBe("c")
	})

	it("該当が無ければ undefined", () => {
		expect(findLast([1, 2, 3], (v) => v === 99)).toBeUndefined()
	})
})
