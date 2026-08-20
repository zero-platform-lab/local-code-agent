// npx vitest run src/components/common/__tests__/Modal.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"
import { Modal } from "../Modal"

describe("Modal", () => {
	it("renders children when isOpen is true", () => {
		render(
			<Modal isOpen={true} onClose={vi.fn()}>
				<div>Modal content</div>
			</Modal>,
		)
		expect(screen.getByText("Modal content")).toBeInTheDocument()
	})

	it("returns null when isOpen is false", () => {
		const { container } = render(
			<Modal isOpen={false} onClose={vi.fn()}>
				<div>Modal content</div>
			</Modal>,
		)
		expect(container.firstChild).toBeNull()
	})

	it("calls onClose when the overlay (backdrop) is clicked", () => {
		const onClose = vi.fn()
		const { container } = render(
			<Modal isOpen={true} onClose={onClose}>
				<div>Content</div>
			</Modal>,
		)

		// Click the backdrop (the outermost fixed div)
		const backdrop = container.firstChild as HTMLElement
		fireEvent.click(backdrop)
		expect(onClose).toHaveBeenCalledTimes(1)
	})

	it("does not call onClose when the inner content area is clicked", () => {
		const onClose = vi.fn()
		render(
			<Modal isOpen={true} onClose={onClose}>
				<div>Content</div>
			</Modal>,
		)

		// Click the inner content
		fireEvent.click(screen.getByText("Content"))
		expect(onClose).not.toHaveBeenCalled()
	})

	it("stopPropagation on inner div prevents backdrop click from firing", () => {
		const onClose = vi.fn()
		const { container } = render(
			<Modal isOpen={true} onClose={onClose}>
				<div>Inner content</div>
			</Modal>,
		)

		// The inner dialog div (second child of backdrop) should stop propagation
		const innerDialog = (container.firstChild as HTMLElement).firstChild as HTMLElement
		fireEvent.click(innerDialog)
		expect(onClose).not.toHaveBeenCalled()
	})

	it("applies custom className", () => {
		const { container } = render(
			<Modal isOpen={true} onClose={vi.fn()} className="custom-modal">
				<div>Content</div>
			</Modal>,
		)

		const innerDialog = (container.firstChild as HTMLElement).firstChild as HTMLElement
		expect(innerDialog.className).toContain("custom-modal")
	})

	it("applies default empty className when none provided", () => {
		const { container } = render(
			<Modal isOpen={true} onClose={vi.fn()}>
				<div>Content</div>
			</Modal>,
		)

		const innerDialog = (container.firstChild as HTMLElement).firstChild as HTMLElement
		// Should have the base classes but no extra custom class
		expect(innerDialog.className).toContain("bg-vscode-editor-background")
	})

	// Mutation: toggling isOpen changes render output
	it("transitions from closed to open", () => {
		const { container, rerender } = render(
			<Modal isOpen={false} onClose={vi.fn()}>
				<div>Content</div>
			</Modal>,
		)
		expect(container.firstChild).toBeNull()

		rerender(
			<Modal isOpen={true} onClose={vi.fn()}>
				<div>Content</div>
			</Modal>,
		)
		expect(screen.getByText("Content")).toBeInTheDocument()
	})

	// Mutation: onClose is the actual callback passed, not a different function
	it("onClose receives the exact callback provided", () => {
		const onClose1 = vi.fn()
		const onClose2 = vi.fn()
		const { container, rerender } = render(
			<Modal isOpen={true} onClose={onClose1}>
				<div>Content</div>
			</Modal>,
		)

		fireEvent.click(container.firstChild as HTMLElement)
		expect(onClose1).toHaveBeenCalledTimes(1)
		expect(onClose2).not.toHaveBeenCalled()

		rerender(
			<Modal isOpen={true} onClose={onClose2}>
				<div>Content</div>
			</Modal>,
		)

		fireEvent.click(container.firstChild as HTMLElement)
		expect(onClose2).toHaveBeenCalledTimes(1)
	})
})
