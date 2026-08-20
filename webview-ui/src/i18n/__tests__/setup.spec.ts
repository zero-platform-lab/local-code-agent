// The module initialises i18next as a side effect of being imported, so i18next is mocked and
// the module is re-imported per scenario.
const i18nextMock = vi.hoisted(() => ({
	use: vi.fn(),
	init: vi.fn(),
	addResourceBundle: vi.fn(),
}))

vi.mock("i18next", () => {
	i18nextMock.use.mockReturnValue(i18nextMock)
	return { default: i18nextMock }
})

vi.mock("react-i18next", () => ({ initReactI18next: { type: "3rdParty" } }))

const freshSetup = async () => {
	vi.resetModules()
	return import("../setup")
}

beforeEach(() => {
	vi.clearAllMocks()
	i18nextMock.use.mockReturnValue(i18nextMock)
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("i18n setup", () => {
	it("initialises i18next with Japanese as both language and fallback", async () => {
		await freshSetup()

		expect(i18nextMock.init).toHaveBeenCalledWith(
			expect.objectContaining({ lng: "ja", fallbackLng: "ja", debug: false }),
		)
	})

	it("does not double-escape interpolated values, because React already escapes them", async () => {
		await freshSetup()

		expect(i18nextMock.init.mock.calls[0][0].interpolation).toEqual({ escapeValue: false })
	})

	it("registers every bundled locale namespace", async () => {
		const { loadTranslations } = await freshSetup()

		loadTranslations()

		const registered = i18nextMock.addResourceBundle.mock.calls.map(([lang, namespace]) => `${lang}/${namespace}`)
		expect(registered).toContain("ja/common")
		expect(registered).toContain("en/common")
		expect(registered).toContain("ja/settings")
	})

	it("registers resources with deep merge so partial namespaces do not wipe others", async () => {
		const { loadTranslations } = await freshSetup()

		loadTranslations()

		for (const call of i18nextMock.addResourceBundle.mock.calls) {
			expect(call.slice(3)).toEqual([true, true])
			expect(typeof call[2]).toBe("object")
		}
	})

	it("loads the actual translated strings, not the module wrapper", async () => {
		const { loadTranslations } = await freshSetup()

		loadTranslations()

		const [, , resources] = i18nextMock.addResourceBundle.mock.calls.find(
			([lang, namespace]) => lang === "ja" && namespace === "common",
		)!
		expect(resources).not.toHaveProperty("default")
		expect(Object.keys(resources as object).length).toBeGreaterThan(0)
	})

	it("keeps loading other languages when one of them fails", async () => {
		const { loadTranslations } = await freshSetup()

		i18nextMock.addResourceBundle.mockImplementationOnce(() => {
			throw new Error("bad bundle")
		})

		expect(() => loadTranslations()).not.toThrow()
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("translations:"), expect.any(Error))

		const languages = new Set(i18nextMock.addResourceBundle.mock.calls.map(([lang]) => lang))
		expect(languages.size).toBeGreaterThan(1)
	})
})
