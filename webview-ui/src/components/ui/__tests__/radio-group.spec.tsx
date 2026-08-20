// npx vitest run src/components/ui/__tests__/radio-group.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { RadioGroup, RadioGroupItem } from "../radio-group"

describe("RadioGroup", () => {
	it("renders radio items", () => {
		render(
			<RadioGroup defaultValue="a">
				<RadioGroupItem value="a" data-testid="radio-a" />
				<RadioGroupItem value="b" data-testid="radio-b" />
			</RadioGroup>,
		)
		expect(screen.getByTestId("radio-a")).toBeInTheDocument()
		expect(screen.getByTestId("radio-b")).toBeInTheDocument()
	})

	it("has correct role attributes", () => {
		render(
			<RadioGroup defaultValue="a">
				<RadioGroupItem value="a" />
				<RadioGroupItem value="b" />
			</RadioGroup>,
		)
		expect(screen.getByRole("radiogroup")).toBeInTheDocument()
		expect(screen.getAllByRole("radio")).toHaveLength(2)
	})

	it("selects the defaultValue item", () => {
		render(
			<RadioGroup defaultValue="b">
				<RadioGroupItem value="a" />
				<RadioGroupItem value="b" />
			</RadioGroup>,
		)
		const radios = screen.getAllByRole("radio")
		expect(radios[0]).toHaveAttribute("data-state", "unchecked")
		expect(radios[1]).toHaveAttribute("data-state", "checked")
	})

	it("changes selection on click", () => {
		const onChange = vi.fn()
		render(
			<RadioGroup defaultValue="a" onValueChange={onChange}>
				<RadioGroupItem value="a" />
				<RadioGroupItem value="b" />
			</RadioGroup>,
		)
		const radios = screen.getAllByRole("radio")
		fireEvent.click(radios[1])
		expect(onChange).toHaveBeenCalledWith("b")
	})

	it("merges custom className on RadioGroup", () => {
		render(
			<RadioGroup defaultValue="a" className="group-class" data-testid="rg">
				<RadioGroupItem value="a" />
			</RadioGroup>,
		)
		expect(screen.getByTestId("rg").className).toContain("group-class")
	})

	it("merges custom className on RadioGroupItem", () => {
		render(
			<RadioGroup defaultValue="a">
				<RadioGroupItem value="a" className="item-class" data-testid="ri" />
			</RadioGroup>,
		)
		expect(screen.getByTestId("ri").className).toContain("item-class")
	})

	it("forwards ref on RadioGroup", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<RadioGroup ref={ref} defaultValue="a">
				<RadioGroupItem value="a" />
			</RadioGroup>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("forwards ref on RadioGroupItem", () => {
		const ref = React.createRef<HTMLButtonElement>()
		render(
			<RadioGroup defaultValue="a">
				<RadioGroupItem ref={ref} value="a" />
			</RadioGroup>,
		)
		expect(ref.current).toBeTruthy()
	})
})
