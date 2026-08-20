import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, afterEach } from "vitest"

import { ModelDescriptionMarkdown } from "../ModelDescriptionMarkdown"

// react-remark's useRemark is async and pulls in ESM-only deps; replace it with a
// simple state hook that stores the markdown string as-is.
vi.mock("react-remark", async () => {
	const React = await import("react")
	return {
		useRemark: () => {
			const [content, setContent] = React.useState(null)
			return [content, setContent]
		},
	}
})

vi.mock("@/components/ui", () => ({
	Collapsible: ({ children, open, onOpenChange }: any) => (
		<div data-testid="collapsible" data-open={open}>
			<button data-testid="toggle-open" onClick={() => onOpenChange(!open)}>
				toggle
			</button>
			{children}
		</div>
	),
	CollapsibleTrigger: ({ children, className }: any) => (
		<div data-testid="collapsible-trigger" className={className}>
			{children}
		</div>
	),
}))

vi.mock("../styles", () => ({
	StyledMarkdown: ({ children }: any) => <div data-testid="styled-markdown">{children}</div>,
}))

const setExpandableScrollSize = () => {
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 500 })
	Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 50 })
}

afterEach(() => {
	// Restore jsdom defaults (0) between tests.
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 0 })
	Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 0 })
})

describe("ModelDescriptionMarkdown", () => {
	it("renders the markdown content", () => {
		render(<ModelDescriptionMarkdown key="k" markdown="# Hello" isExpanded={false} setIsExpanded={vi.fn()} />)
		expect(screen.getByTestId("styled-markdown")).toHaveTextContent("# Hello")
	})

	it("defaults markdown to empty string when omitted", () => {
		render(<ModelDescriptionMarkdown key="k" isExpanded={false} setIsExpanded={vi.fn()} />)
		expect(screen.getByTestId("styled-markdown")).toBeInTheDocument()
	})

	it("hides the trigger when content is not expandable", () => {
		render(<ModelDescriptionMarkdown key="k" markdown="short" isExpanded={false} setIsExpanded={vi.fn()} />)
		expect(screen.getByTestId("collapsible-trigger").className).toContain("hidden")
	})

	it("shows 'More' when expandable and collapsed", () => {
		setExpandableScrollSize()
		render(<ModelDescriptionMarkdown key="k" markdown="long text" isExpanded={false} setIsExpanded={vi.fn()} />)
		expect(screen.getByTestId("collapsible-trigger").className).not.toContain("hidden")
		expect(screen.getByText("More")).toBeInTheDocument()
	})

	it("shows 'Less' when expanded", () => {
		setExpandableScrollSize()
		render(<ModelDescriptionMarkdown key="k" markdown="long text" isExpanded={true} setIsExpanded={vi.fn()} />)
		expect(screen.getByText("Less")).toBeInTheDocument()
	})

	it("calls setIsExpanded when toggled", () => {
		const setIsExpanded = vi.fn()
		render(<ModelDescriptionMarkdown key="k" markdown="x" isExpanded={false} setIsExpanded={setIsExpanded} />)
		fireEvent.click(screen.getByTestId("toggle-open"))
		expect(setIsExpanded).toHaveBeenCalledWith(true)
	})
})
