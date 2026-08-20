// npx vitest run src/components/ui/__tests__/command.spec.tsx

import React from "react"
import { render, screen } from "@/utils/test-utils"
import {
	Command,
	CommandInput,
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandShortcut,
	CommandSeparator,
	CommandDialog,
} from "../command"

describe("Command", () => {
	it("renders with children", () => {
		render(
			<Command data-testid="cmd">
				<CommandInput placeholder="Search..." />
				<CommandList>
					<CommandGroup>
						<CommandItem>Item 1</CommandItem>
					</CommandGroup>
				</CommandList>
			</Command>,
		)
		expect(screen.getByTestId("cmd")).toBeInTheDocument()
		expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument()
		expect(screen.getByText("Item 1")).toBeInTheDocument()
	})

	it("merges custom className on Command", () => {
		render(<Command data-testid="cmd" className="my-cmd" />)
		expect(screen.getByTestId("cmd").className).toContain("my-cmd")
	})

	it("forwards ref on Command", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(<Command ref={ref} />)
		expect(ref.current).toBeTruthy()
	})

	it("merges custom className on CommandInput", () => {
		render(
			<Command>
				<CommandInput className="inp-class" placeholder="Search..." />
			</Command>,
		)
		const input = screen.getByPlaceholderText("Search...")
		expect(input.className).toContain("inp-class")
	})

	it("forwards ref on CommandInput", () => {
		const ref = React.createRef<HTMLInputElement>()
		render(
			<Command>
				<CommandInput ref={ref} placeholder="S" />
			</Command>,
		)
		expect(ref.current).toBeInstanceOf(HTMLInputElement)
	})

	it("merges custom className on CommandList", () => {
		render(
			<Command>
				<CommandList className="list-class" data-testid="list">
					<CommandItem>X</CommandItem>
				</CommandList>
			</Command>,
		)
		expect(screen.getByTestId("list").className).toContain("list-class")
	})

	it("forwards ref on CommandList", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<Command>
				<CommandList ref={ref}>
					<CommandItem>X</CommandItem>
				</CommandList>
			</Command>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("CommandList handles wheel events (scroll workaround)", () => {
		const onWheel = vi.fn()
		render(
			<Command>
				<CommandList data-testid="list" onWheel={onWheel}>
					<CommandItem>A</CommandItem>
				</CommandList>
			</Command>,
		)
		const list = screen.getByTestId("list")
		// Fire a wheel event - the handler should prevent default and call onWheel
		const wheelEvent = new WheelEvent("wheel", { deltaY: 100, bubbles: true })
		Object.defineProperty(wheelEvent, "preventDefault", { value: vi.fn() })
		Object.defineProperty(wheelEvent, "stopPropagation", { value: vi.fn() })
		list.dispatchEvent(wheelEvent)
		expect(onWheel).toHaveBeenCalled()
	})

	it("renders CommandEmpty", () => {
		render(
			<Command>
				<CommandList>
					<CommandEmpty data-testid="empty">No results</CommandEmpty>
				</CommandList>
			</Command>,
		)
		expect(screen.getByTestId("empty")).toBeInTheDocument()
	})

	it("forwards ref on CommandEmpty", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<Command>
				<CommandList>
					<CommandEmpty ref={ref}>No results</CommandEmpty>
				</CommandList>
			</Command>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("merges custom className on CommandGroup", () => {
		render(
			<Command>
				<CommandList>
					<CommandGroup className="grp-class" data-testid="grp">
						<CommandItem>A</CommandItem>
					</CommandGroup>
				</CommandList>
			</Command>,
		)
		expect(screen.getByTestId("grp").className).toContain("grp-class")
	})

	it("forwards ref on CommandGroup", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<Command>
				<CommandList>
					<CommandGroup ref={ref}>
						<CommandItem>A</CommandItem>
					</CommandGroup>
				</CommandList>
			</Command>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("merges custom className on CommandItem", () => {
		render(
			<Command>
				<CommandList>
					<CommandItem className="item-class" data-testid="item">
						A
					</CommandItem>
				</CommandList>
			</Command>,
		)
		expect(screen.getByTestId("item").className).toContain("item-class")
	})

	it("forwards ref on CommandItem", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<Command>
				<CommandList>
					<CommandItem ref={ref}>A</CommandItem>
				</CommandList>
			</Command>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("renders CommandShortcut with custom className", () => {
		render(
			<Command>
				<CommandList>
					<CommandItem>
						Item
						<CommandShortcut className="sc-class" data-testid="sc">
							Ctrl+K
						</CommandShortcut>
					</CommandItem>
				</CommandList>
			</Command>,
		)
		const sc = screen.getByTestId("sc")
		expect(sc.textContent).toBe("Ctrl+K")
		expect(sc.className).toContain("sc-class")
	})

	it("renders CommandSeparator with custom className", () => {
		render(
			<Command>
				<CommandList>
					<CommandSeparator className="sep-class" data-testid="sep" />
				</CommandList>
			</Command>,
		)
		expect(screen.getByTestId("sep").className).toContain("sep-class")
	})

	it("forwards ref on CommandSeparator", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<Command>
				<CommandList>
					<CommandSeparator ref={ref} />
				</CommandList>
			</Command>,
		)
		expect(ref.current).toBeTruthy()
	})

	it("renders CommandDialog when open", () => {
		render(
			<CommandDialog open>
				<CommandInput placeholder="Dialog search" />
				<CommandList>
					<CommandItem>DialogItem</CommandItem>
				</CommandList>
			</CommandDialog>,
		)
		expect(screen.getByPlaceholderText("Dialog search")).toBeInTheDocument()
		expect(screen.getByText("DialogItem")).toBeInTheDocument()
	})
})
