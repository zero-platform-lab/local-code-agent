// npx vitest run src/components/ui/__tests__/dropdown-menu.spec.tsx

import React from "react"
import userEvent from "@testing-library/user-event"

import { render, screen } from "@/utils/test-utils"
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuGroup,
} from "../dropdown-menu"

describe("DropdownMenu", () => {
	it("opens content on trigger click and renders items", async () => {
		const user = userEvent.setup()
		render(
			<DropdownMenu>
				<DropdownMenuTrigger>Menu</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>Item 1</DropdownMenuItem>
					<DropdownMenuItem>Item 2</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)

		expect(screen.queryByText("Item 1")).not.toBeInTheDocument()
		// Radix の Trigger は pointerdown で開くので fireEvent.click では足りない。
		await user.click(screen.getByText("Menu"))
		expect(screen.getByText("Item 1")).toBeInTheDocument()
		expect(screen.getByText("Item 2")).toBeInTheDocument()
	})

	it("merges custom className on DropdownMenuContent", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent className="content-class">
					<DropdownMenuItem>A</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		const content = screen.getByRole("menu")
		expect(content.className).toContain("content-class")
	})

	it("forwards ref on DropdownMenuContent", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent ref={ref}>
					<DropdownMenuItem>A</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("renders DropdownMenuItem with custom className and inset", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem className="item-class">Normal</DropdownMenuItem>
					<DropdownMenuItem inset>Inset</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(screen.getByText("Normal").className).toContain("item-class")
		expect(screen.getByText("Inset").className).toContain("pl-8")
	})

	it("forwards ref on DropdownMenuItem", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem ref={ref}>A</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("renders DropdownMenuCheckboxItem with checked state", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuCheckboxItem checked className="cb-class">
						Checked
					</DropdownMenuCheckboxItem>
					<DropdownMenuCheckboxItem checked={false}>Unchecked</DropdownMenuCheckboxItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		const checked = screen.getByText("Checked")
		expect(checked.closest("[role='menuitemcheckbox']")).toHaveAttribute("data-state", "checked")
		expect(checked.closest("[role='menuitemcheckbox']")!.className).toContain("cb-class")

		const unchecked = screen.getByText("Unchecked")
		expect(unchecked.closest("[role='menuitemcheckbox']")).toHaveAttribute("data-state", "unchecked")
	})

	it("forwards ref on DropdownMenuCheckboxItem", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuCheckboxItem ref={ref}>CB</DropdownMenuCheckboxItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("renders DropdownMenuRadioItem with selected state", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuRadioGroup value="a">
						<DropdownMenuRadioItem value="a" className="radio-class">
							Radio A
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="b">Radio B</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		const radioA = screen.getByText("Radio A").closest("[role='menuitemradio']")
		expect(radioA).toHaveAttribute("data-state", "checked")
		expect(radioA!.className).toContain("radio-class")

		const radioB = screen.getByText("Radio B").closest("[role='menuitemradio']")
		expect(radioB).toHaveAttribute("data-state", "unchecked")
	})

	it("forwards ref on DropdownMenuRadioItem", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuRadioGroup value="a">
						<DropdownMenuRadioItem ref={ref} value="a">
							R
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("renders DropdownMenuLabel with className and inset", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuLabel className="lbl-class">Label</DropdownMenuLabel>
					<DropdownMenuLabel inset>InsetLabel</DropdownMenuLabel>
					<DropdownMenuItem>A</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(screen.getByText("Label").className).toContain("lbl-class")
		expect(screen.getByText("InsetLabel").className).toContain("pl-8")
	})

	it("forwards ref on DropdownMenuLabel", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuLabel ref={ref}>L</DropdownMenuLabel>
					<DropdownMenuItem>A</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("renders DropdownMenuSeparator with custom className", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>A</DropdownMenuItem>
					<DropdownMenuSeparator className="sep-class" data-testid="sep" />
					<DropdownMenuItem>B</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(screen.getByTestId("sep").className).toContain("sep-class")
	})

	it("forwards ref on DropdownMenuSeparator", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>A</DropdownMenuItem>
					<DropdownMenuSeparator ref={ref} />
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("renders DropdownMenuShortcut with custom className", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>
						Item
						<DropdownMenuShortcut className="shortcut-class" data-testid="sc">
							Ctrl+K
						</DropdownMenuShortcut>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		const sc = screen.getByTestId("sc")
		expect(sc.textContent).toBe("Ctrl+K")
		expect(sc.className).toContain("shortcut-class")
	})

	it("renders DropdownMenuGroup wrapper", () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>M</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuGroup>
						<DropdownMenuItem>Grouped</DropdownMenuItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		expect(screen.getByText("Grouped")).toBeInTheDocument()
	})
})
