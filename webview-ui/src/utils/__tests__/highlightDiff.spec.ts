import { highlightHunks } from "../highlightDiff"
import { getHighlighter } from "../highlighter"

// Mock the highlighter
vi.mock("../highlighter", () => ({
	getHighlighter: vi.fn(),
}))

// Mock hast-util-to-jsx-runtime
vi.mock("hast-util-to-jsx-runtime", () => ({
	toJsxRuntime: vi.fn((node, _options) => {
		// Simple mock that returns a string representation
		if (node.children) {
			return node.children
				.map((child: any) => {
					if (child.type === "text") {
						return child.value
					}
					return `<span>${child.value || ""}</span>`
				})
				.join("")
		}
		return node.value || "highlighted-content"
	}),
}))

const mockHighlighter = {
	// The real return type is a hast tree; the tests swap in partial shapes on purpose, so the
	// mock is typed loosely and each test asserts on what it built.
	codeToHast: vi.fn((text: string, options: any): any => ({
		children: [
			{
				children: [
					{
						tagName: "code",
						properties: { class: `hljs language-${options.lang}` },
						children: text.split("\n").map((line) => ({
							tagName: "span",
							properties: { className: ["line"] },
							children: [{ type: "text", value: `highlighted(${line})` }],
						})),
					},
				],
			},
		],
	})),
}

beforeEach(() => {
	vi.clearAllMocks()
	;(getHighlighter as any).mockResolvedValue(mockHighlighter)
})

describe("highlightHunks", () => {
	it("should highlight simple old and new text", async () => {
		const result = await highlightHunks(
			"const x = 1\nconsole.log(x)",
			"const x = 2\nconsole.log(x)",
			"javascript",
			"light",
		)

		expect(result.oldLines).toHaveLength(2)
		expect(result.newLines).toHaveLength(2)
		expect(getHighlighter).toHaveBeenCalledWith("javascript")
		expect(mockHighlighter.codeToHast).toHaveBeenCalledTimes(2)
	})

	it("should handle empty text", async () => {
		const result = await highlightHunks("", "", "javascript", "light")

		expect(result.oldLines).toEqual([""])
		expect(result.newLines).toEqual([""])
	})

	it("should handle single-line text", async () => {
		const result = await highlightHunks("const x = 1", "const x = 2", "javascript", "dark")

		expect(result.oldLines).toHaveLength(1)
		expect(result.newLines).toHaveLength(1)
		expect(mockHighlighter.codeToHast).toHaveBeenCalledWith(
			"const x = 1",
			expect.objectContaining({
				lang: "javascript",
				theme: "github-dark",
			}),
		)
	})

	it("should handle multi-line text with different lengths", async () => {
		const oldText = "line1\nline2\nline3"
		const newText = "line1\nmodified line2"

		const result = await highlightHunks(oldText, newText, "txt", "light")

		expect(result.oldLines).toHaveLength(3)
		expect(result.newLines).toHaveLength(2)
	})

	it("should map light theme to github-light", async () => {
		await highlightHunks("test", "test", "javascript", "light")

		expect(mockHighlighter.codeToHast).toHaveBeenCalledWith(
			"test",
			expect.objectContaining({
				theme: "github-light",
			}),
		)
	})

	it("should map dark theme to github-dark", async () => {
		await highlightHunks("test", "test", "javascript", "dark")

		expect(mockHighlighter.codeToHast).toHaveBeenCalledWith(
			"test",
			expect.objectContaining({
				theme: "github-dark",
			}),
		)
	})

	it("should use correct transformers", async () => {
		await highlightHunks("test", "test", "javascript", "light")

		expect(mockHighlighter.codeToHast).toHaveBeenCalledWith(
			"test",
			expect.objectContaining({
				transformers: expect.arrayContaining([
					expect.objectContaining({
						pre: expect.any(Function),
						code: expect.any(Function),
					}),
				]),
			}),
		)
	})

	it("should handle highlighting errors gracefully", async () => {
		mockHighlighter.codeToHast.mockImplementation(() => {
			throw new Error("Highlighting failed")
		})

		const result = await highlightHunks("const x = 1", "const x = 2", "javascript", "light")

		// Should fall back to plain text
		expect(result.oldLines).toEqual(["const x = 1"])
		expect(result.newLines).toEqual(["const x = 2"])
	})

	it("should handle getHighlighter rejection", async () => {
		;(getHighlighter as any).mockRejectedValueOnce(new Error("Highlighter failed"))

		const result = await highlightHunks("const x = 1", "const x = 2", "javascript", "light")

		// Should fall back to plain text
		expect(result.oldLines).toEqual(["const x = 1"])
		expect(result.newLines).toEqual(["const x = 2"])
	})

	it("should handle text with trailing newlines", async () => {
		const result = await highlightHunks("line1\nline2\n", "line1\nline2\n", "txt", "light")

		expect(result.oldLines).toHaveLength(3) // Including empty line from trailing newline
		expect(result.newLines).toHaveLength(3)
		// The empty line at the end is preserved as-is (performance optimization)
		expect(result.oldLines[2]).toBe("")
		expect(result.newLines[2]).toBe("")
	})

	it("should preserve whitespace-only lines", async () => {
		const result = await highlightHunks("line1\n   \nline3", "line1\n\t\nline3", "txt", "light")

		expect(result.oldLines).toHaveLength(3)
		expect(result.newLines).toHaveLength(3)
		// Whitespace-only lines are preserved as-is (performance optimization)
		expect(result.oldLines[1]).toBe("   ")
		expect(result.newLines[1]).toBe("\t")
	})
})

describe("integration scenarios", () => {
	it("should handle typical single hunk scenario", async () => {
		const oldText = "function hello() {\n  console.log('old')\n}"
		const newText = "function hello() {\n  console.log('new')\n}"

		const result = await highlightHunks(oldText, newText, "javascript", "light")

		expect(result.oldLines).toHaveLength(3)
		expect(result.newLines).toHaveLength(3)
		// Each line should be processed by the highlighter
		result.oldLines.forEach((line) => {
			expect(typeof line === "string" || typeof line === "object").toBe(true)
		})
	})

	it("should handle addition-only hunk", async () => {
		const oldText = ""
		const newText = "// New comment\nconst x = 1"

		const result = await highlightHunks(oldText, newText, "javascript", "light")

		expect(result.oldLines).toEqual([""])
		expect(result.newLines).toHaveLength(2)
	})

	it("should handle deletion-only hunk", async () => {
		const oldText = "// Deleted comment\nconst x = 1"
		const newText = ""

		const result = await highlightHunks(oldText, newText, "javascript", "light")

		expect(result.oldLines).toHaveLength(2)
		expect(result.newLines).toEqual([""])
	})

	it("should handle context with mixed changes", async () => {
		const oldText = "line1\nold line\nline3\nold line2"
		const newText = "line1\nnew line\nline3\nnew line2"

		const result = await highlightHunks(oldText, newText, "txt", "light")

		expect(result.oldLines).toHaveLength(4)
		expect(result.newLines).toHaveLength(4)
	})
})

describe("highlightHunks — Shiki transformers", () => {
	const lineSpans = (text: string) =>
		text.split("\n").map((line) => ({
			tagName: "span",
			properties: { className: ["line"] },
			children: [{ type: "text", value: `highlighted(${line})` }],
		}))

	const hastOf = (children: any[], lang: string) => ({
		children: [{ children: [{ tagName: "code", properties: { class: `hljs language-${lang}` }, children }] }],
	})

	beforeEach(() => {
		;(getHighlighter as any).mockResolvedValue(mockHighlighter)
		mockHighlighter.codeToHast.mockImplementation((text: string, options: any) =>
			hastOf(lineSpans(text), options.lang),
		)
	})

	it("neutralises the wrapper styling and tags the code element with the language", async () => {
		// The diff view supplies its own frame: a background or padding from Shiki would
		// double up, and the language class is what the theme CSS keys off.
		const seen: Record<string, any> = {}

		mockHighlighter.codeToHast.mockImplementation((text: string, options: any) => {
			const pre = { properties: {} as Record<string, unknown> }
			const code = { properties: {} as Record<string, unknown> }
			const line = { properties: {} as Record<string, unknown> }
			const [transformer] = options.transformers

			expect(transformer.pre(pre)).toBe(pre)
			expect(transformer.code(code)).toBe(code)
			expect(transformer.line(line, 7)).toBe(line)

			seen.pre = pre
			seen.code = code
			seen.line = line

			return hastOf(lineSpans(text), options.lang)
		})

		await highlightHunks("a", "a", "javascript", "light")

		expect(seen.pre.properties.style).toBe("padding:0;margin:0;background:none;")
		expect(seen.code.properties.class).toBe("hljs language-javascript")
		expect(seen.line.properties["data-line"]).toBe(7)
	})

	it("returns plain lines when the highlighter result has no code children", async () => {
		mockHighlighter.codeToHast.mockImplementation(() => ({ children: [{ children: [{ tagName: "code" }] }] }))

		const result = await highlightHunks("a\n\nb", "c\n\nd", "javascript", "light")

		// Blank lines survive as empty strings so both sides keep the same line count.
		expect(result.oldLines).toEqual(["a", "", "b"])
		expect(result.newLines).toEqual(["c", "", "d"])
	})

	it("returns plain lines when the highlighter result has no code element at all", async () => {
		mockHighlighter.codeToHast.mockImplementation(() => ({ children: [] }))

		const result = await highlightHunks("a\nb", "c\nd", "javascript", "light")

		expect(result.oldLines).toEqual(["a", "b"])
	})

	it("tolerates line spans that carry no children", async () => {
		mockHighlighter.codeToHast.mockImplementation((text: string, options: any) =>
			hastOf(
				text.split("\n").map(() => ({ tagName: "span", properties: { className: ["line"] } })),
				options.lang,
			),
		)

		const result = await highlightHunks("a\nb", "a\nb", "javascript", "light")

		expect(result.oldLines).toHaveLength(2)
	})

	it("re-highlights line by line when the result loses lines", async () => {
		// Every source line must come back as exactly one rendered line, otherwise the two
		// sides of the diff stop lining up.
		mockHighlighter.codeToHast.mockImplementation((text: string, options: any) =>
			hastOf(text.includes("\n") ? lineSpans(text).slice(0, 1) : lineSpans(text), options.lang),
		)

		const result = await highlightHunks("a\nb", "c\nd", "javascript", "light")

		expect(result.oldLines).toHaveLength(2)
		expect(result.newLines).toHaveLength(2)
		expect(mockHighlighter.codeToHast.mock.calls.map((call: any[]) => call[0])).toEqual([
			"a\nb",
			"a",
			"b",
			"c\nd",
			"c",
			"d",
		])
	})

	it("keeps a line as plain text when its individual highlight throws", async () => {
		mockHighlighter.codeToHast.mockImplementation((text: string, options: any) => {
			if (!text.includes("\n")) {
				throw new Error("per-line failure")
			}

			return hastOf(lineSpans(text).slice(0, 1), options.lang)
		})

		const result = await highlightHunks("a\nb", "c\nd", "javascript", "light")

		expect(result.oldLines).toEqual(["a", "b"])
		expect(result.newLines).toEqual(["c", "d"])
	})

	it("keeps a line as plain text when its individual highlight has no code element", async () => {
		mockHighlighter.codeToHast.mockImplementation((text: string, options: any) =>
			text.includes("\n")
				? hastOf(lineSpans(text).slice(0, 1), options.lang)
				: { children: [{ children: [{ tagName: "code" }] }] },
		)

		const result = await highlightHunks("a\nb", "c\nd", "javascript", "light")

		expect(result.oldLines).toEqual(["a", "b"])
	})

	it("does not send blank lines through the per-line fallback", async () => {
		mockHighlighter.codeToHast.mockImplementation((text: string, options: any) =>
			hastOf(text.includes("\n") ? lineSpans(text).slice(0, 1) : lineSpans(text), options.lang),
		)

		const result = await highlightHunks("a\n\nb", "a\n\nb", "javascript", "light")

		expect(result.oldLines[1]).toBe("")
		expect(mockHighlighter.codeToHast.mock.calls.map((call: any[]) => call[0])).not.toContain("")
	})

	it("keeps empty lines as empty strings when the highlighter cannot be created", async () => {
		;(getHighlighter as any).mockRejectedValueOnce(new Error("no highlighter"))

		const result = await highlightHunks("a\n\nb", "c\n\nd", "javascript", "light")

		expect(result.oldLines).toEqual(["a", "", "b"])
		expect(result.newLines).toEqual(["c", "", "d"])
	})
})

describe("highlightHunks — per-line fallback transformers", () => {
	const lineSpans = (text: string) =>
		text.split("\n").map((line) => ({
			tagName: "span",
			properties: { className: ["line"] },
			children: [{ type: "text", value: `highlighted(${line})` }],
		}))

	const hastOf = (children: any[], lang: string) => ({
		children: [{ children: [{ tagName: "code", properties: { class: `hljs language-${lang}` }, children }] }],
	})

	beforeEach(() => {
		;(getHighlighter as any).mockResolvedValue(mockHighlighter)
	})

	it("applies the same wrapper styling and language class to individually highlighted lines", async () => {
		const seen: Record<string, any> = {}

		mockHighlighter.codeToHast.mockImplementation((text: string, options: any) => {
			if (text.includes("\n")) {
				// Force the per-line fallback by returning fewer lines than the input has.
				return hastOf(lineSpans(text).slice(0, 1), options.lang)
			}

			const pre = { properties: {} as Record<string, unknown> }
			const code = { properties: {} as Record<string, unknown> }
			const [transformer] = options.transformers

			expect(transformer.pre(pre)).toBe(pre)
			expect(transformer.code(code)).toBe(code)
			// A single line needs no line marker; only the wrapper is normalised.
			expect(transformer.line).toBeUndefined()

			seen.pre = pre
			seen.code = code

			return hastOf(lineSpans(text), options.lang)
		})

		await highlightHunks("a\nb", "a\nb", "typescript", "dark")

		expect(seen.pre.properties.style).toBe("padding:0;margin:0;background:none;")
		expect(seen.code.properties.class).toBe("hljs language-typescript")
	})
})
