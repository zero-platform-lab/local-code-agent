import { render, screen, fireEvent } from "@/utils/test-utils"

import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"

import { vscode } from "@/utils/vscode"

import { About } from "../About"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/i18n/TranslationContext", () => {
	const actual = vi.importActual("@/i18n/TranslationContext")
	return {
		...actual,
		useAppTranslation: () => ({
			t: (key: string) => key,
		}),
	}
})

vi.mock("@agent/package", () => ({
	Package: {
		version: "1.0.0",
		sha: "abc12345",
	},
}))

describe("About", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the About section header", () => {
		render(
			<TranslationProvider>
				<About />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:sections.about")).toBeInTheDocument()
	})

	it("displays version information", () => {
		render(
			<TranslationProvider>
				<About />
			</TranslationProvider>,
		)
		expect(screen.getByText(/Version: 1\.0\.0/)).toBeInTheDocument()
	})

	it("does not render feature request copy", () => {
		render(
			<TranslationProvider>
				<About />
			</TranslationProvider>,
		)

		expect(screen.queryByText("settings:about.featureRequest.label")).not.toBeInTheDocument()
	})

	it("renders export, import, and reset buttons", () => {
		render(
			<TranslationProvider>
				<About />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:footer.settings.export")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.import")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.reset")).toBeInTheDocument()
	})

	it("posts export/import/reset messages when the buttons are clicked", () => {
		render(
			<TranslationProvider>
				<About />
			</TranslationProvider>,
		)
		fireEvent.click(screen.getByText("settings:footer.settings.export").closest("button")!)
		fireEvent.click(screen.getByText("settings:footer.settings.import").closest("button")!)
		fireEvent.click(screen.getByText("settings:footer.settings.reset").closest("button")!)

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "exportSettings" })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "importSettings" })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "resetState" })
	})

	it("does not render the debug toggle when setDebug is absent", () => {
		render(
			<TranslationProvider>
				<About />
			</TranslationProvider>,
		)
		expect(screen.queryByText("settings:about.debugMode.label")).not.toBeInTheDocument()
	})

	it("renders the debug toggle and reflects the debug prop when setDebug is provided", () => {
		render(
			<TranslationProvider>
				<About debug={true} setDebug={vi.fn()} />
			</TranslationProvider>,
		)
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("defaults the debug checkbox to unchecked when debug is undefined", () => {
		render(
			<TranslationProvider>
				<About setDebug={vi.fn()} />
			</TranslationProvider>,
		)
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(false)
	})

	it("calls setDebug with the toggled boolean", () => {
		const setDebug = vi.fn()
		render(
			<TranslationProvider>
				<About debug={false} setDebug={setDebug} />
			</TranslationProvider>,
		)
		const checkbox = screen.getByRole("checkbox")
		fireEvent.click(checkbox)
		expect(setDebug).toHaveBeenCalledWith(true)
	})
})
