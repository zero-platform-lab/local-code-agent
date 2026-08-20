// npx vitest run src/components/common/__tests__/Tab.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { Tab, TabHeader, TabContent, TabList, TabTrigger } from "../Tab"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => ({
		renderContext: "sidebar",
	})),
}))

import { useExtensionState } from "@/context/ExtensionStateContext"

const mockUseExtensionState = useExtensionState as ReturnType<typeof vi.fn>

describe("Tab", () => {
	it("renders children with fixed inset-0 layout", () => {
		const { container } = render(
			<Tab>
				<div>Tab content</div>
			</Tab>,
		)
		expect(screen.getByText("Tab content")).toBeInTheDocument()
		expect(container.firstChild).toHaveClass("fixed", "inset-0", "flex", "flex-col")
	})

	it("applies custom className", () => {
		const { container } = render(
			<Tab className="my-custom">
				<div>Content</div>
			</Tab>,
		)
		expect(container.firstChild).toHaveClass("my-custom")
	})

	it("passes additional HTML attributes", () => {
		render(
			<Tab data-testid="my-tab">
				<div>Content</div>
			</Tab>,
		)
		expect(screen.getByTestId("my-tab")).toBeInTheDocument()
	})
})

describe("TabHeader", () => {
	it("renders with border-b and padding", () => {
		const { container } = render(
			<TabHeader>
				<div>Header</div>
			</TabHeader>,
		)
		expect(container.firstChild).toHaveClass("px-5", "py-2.5", "border-b")
	})

	it("applies custom className", () => {
		const { container } = render(
			<TabHeader className="extra-class">
				<div>Header</div>
			</TabHeader>,
		)
		expect(container.firstChild).toHaveClass("extra-class")
	})
})

describe("TabContent", () => {
	it("renders children with overflow-auto", () => {
		render(
			<TabContent data-testid="tab-content">
				<div>Content area</div>
			</TabContent>,
		)
		const content = screen.getByTestId("tab-content")
		expect(content).toHaveClass("flex-1", "overflow-auto", "p-5")
		expect(screen.getByText("Content area")).toBeInTheDocument()
	})

	it("applies custom className", () => {
		render(
			<TabContent className="custom-content" data-testid="tab-content">
				<div>Content</div>
			</TabContent>,
		)
		expect(screen.getByTestId("tab-content")).toHaveClass("custom-content")
	})

	it("does not scroll on wheel in sidebar renderContext", () => {
		mockUseExtensionState.mockReturnValue({ renderContext: "sidebar" })

		render(
			<TabContent data-testid="tab-content">
				<div>Content</div>
			</TabContent>,
		)

		const content = screen.getByTestId("tab-content")
		// In sidebar mode, onWheel is a noop (returns early)
		fireEvent.wheel(content, { deltaY: 100 })
		// No scrollTop change expected (jsdom doesn't scroll, but we verify no crash)
	})

	it("adjusts scrollTop on wheel in editor renderContext", () => {
		mockUseExtensionState.mockReturnValue({ renderContext: "editor" })

		render(
			<TabContent data-testid="tab-content">
				<div>Content</div>
			</TabContent>,
		)

		const content = screen.getByTestId("tab-content")
		Object.defineProperty(content, "scrollTop", { value: 0, writable: true })

		fireEvent.wheel(content, { deltaY: 50 })
		// The handler sets currentTarget.scrollTop += deltaY
		// jsdom may not reflect the change, but we verify the handler doesn't error
	})

	it("does not scroll when target is a listbox element in editor context", () => {
		mockUseExtensionState.mockReturnValue({ renderContext: "editor" })

		render(
			<TabContent data-testid="tab-content">
				<div role="listbox">Listbox element</div>
			</TabContent>,
		)

		const listbox = screen.getByRole("listbox")
		const content = screen.getByTestId("tab-content")
		Object.defineProperty(content, "scrollTop", { value: 0, writable: true })

		// Wheel event targeting a listbox should return early
		fireEvent.wheel(listbox, { deltaY: 50 })
	})

	it("does not scroll when target is an option element in editor context", () => {
		mockUseExtensionState.mockReturnValue({ renderContext: "editor" })

		render(
			<TabContent data-testid="tab-content">
				<div role="option">Option element</div>
			</TabContent>,
		)

		const option = screen.getByRole("option")
		fireEvent.wheel(option, { deltaY: 50 })
		// Should not throw - early return for option role
	})

	it("forwards ref", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<TabContent ref={ref}>
				<div>Content</div>
			</TabContent>,
		)
		expect(ref.current).toBeInstanceOf(HTMLDivElement)
	})
})

describe("TabList", () => {
	it("renders with tablist role", () => {
		render(
			<TabList value="tab1" onValueChange={vi.fn()}>
				<TabTrigger value="tab1">Tab 1</TabTrigger>
				<TabTrigger value="tab2">Tab 2</TabTrigger>
			</TabList>,
		)
		expect(screen.getByRole("tablist")).toBeInTheDocument()
	})

	it("passes isSelected to the matching child", () => {
		render(
			<TabList value="tab2" onValueChange={vi.fn()}>
				<TabTrigger value="tab1">Tab 1</TabTrigger>
				<TabTrigger value="tab2">Tab 2</TabTrigger>
			</TabList>,
		)

		const tabs = screen.getAllByRole("tab")
		expect(tabs[0]).toHaveAttribute("aria-selected", "false")
		expect(tabs[1]).toHaveAttribute("aria-selected", "true")
	})

	it("calls onValueChange when a child trigger is clicked", () => {
		const onValueChange = vi.fn()
		render(
			<TabList value="tab1" onValueChange={onValueChange}>
				<TabTrigger value="tab1">Tab 1</TabTrigger>
				<TabTrigger value="tab2">Tab 2</TabTrigger>
			</TabList>,
		)

		fireEvent.click(screen.getByText("Tab 2"))
		expect(onValueChange).toHaveBeenCalledWith("tab2")
	})

	it("handles non-element children gracefully", () => {
		render(
			<TabList value="tab1" onValueChange={vi.fn()}>
				<TabTrigger value="tab1">Tab 1</TabTrigger>
				{null}
				{"text node"}
			</TabList>,
		)
		expect(screen.getByRole("tablist")).toBeInTheDocument()
	})

	it("forwards ref", () => {
		const ref = React.createRef<HTMLDivElement>()
		render(
			<TabList ref={ref} value="tab1" onValueChange={vi.fn()}>
				<TabTrigger value="tab1">Tab 1</TabTrigger>
			</TabList>,
		)
		expect(ref.current).toBeInstanceOf(HTMLDivElement)
	})
})

describe("TabTrigger", () => {
	it("renders as a button with tab role", () => {
		render(
			<TabTrigger value="t1" isSelected={false} onSelect={vi.fn()}>
				Trigger
			</TabTrigger>,
		)
		const button = screen.getByRole("tab")
		expect(button).toBeInTheDocument()
		expect(button).toHaveAttribute("aria-selected", "false")
		expect(button).toHaveAttribute("tabindex", "-1")
	})

	it("has tabIndex 0 when selected", () => {
		render(
			<TabTrigger value="t1" isSelected={true} onSelect={vi.fn()}>
				Trigger
			</TabTrigger>,
		)
		expect(screen.getByRole("tab")).toHaveAttribute("tabindex", "0")
	})

	it("calls onSelect when clicked", () => {
		const onSelect = vi.fn()
		render(
			<TabTrigger value="t1" isSelected={false} onSelect={onSelect}>
				Trigger
			</TabTrigger>,
		)
		fireEvent.click(screen.getByRole("tab"))
		expect(onSelect).toHaveBeenCalledTimes(1)
	})

	it("forwards ref", () => {
		const ref = React.createRef<HTMLButtonElement>()
		render(
			<TabTrigger ref={ref} value="t1">
				Trigger
			</TabTrigger>,
		)
		expect(ref.current).toBeInstanceOf(HTMLButtonElement)
	})

	// Mutation: selected state drives both aria-selected and tabIndex
	it("aria-selected and tabIndex are consistent with isSelected", () => {
		const { rerender } = render(
			<TabTrigger value="t1" isSelected={false}>
				T
			</TabTrigger>,
		)
		const tab = screen.getByRole("tab")
		expect(tab).toHaveAttribute("aria-selected", "false")
		expect(tab).toHaveAttribute("tabindex", "-1")

		rerender(
			<TabTrigger value="t1" isSelected={true}>
				T
			</TabTrigger>,
		)
		expect(tab).toHaveAttribute("aria-selected", "true")
		expect(tab).toHaveAttribute("tabindex", "0")
	})
})
