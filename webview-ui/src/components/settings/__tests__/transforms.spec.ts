import { describe, it, expect } from "vitest"

import { noTransform, inputEventTransform, urlInputEventTransform } from "../transforms"

describe("transforms", () => {
	describe("noTransform", () => {
		it("returns the value unchanged", () => {
			const obj = { a: 1 }
			expect(noTransform(obj)).toBe(obj)
			expect(noTransform("x")).toBe("x")
			expect(noTransform(0)).toBe(0)
		})
	})

	describe("inputEventTransform", () => {
		it("extracts target.value from an event-like object", () => {
			expect(inputEventTransform({ target: { value: "hello" } })).toBe("hello")
		})

		it("does not trim the value", () => {
			expect(inputEventTransform({ target: { value: "  spaced  " } })).toBe("  spaced  ")
		})

		it("returns undefined when the event is null (optional chaining)", () => {
			expect(inputEventTransform(null as any)).toBeUndefined()
		})
	})

	describe("urlInputEventTransform", () => {
		it("trims the extracted value", () => {
			expect(urlInputEventTransform({ target: { value: "  https://x  " } })).toBe("https://x")
		})

		it("returns empty string when the event is null (?? branch)", () => {
			expect(urlInputEventTransform(null as any)).toBe("")
		})

		it("returns empty string when target.value is undefined (?? branch)", () => {
			expect(urlInputEventTransform({ target: {} } as any)).toBe("")
		})
	})
})
