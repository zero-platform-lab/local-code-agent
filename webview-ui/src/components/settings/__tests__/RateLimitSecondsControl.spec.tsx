import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { RateLimitSecondsControl } from "../RateLimitSecondsControl"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/ui", () => ({
	Slider: ({ value, onValueChange }: any) => (
		<input
			type="range"
			role="slider"
			value={value[0]}
			onChange={(e) => onValueChange([parseFloat(e.target.value)])}
		/>
	),
}))

describe("RateLimitSecondsControl", () => {
	it("displays the current value", () => {
		render(<RateLimitSecondsControl value={12} onChange={vi.fn()} />)
		expect(screen.getByText("12s")).toBeInTheDocument()
		expect(screen.getByRole("slider")).toHaveValue("12")
	})

	it("passes the first slider element to onChange", () => {
		const onChange = vi.fn()
		render(<RateLimitSecondsControl value={0} onChange={onChange} />)
		fireEvent.change(screen.getByRole("slider"), { target: { value: "30" } })
		expect(onChange).toHaveBeenCalledWith(30)
	})
})
