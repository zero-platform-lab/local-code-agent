// npx vitest run src/components/common/__tests__/TabButton.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"
import { TabButton } from "../TabButton"

describe("TabButton", () => {
	it("renders the label text", () => {
		render(<TabButton icon="file" label="Files" isActive={false} onClick={vi.fn()} />)
		expect(screen.getByText("Files")).toBeInTheDocument()
	})

	it("renders the correct codicon icon", () => {
		const { container } = render(<TabButton icon="file-media" label="Media" isActive={false} onClick={vi.fn()} />)
		expect(container.querySelector(".codicon-file-media")).toBeInTheDocument()
	})

	it("applies active classes when isActive is true", () => {
		render(<TabButton icon="file" label="Active Tab" isActive={true} onClick={vi.fn()} />)
		const button = screen.getByRole("button")
		expect(button.className).toContain("bg-vscode-editor-background")
		expect(button.className).toContain("border-vscode-focusBorder")
	})

	it("applies inactive classes when isActive is false", () => {
		render(<TabButton icon="file" label="Inactive Tab" isActive={false} onClick={vi.fn()} />)
		const button = screen.getByRole("button")
		expect(button.className).toContain("bg-transparent")
		expect(button.className).toContain("border-transparent")
	})

	it("applies inline color style on icon when active", () => {
		const { container } = render(<TabButton icon="file" label="Active" isActive={true} onClick={vi.fn()} />)
		const iconSpan = container.querySelector(".codicon-file")!
		expect(iconSpan).toHaveStyle({ color: "var(--vscode-focusBorder)" })
	})

	it("does not apply inline color style on icon when inactive", () => {
		const { container } = render(<TabButton icon="file" label="Inactive" isActive={false} onClick={vi.fn()} />)
		const iconSpan = container.querySelector(".codicon-file")!
		expect(iconSpan).not.toHaveAttribute("style")
	})

	it("invokes onClick when clicked", () => {
		const onClick = vi.fn()
		render(<TabButton icon="file" label="Click Me" isActive={false} onClick={onClick} />)

		fireEvent.click(screen.getByRole("button"))
		expect(onClick).toHaveBeenCalledTimes(1)
	})

	// Mutation: switching isActive toggles the visual classes
	it("toggling isActive switches between active and inactive classes", () => {
		const { rerender } = render(<TabButton icon="file" label="Toggle" isActive={false} onClick={vi.fn()} />)
		const button = screen.getByRole("button")
		expect(button.className).toContain("border-transparent")

		rerender(<TabButton icon="file" label="Toggle" isActive={true} onClick={vi.fn()} />)
		expect(button.className).toContain("border-vscode-focusBorder")
		expect(button.className).not.toContain("border-transparent")
	})

	// Mutation: verify the icon prop drives the rendered codicon class
	it("changing icon prop updates the rendered codicon", () => {
		const { container, rerender } = render(
			<TabButton icon="file" label="Test" isActive={false} onClick={vi.fn()} />,
		)
		expect(container.querySelector(".codicon-file")).toBeInTheDocument()

		rerender(<TabButton icon="code" label="Test" isActive={false} onClick={vi.fn()} />)
		expect(container.querySelector(".codicon-code")).toBeInTheDocument()
		expect(container.querySelector(".codicon-file")).not.toBeInTheDocument()
	})
})
