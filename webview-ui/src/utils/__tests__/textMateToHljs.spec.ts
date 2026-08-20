import { describe, it, expect, vi, beforeEach } from "vitest"

import { convertTextMateToHljs } from "../textMateToHljs"

describe("convertTextMateToHljs", () => {
	beforeEach(() => {
		// Mock getComputedStyle for the fallback theme
		vi.spyOn(window, "getComputedStyle").mockReturnValue({
			getPropertyValue: vi.fn().mockReturnValue("#1e1e1e"),
		} as any)
	})

	it("converts TextMate theme rules to hljs class map", () => {
		const theme = {
			rules: [
				{ token: "comment", foreground: "#008000" },
				{ token: "keyword", foreground: "#0000ff" },
				{ token: "string", foreground: "#a31515" },
			],
		}
		const result = convertTextMateToHljs(theme)

		expect(result[".hljs-comment"]).toBe("#008000")
		expect(result[".hljs-keyword"]).toBe("#0000ff")
		expect(result[".hljs-string"]).toBe("#a31515")
	})

	it("handles null/undefined input by using fallback theme", () => {
		const result = convertTextMateToHljs(null)
		// Should return the dark fallback theme since #1e1e1e is dark
		expect(result[".hljs-comment"]).toBe("#6A9955")
	})

	it("handles empty rules by using fallback theme", () => {
		const result = convertTextMateToHljs({ rules: [] })
		expect(Object.keys(result).length).toBeGreaterThan(0)
	})

	it("handles rules without foreground or token", () => {
		const theme = {
			rules: [
				{ token: "comment" }, // Missing foreground
				{ foreground: "#ff0000" }, // Missing token
				{ token: "keyword", foreground: "#0000ff" }, // Valid
			],
		}
		const result = convertTextMateToHljs(theme)

		expect(result[".hljs-keyword"]).toBe("#0000ff")
	})

	it("handles missing rules property by using fallback theme", () => {
		const result = convertTextMateToHljs({})
		expect(Object.keys(result).length).toBeGreaterThan(0)
	})

	it("falls back to dark theme for dark backgrounds", () => {
		vi.spyOn(window, "getComputedStyle").mockReturnValue({
			getPropertyValue: vi.fn().mockReturnValue("#1e1e1e"),
		} as any)

		const result = convertTextMateToHljs({})
		// Dark theme should have dark-theme-specific colors
		expect(result[".hljs-comment"]).toBe("#6A9955")
		expect(result[".hljs-keyword"]).toBe("#569cd6")
	})

	it("falls back to light theme for light backgrounds", () => {
		vi.spyOn(window, "getComputedStyle").mockReturnValue({
			getPropertyValue: vi.fn().mockReturnValue("#ffffff"),
		} as any)

		const result = convertTextMateToHljs({})
		// Light theme should have light-theme-specific colors
		expect(result[".hljs-comment"]).toBe("#008000")
		expect(result[".hljs-keyword"]).toBe("#0000ff")
	})

	it("maps hljs classes using the first matching TextMate scope", () => {
		// .hljs-title.function_ maps to ["support.function", "entity.name.function", "title", "function", "class"]
		// If "support.function" exists, it should use that, not a later scope
		const theme = {
			rules: [
				{ token: "support.function", foreground: "#111111" },
				{ token: "entity.name.function", foreground: "#222222" },
			],
		}
		const result = convertTextMateToHljs(theme)
		expect(result[".hljs-title.function_"]).toBe("#111111") // First match wins
	})

	it("handles the exact boundary for light/dark detection (avg >= 128)", () => {
		// #808080 = rgb(128, 128, 128) -> avg = 128 -> should be light theme
		vi.spyOn(window, "getComputedStyle").mockReturnValue({
			getPropertyValue: vi.fn().mockReturnValue("#808080"),
		} as any)

		const result = convertTextMateToHljs({})
		expect(result[".hljs-comment"]).toBe("#008000") // Light theme
	})

	it("treats avg < 128 as dark theme", () => {
		// #7f7f7f = rgb(127, 127, 127) -> avg = 127 -> should be dark theme
		vi.spyOn(window, "getComputedStyle").mockReturnValue({
			getPropertyValue: vi.fn().mockReturnValue("#7f7f7f"),
		} as any)

		const result = convertTextMateToHljs({})
		expect(result[".hljs-comment"]).toBe("#6A9955") // Dark theme
	})

	// --- Mutation kills ---
	it("produces a non-empty result with valid theme rules", () => {
		const theme = {
			rules: [{ token: "comment", foreground: "#aabbcc" }],
		}
		const result = convertTextMateToHljs(theme)
		expect(Object.keys(result).length).toBeGreaterThan(0)
	})

	it("strips leading # from hex color in parseHexColor", () => {
		// This is tested indirectly through the fallback path
		vi.spyOn(window, "getComputedStyle").mockReturnValue({
			getPropertyValue: vi.fn().mockReturnValue("#ff0000"),
		} as any)

		const result = convertTextMateToHljs({})
		// #ff0000 -> avg = (255+0+0)/3 = 85 < 128, dark theme
		expect(result[".hljs-comment"]).toBe("#6A9955")
	})

	it("handles hex color without # prefix", () => {
		vi.spyOn(window, "getComputedStyle").mockReturnValue({
			getPropertyValue: vi.fn().mockReturnValue("ffffff"),
		} as any)

		const result = convertTextMateToHljs({})
		// ffffff -> avg = 255 >= 128, light theme
		expect(result[".hljs-comment"]).toBe("#008000")
	})

	it("handles hex colors longer than 6 characters (truncation)", () => {
		vi.spyOn(window, "getComputedStyle").mockReturnValue({
			getPropertyValue: vi.fn().mockReturnValue("#ffffff00"),
		} as any)

		const result = convertTextMateToHljs({})
		// Takes first 6 chars: ffffff -> avg 255 -> light theme
		expect(result[".hljs-comment"]).toBe("#008000")
	})
})
