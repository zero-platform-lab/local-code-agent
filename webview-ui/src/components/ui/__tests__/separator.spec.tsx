// npx vitest run src/components/ui/__tests__/separator.spec.tsx

import React from "react"
import { render, screen } from "@/utils/test-utils"
import { Separator } from "../separator"

describe("Separator", () => {
	it("renders with default horizontal orientation", () => {
		render(<Separator data-testid="sep" />)
		const sep = screen.getByTestId("sep")
		expect(sep).toBeInTheDocument()
		expect(sep.className).toContain("h-[1px]")
		expect(sep.className).toContain("w-full")
	})

	it("renders with vertical orientation", () => {
		render(<Separator orientation="vertical" data-testid="sep" />)
		const sep = screen.getByTestId("sep")
		expect(sep.className).toContain("h-full")
		expect(sep.className).toContain("w-[1px]")
	})

	it("merges custom className", () => {
		render(<Separator className="my-class" data-testid="sep" />)
		expect(screen.getByTestId("sep").className).toContain("my-class")
	})

	it("forwards ref", () => {
		const ref = React.createRef<HTMLDivElement>()
		// Radix Separator renders a div
		render(<Separator ref={ref} />)
		expect(ref.current).toBeTruthy()
	})

	it("is decorative by default", () => {
		render(<Separator data-testid="sep" />)
		const sep = screen.getByTestId("sep")
		// Radix decorative separator uses role="none"
		expect(sep).toHaveAttribute("role", "none")
	})

	it("uses separator role when not decorative", () => {
		render(<Separator decorative={false} data-testid="sep" />)
		const sep = screen.getByTestId("sep")
		expect(sep).toHaveAttribute("role", "separator")
	})
})
