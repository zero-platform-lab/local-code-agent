import { render, screen } from "@/utils/test-utils"

import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"

import { About } from "../About"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/i18n/TranslationContext", () => {
	const actual = vi.importActual("@/i18n/TranslationContext")
	return {
		...actual,
		useAppTranslation: () => ({ t: (key: string) => key }),
	}
})

// sha is empty -> exercises the "Version: <version>" branch without the sha suffix.
vi.mock("@agent/package", () => ({
	Package: {
		version: "2.3.4",
		sha: "",
	},
}))

describe("About (no sha)", () => {
	it("shows the version without a sha suffix", () => {
		render(
			<TranslationProvider>
				<About />
			</TranslationProvider>,
		)
		expect(screen.getByText("Version: 2.3.4")).toBeInTheDocument()
	})
})
