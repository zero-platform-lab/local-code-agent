import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import React from "react"

import { SettingsSearchInput } from "../SettingsSearchInput"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/ui", () => ({
	Input: React.forwardRef<HTMLInputElement, any>(
		({ value, onChange, onFocus, onBlur, onKeyDown, placeholder, "data-testid": testid }, ref) => (
			<input
				ref={ref}
				data-testid={testid}
				value={value}
				placeholder={placeholder}
				onChange={onChange}
				onFocus={onFocus}
				onBlur={onBlur}
				onKeyDown={onKeyDown}
			/>
		),
	),
}))

describe("SettingsSearchInput", () => {
	it("has no placeholder and no clear button when collapsed and empty", () => {
		render(<SettingsSearchInput value="" onChange={vi.fn()} />)
		const input = screen.getByTestId("settings-search-input") as HTMLInputElement
		expect(input.placeholder).toBe("")
		expect(screen.queryByLabelText("Clear search")).not.toBeInTheDocument()
	})

	it("expands and shows the placeholder on focus, invoking onFocus", () => {
		const onFocus = vi.fn()
		render(<SettingsSearchInput value="" onChange={vi.fn()} onFocus={onFocus} />)
		const input = screen.getByTestId("settings-search-input") as HTMLInputElement
		fireEvent.focus(input)
		expect(onFocus).toHaveBeenCalled()
		expect(input.placeholder).toBe("settings:search.placeholder")
	})

	it("collapses on blur when empty and invokes onBlur", () => {
		const onBlur = vi.fn()
		render(<SettingsSearchInput value="" onChange={vi.fn()} onBlur={onBlur} />)
		const input = screen.getByTestId("settings-search-input") as HTMLInputElement
		fireEvent.focus(input)
		expect(input.placeholder).toBe("settings:search.placeholder")
		fireEvent.blur(input)
		expect(onBlur).toHaveBeenCalled()
		expect(input.placeholder).toBe("")
	})

	it("stays expanded on blur when there is a value", () => {
		render(<SettingsSearchInput value="abc" onChange={vi.fn()} />)
		const input = screen.getByTestId("settings-search-input") as HTMLInputElement
		fireEvent.focus(input)
		fireEvent.blur(input)
		// value present -> remains wide, placeholder still shown
		expect(input.placeholder).toBe("settings:search.placeholder")
	})

	it("does not throw when focus/blur handlers are omitted (optional chaining)", () => {
		render(<SettingsSearchInput value="" onChange={vi.fn()} />)
		const input = screen.getByTestId("settings-search-input")
		fireEvent.focus(input)
		fireEvent.blur(input)
	})

	it("forwards typed input through onChange", () => {
		const onChange = vi.fn()
		render(<SettingsSearchInput value="" onChange={onChange} />)
		fireEvent.change(screen.getByTestId("settings-search-input"), { target: { value: "hello" } })
		expect(onChange).toHaveBeenCalledWith("hello")
	})

	it("renders a clear button when there is a value and clears on click", () => {
		const onChange = vi.fn()
		render(<SettingsSearchInput value="abc" onChange={onChange} />)
		const clear = screen.getByLabelText("Clear search")
		fireEvent.click(clear)
		expect(onChange).toHaveBeenCalledWith("")
	})
})
