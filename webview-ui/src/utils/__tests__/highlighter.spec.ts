// Shiki is heavy and network/wasm bound; the unit under test is the caching layer around it.
const createHighlighter = vi.fn()
const loadLanguage = vi.fn(async () => {})

vi.mock("shiki", () => ({
	createHighlighter,
	bundledLanguages: { javascript: {}, typescript: {}, shell: {}, log: {}, python: {} },
	bundledThemes: { "github-light": {}, "github-dark": {} },
}))

type HighlighterModule = typeof import("../highlighter")

const freshModule = async (): Promise<HighlighterModule> => {
	vi.resetModules()
	return import("../highlighter")
}

beforeEach(() => {
	createHighlighter.mockReset()
	loadLanguage.mockReset()
	loadLanguage.mockResolvedValue(undefined)
	createHighlighter.mockResolvedValue({ loadLanguage })
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("normalizeLanguage", () => {
	it("defaults to plain text when no language is given", async () => {
		const { normalizeLanguage } = await freshModule()

		expect(normalizeLanguage(undefined)).toBe("txt")
	})

	it("accepts a bundled language regardless of case", async () => {
		const { normalizeLanguage } = await freshModule()

		expect(normalizeLanguage("JavaScript")).toBe("javascript")
	})

	it("resolves aliases to the bundled language", async () => {
		const { normalizeLanguage } = await freshModule()

		expect(normalizeLanguage("js")).toBe("javascript")
		expect(normalizeLanguage("BASH")).toBe("shell")
		expect(normalizeLanguage("yml")).toBe("yaml")
	})

	it("falls back to plain text and warns once per unknown language", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { normalizeLanguage } = await freshModule()

		expect(normalizeLanguage("brainfuck")).toBe("txt")
		expect(normalizeLanguage("brainfuck")).toBe("txt")

		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toContain("brainfuck")
	})

	it("does not warn about plain text itself", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { normalizeLanguage } = await freshModule()

		expect(normalizeLanguage("txt")).toBe("txt")

		expect(warn).not.toHaveBeenCalled()
	})
})

describe("isLanguageLoaded", () => {
	it("reports plain text as loaded from the start", async () => {
		const { isLanguageLoaded } = await freshModule()

		expect(isLanguageLoaded("txt")).toBe(true)
		expect(isLanguageLoaded("plaintext")).toBe(true)
	})

	it("reports a language as loaded only after it has been requested", async () => {
		const { isLanguageLoaded, getHighlighter } = await freshModule()

		expect(isLanguageLoaded("python")).toBe(false)

		await getHighlighter("python")

		expect(isLanguageLoaded("python")).toBe(true)
	})
})

describe("getHighlighter", () => {
	it("creates the Shiki instance only once no matter how many callers ask", async () => {
		const { getHighlighter } = await freshModule()

		const [a, b] = await Promise.all([getHighlighter("javascript"), getHighlighter("typescript")])

		expect(createHighlighter).toHaveBeenCalledTimes(1)
		expect(a).toBe(b)
	})

	it("loads every theme so the view can switch without re-creating the highlighter", async () => {
		const { getHighlighter } = await freshModule()
		await getHighlighter()

		expect(createHighlighter).toHaveBeenCalledWith({
			themes: ["github-light", "github-dark"],
			langs: ["shell", "log"],
		})
	})

	it("does not load languages that came with the instance", async () => {
		const { getHighlighter } = await freshModule()
		await getHighlighter("shell")

		expect(loadLanguage).not.toHaveBeenCalled()
	})

	it("loads a requested language exactly once for concurrent callers", async () => {
		const { getHighlighter } = await freshModule()

		await Promise.all([getHighlighter("python"), getHighlighter("py3")])

		expect(loadLanguage).toHaveBeenCalledTimes(1)
		expect(loadLanguage).toHaveBeenCalledWith("python")
	})

	it("does not load the same language again on a later call", async () => {
		const { getHighlighter } = await freshModule()

		await getHighlighter("python")
		await getHighlighter("python")

		expect(loadLanguage).toHaveBeenCalledTimes(1)
	})

	it("propagates a language load failure and allows a retry", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const { getHighlighter, isLanguageLoaded } = await freshModule()

		loadLanguage.mockRejectedValueOnce(new Error("grammar missing"))

		await expect(getHighlighter("python")).rejects.toThrow("grammar missing")
		expect(isLanguageLoaded("python")).toBe(false)
		expect(error).toHaveBeenCalled()

		// The failed load must not be cached, otherwise the language could never recover.
		await expect(getHighlighter("python")).resolves.toEqual({ loadLanguage })
		expect(loadLanguage).toHaveBeenCalledTimes(2)
		expect(isLanguageLoaded("python")).toBe(true)
	})

	it("propagates a failure to create the instance", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const { getHighlighter } = await freshModule()

		createHighlighter.mockRejectedValueOnce(new Error("wasm unavailable"))

		await expect(getHighlighter("javascript")).rejects.toThrow("wasm unavailable")
		expect(error).toHaveBeenCalled()
	})
})
