// npx vitest run src/message-utils/__tests__/safeJsonParse.spec.ts
//
// safeJsonParse は「壊れた入力でも落ちず、既定値を返す」ことが不変条件。
// 固定するのは次の点:
//   1. 妥当な JSON は型付きでパースして返す
//   2. falsy な入力（null / undefined / 空文字）は既定値を返す（parse を試みない）
//   3. 不正な JSON は console.error を出しつつ既定値を返す（throw しない）

import { safeJsonParse } from "../safeJsonParse.js"

describe("safeJsonParse", () => {
	it("妥当な JSON をパースして返す", () => {
		const result = safeJsonParse<{ a: number }>('{"a":1}')
		expect(result).toEqual({ a: 1 })
	})

	it("null は既定値を返す（parse しない）", () => {
		expect(safeJsonParse(null, "fallback")).toBe("fallback")
	})

	it("undefined は既定値を返す", () => {
		expect(safeJsonParse(undefined, 42)).toBe(42)
	})

	it("空文字は falsy として既定値を返す", () => {
		expect(safeJsonParse("", { ok: true })).toEqual({ ok: true })
	})

	it("既定値未指定で falsy 入力なら undefined を返す", () => {
		expect(safeJsonParse(null)).toBeUndefined()
	})

	it("不正な JSON は console.error を出しつつ既定値を返す", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const result = safeJsonParse("not valid json", "default")

		expect(result).toBe("default")
		expect(errorSpy).toHaveBeenCalledWith("Error parsing JSON:", expect.any(SyntaxError))

		errorSpy.mockRestore()
	})

	it("不正な JSON かつ既定値未指定なら undefined を返す", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		expect(safeJsonParse("{bad")).toBeUndefined()

		errorSpy.mockRestore()
	})
})
