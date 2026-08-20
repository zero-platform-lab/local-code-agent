// npx vitest run src/components/common/__tests__/IconButton.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"
import { IconButton } from "../IconButton"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("IconButton", () => {
	it("renders the icon span with correct codicon class", () => {
		const { container } = render(<IconButton icon="close" />)
		expect(container.querySelector(".codicon-close")).toBeInTheDocument()
	})

	it("invokes onClick when clicked", () => {
		const onClick = vi.fn()
		render(<IconButton icon="trash" onClick={onClick} />)

		fireEvent.click(screen.getByRole("button"))
		expect(onClick).toHaveBeenCalledTimes(1)
	})

	it("uses noop when onClick is not provided", () => {
		render(<IconButton icon="trash" />)
		// Should not throw
		fireEvent.click(screen.getByRole("button"))
	})

	it("wraps button in StandardTooltip when title is provided", () => {
		render(<IconButton icon="info" title="Info button" />)

		const button = screen.getByRole("button")
		expect(button).toHaveAttribute("aria-label", "Info button")
	})

	it("does not wrap in tooltip when title is absent", () => {
		render(<IconButton icon="info" />)
		const button = screen.getByRole("button")
		expect(button).not.toHaveAttribute("aria-label")
	})

	it("applies small size class", () => {
		render(<IconButton icon="close" size="small" />)
		const button = screen.getByRole("button")
		expect(button.className).toContain("w-6")
		expect(button.className).toContain("h-6")
	})

	it("applies medium size class by default", () => {
		render(<IconButton icon="close" />)
		const button = screen.getByRole("button")
		expect(button.className).toContain("w-7")
		expect(button.className).toContain("h-7")
	})

	it("applies transparent variant class", () => {
		render(<IconButton icon="close" variant="transparent" />)
		const button = screen.getByRole("button")
		expect(button.className).toContain("bg-transparent")
	})

	it("forwards mouse event handlers", () => {
		const onMouseDown = vi.fn()
		const onMouseUp = vi.fn()
		const onMouseLeave = vi.fn()
		render(
			<IconButton icon="zoom-in" onMouseDown={onMouseDown} onMouseUp={onMouseUp} onMouseLeave={onMouseLeave} />,
		)

		const button = screen.getByRole("button")
		fireEvent.mouseDown(button)
		fireEvent.mouseUp(button)
		fireEvent.mouseLeave(button)

		expect(onMouseDown).toHaveBeenCalledTimes(1)
		expect(onMouseUp).toHaveBeenCalledTimes(1)
		expect(onMouseLeave).toHaveBeenCalledTimes(1)
	})

	// Mutation: verify icon prop drives the rendered class
	it("renders the correct icon for different values", () => {
		const { container, rerender } = render(<IconButton icon="save" />)
		expect(container.querySelector(".codicon-save")).toBeInTheDocument()

		rerender(<IconButton icon="copy" />)
		expect(container.querySelector(".codicon-copy")).toBeInTheDocument()
		expect(container.querySelector(".codicon-save")).not.toBeInTheDocument()
	})

	// Mutation: verify size mapping is correct (small != medium)
	it("small and medium produce different widths", () => {
		const { rerender } = render(<IconButton icon="x" size="small" />)
		const smallBtn = screen.getByRole("button")
		expect(smallBtn.className).toContain("w-6")
		expect(smallBtn.className).not.toContain("w-7")

		rerender(<IconButton icon="x" size="medium" />)
		const medBtn = screen.getByRole("button")
		expect(medBtn.className).toContain("w-7")
		expect(medBtn.className).not.toContain("w-6")
	})
})
