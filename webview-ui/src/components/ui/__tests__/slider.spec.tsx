// npx vitest run src/components/ui/__tests__/slider.spec.tsx

import React from "react"
import { render, screen } from "@/utils/test-utils"
import { Slider } from "../slider"

describe("Slider", () => {
	it("renders with default props", () => {
		render(<Slider defaultValue={[50]} />)
		expect(screen.getByRole("slider")).toBeInTheDocument()
	})

	it("merges custom className on root element", () => {
		const { container } = render(<Slider className="my-slider" defaultValue={[0]} />)
		// Radix Slider root is the first child span
		const root = container.firstChild as HTMLElement
		expect(root.className).toContain("my-slider")
	})

	it("forwards ref", () => {
		const ref = React.createRef<HTMLSpanElement>()
		render(<Slider ref={ref} defaultValue={[25]} />)
		expect(ref.current).toBeTruthy()
	})

	it("renders with min and max props on thumb", () => {
		render(<Slider defaultValue={[5]} min={0} max={10} />)
		const thumb = screen.getByRole("slider")
		expect(thumb).toHaveAttribute("aria-valuemin", "0")
		expect(thumb).toHaveAttribute("aria-valuemax", "10")
		expect(thumb).toHaveAttribute("aria-valuenow", "5")
	})
})
