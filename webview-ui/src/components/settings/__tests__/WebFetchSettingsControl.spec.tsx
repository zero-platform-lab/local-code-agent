import { render, screen, fireEvent } from "@testing-library/react"

import { WebFetchSettingsControl } from "../WebFetchSettingsControl"

// Mock the translation hook
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"settings:advanced.webFetch.label": "Enable web fetch tool",
				"settings:advanced.webFetch.description":
					"When enabled, Agent can fetch the contents of an http(s) URL you point it to (with your approval).",
			}
			return translations[key] || key
		},
	}),
}))

// Mock VSCodeCheckbox
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, onChange, checked, ...props }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
				{...props}
			/>
			{children}
		</label>
	),
}))

describe("WebFetchSettingsControl", () => {
	it("renders unchecked by default (opt-in)", () => {
		const onChange = vi.fn()
		render(<WebFetchSettingsControl onChange={onChange} />)

		const checkbox = screen.getByRole("checkbox")
		expect(checkbox).toBeInTheDocument()
		expect(checkbox).not.toBeChecked() // Default is false (opt-in)
		expect(screen.getByText("Enable web fetch tool")).toBeInTheDocument()
		expect(screen.getByText(/When enabled, Agent can fetch the contents/)).toBeInTheDocument()
	})

	it("renders checked when webFetchEnabled is true", () => {
		const onChange = vi.fn()
		render(<WebFetchSettingsControl webFetchEnabled={true} onChange={onChange} />)

		expect(screen.getByRole("checkbox")).toBeChecked()
	})

	it("calls onChange with true when toggled on", () => {
		const onChange = vi.fn()
		render(<WebFetchSettingsControl webFetchEnabled={false} onChange={onChange} />)

		fireEvent.click(screen.getByRole("checkbox"))

		expect(onChange).toHaveBeenCalledWith("webFetchEnabled", true)
	})

	it("calls onChange with false when toggled off", () => {
		const onChange = vi.fn()
		render(<WebFetchSettingsControl webFetchEnabled={true} onChange={onChange} />)

		fireEvent.click(screen.getByRole("checkbox"))

		expect(onChange).toHaveBeenCalledWith("webFetchEnabled", false)
	})
})
