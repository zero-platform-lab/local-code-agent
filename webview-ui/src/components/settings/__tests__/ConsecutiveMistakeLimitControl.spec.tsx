import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { DEFAULT_CONSECUTIVE_MISTAKE_LIMIT } from "@openai-agent/types"

import { ConsecutiveMistakeLimitControl } from "../ConsecutiveMistakeLimitControl"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/ui", () => ({
	Slider: ({ value, onValueChange }: any) => (
		<div data-testid="slider" data-value={value[0]}>
			<button data-testid="slider-set-3" onClick={() => onValueChange([3])}>
				set3
			</button>
			<button data-testid="slider-set-neg" onClick={() => onValueChange([-5])}>
				setNeg
			</button>
		</div>
	),
}))

describe("ConsecutiveMistakeLimitControl", () => {
	it("shows the unlimited description and warning when value is 0", () => {
		render(<ConsecutiveMistakeLimitControl value={0} onChange={vi.fn()} />)
		expect(screen.getByText("settings:providers.consecutiveMistakeLimit.unlimitedDescription")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.consecutiveMistakeLimit.warning")).toBeInTheDocument()
	})

	it("shows the standard description and no warning for a positive value", () => {
		render(<ConsecutiveMistakeLimitControl value={5} onChange={vi.fn()} />)
		expect(screen.getByText("settings:providers.consecutiveMistakeLimit.description")).toBeInTheDocument()
		expect(screen.queryByText("settings:providers.consecutiveMistakeLimit.warning")).not.toBeInTheDocument()
		expect(screen.getByTestId("slider")).toHaveAttribute("data-value", "5")
	})

	it("falls back to the default limit when value is undefined", () => {
		render(<ConsecutiveMistakeLimitControl value={undefined as unknown as number} onChange={vi.fn()} />)
		expect(screen.getByTestId("slider")).toHaveAttribute("data-value", String(DEFAULT_CONSECUTIVE_MISTAKE_LIMIT))
		// undefined is not === 0 -> standard description, no warning
		expect(screen.queryByText("settings:providers.consecutiveMistakeLimit.warning")).not.toBeInTheDocument()
	})

	it("passes the slider value through to onChange", () => {
		const onChange = vi.fn()
		render(<ConsecutiveMistakeLimitControl value={5} onChange={onChange} />)
		fireEvent.click(screen.getByTestId("slider-set-3"))
		expect(onChange).toHaveBeenCalledWith(3)
	})

	it("clamps negative slider values to 0", () => {
		const onChange = vi.fn()
		render(<ConsecutiveMistakeLimitControl value={5} onChange={onChange} />)
		fireEvent.click(screen.getByTestId("slider-set-neg"))
		expect(onChange).toHaveBeenCalledWith(0)
	})
})
