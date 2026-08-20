import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { LanguageSettings } from "../LanguageSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			<button data-testid="select-ja" onClick={() => onValueChange("ja")}>
				change
			</button>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectGroup: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-testid={`item-${value}`}>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
}))

describe("LanguageSettings", () => {
	it("reflects the current language value and lists options", () => {
		render(<LanguageSettings language="en" setCachedStateField={vi.fn()} />)
		expect(screen.getByTestId("select")).toHaveAttribute("data-value", "en")
		// LANGUAGES map is rendered as items
		expect(screen.getByTestId("item-en")).toBeInTheDocument()
	})

	it("updates only the language field on change", () => {
		const setField = vi.fn()
		render(<LanguageSettings language="en" setCachedStateField={setField} />)
		fireEvent.click(screen.getByTestId("select-ja"))
		expect(setField).toHaveBeenCalledTimes(1)
		expect(setField).toHaveBeenCalledWith("language", "ja")
	})
})
