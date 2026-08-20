import { render, screen, fireEvent } from "@/utils/test-utils"

import { IconButton } from "../IconButton"

describe("IconButton", () => {
	it("renders with the title as aria-label and the icon class", () => {
		const { container } = render(<IconButton iconClass="codicon-play" title="Run" />)
		const btn = screen.getByRole("button", { name: "Run" })
		expect(btn).toBeInTheDocument()
		expect(container.querySelector(".codicon-play")).toBeInTheDocument()
	})

	it("adds the spin modifier when loading", () => {
		const { container } = render(<IconButton iconClass="codicon-play" title="Run" isLoading />)
		expect(container.querySelector(".codicon-modifier-spin")).toBeInTheDocument()
	})

	it("does not add the spin modifier when not loading", () => {
		const { container } = render(<IconButton iconClass="codicon-play" title="Run" />)
		expect(container.querySelector(".codicon-modifier-spin")).not.toBeInTheDocument()
	})

	it("fires onClick when enabled", () => {
		const onClick = vi.fn()
		render(<IconButton iconClass="codicon-play" title="Run" onClick={onClick} />)
		fireEvent.click(screen.getByRole("button", { name: "Run" }))
		expect(onClick).toHaveBeenCalledTimes(1)
	})

	it("is disabled and does not fire onClick when disabled", () => {
		const onClick = vi.fn()
		render(<IconButton iconClass="codicon-play" title="Run" onClick={onClick} disabled />)
		const btn = screen.getByRole("button", { name: "Run" })
		expect(btn).toBeDisabled()
		fireEvent.click(btn)
		expect(onClick).not.toHaveBeenCalled()
	})

	it("renders without a tooltip when tooltip is false", () => {
		render(<IconButton iconClass="codicon-play" title="Run" tooltip={false} />)
		expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument()
	})
})
