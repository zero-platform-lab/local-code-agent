import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { ExperimentalFeature } from "../ExperimentalFeature"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, onChange, checked }: any) => (
		<label>
			<input
				type="checkbox"
				role="checkbox"
				checked={checked || false}
				onChange={(e: any) => onChange?.({ target: { checked: e.target.checked } })}
			/>
			{children}
		</label>
	),
}))

describe("ExperimentalFeature", () => {
	it("builds translation keys from experimentKey when provided", () => {
		render(<ExperimentalFeature enabled={false} onChange={vi.fn()} experimentKey="MULTI_FILE" />)
		expect(screen.getByText("settings:experimental.MULTI_FILE.name")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.MULTI_FILE.description")).toBeInTheDocument()
	})

	it("uses empty keys when experimentKey is absent", () => {
		const { container } = render(<ExperimentalFeature enabled={false} onChange={vi.fn()} />)
		// name/description keys are empty -> t("") renders nothing meaningful, but no crash
		expect(container.querySelector("input[type=checkbox]")).toBeInTheDocument()
	})

	it("reflects the enabled state", () => {
		render(<ExperimentalFeature enabled={true} onChange={vi.fn()} experimentKey="X" />)
		expect(screen.getByRole("checkbox")).toBeChecked()
	})

	it("passes the toggled boolean to onChange", () => {
		const onChange = vi.fn()
		render(<ExperimentalFeature enabled={false} onChange={onChange} experimentKey="X" />)
		fireEvent.click(screen.getByRole("checkbox"))
		expect(onChange).toHaveBeenCalledWith(true)
	})
})
