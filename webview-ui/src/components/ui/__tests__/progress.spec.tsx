// npx vitest run src/components/ui/__tests__/progress.spec.tsx

import React from "react"
import { render, screen } from "@/utils/test-utils"
import { Progress } from "../progress"

describe("Progress", () => {
	it("renders with a given value", () => {
		render(<Progress value={60} data-testid="prog" />)
		const root = screen.getByTestId("prog")
		expect(root).toBeInTheDocument()
		// The indicator should have transform based on value
		const indicator = root.firstChild as HTMLElement
		expect(indicator.style.transform).toBe("translateX(-40%)")
	})

	it("renders with value=0", () => {
		render(<Progress value={0} data-testid="prog" />)
		const indicator = screen.getByTestId("prog").firstChild as HTMLElement
		expect(indicator.style.transform).toBe("translateX(-100%)")
	})

	it("renders with value=100", () => {
		render(<Progress value={100} data-testid="prog" />)
		const indicator = screen.getByTestId("prog").firstChild as HTMLElement
		expect(indicator.style.transform).toBe("translateX(-0%)")
	})

	it("defaults to 0 when value is undefined", () => {
		render(<Progress data-testid="prog" />)
		const indicator = screen.getByTestId("prog").firstChild as HTMLElement
		expect(indicator.style.transform).toBe("translateX(-100%)")
	})

	it("merges custom className", () => {
		render(<Progress value={50} data-testid="prog" className="my-prog" />)
		expect(screen.getByTestId("prog").className).toContain("my-prog")
	})

	it("forwards ref", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(<Progress ref={ref} value={50} />)
		expect(ref.current).toBeTruthy()
	})
})
