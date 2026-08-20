import { describe, it, expect } from "vitest"

import { formatPathTooltip } from "../formatPathTooltip"

describe("formatPathTooltip", () => {
	it("returns empty string for undefined path", () => {
		expect(formatPathTooltip(undefined)).toBe("")
	})

	it("returns empty string for empty string path", () => {
		expect(formatPathTooltip("")).toBe("")
	})

	it("strips leading non-alphanumeric characters and appends LRM", () => {
		expect(formatPathTooltip("/src/file.ts")).toBe("src/file.ts‎")
	})

	it("appends additional content after a space", () => {
		expect(formatPathTooltip("/src/file.ts", ":42-45")).toBe("src/file.ts‎ :42-45")
	})

	it("returns formatted path without additional content when not provided", () => {
		expect(formatPathTooltip("src/file.ts")).toBe("src/file.ts‎")
	})

	// --- Mutation kills ---
	it("includes LRM character in the output (mutation: removing LRM)", () => {
		const result = formatPathTooltip("file.ts")
		expect(result).toContain("‎")
	})

	it("places LRM before additional content (mutation: swapping order)", () => {
		const result = formatPathTooltip("/file.ts", "extra")
		// LRM must be between formatted path and additional content
		const lrmIndex = result.indexOf("‎")
		const extraIndex = result.indexOf("extra")
		expect(lrmIndex).toBeLessThan(extraIndex)
	})

	it("handles empty additionalContent (falsy check)", () => {
		expect(formatPathTooltip("/file.ts", "")).toBe("file.ts‎")
	})
})
