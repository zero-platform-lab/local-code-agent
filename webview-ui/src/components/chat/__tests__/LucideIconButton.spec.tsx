import { createRef } from "react"
import { Play } from "lucide-react"

import { render, screen, fireEvent } from "@/utils/test-utils"

import { LucideIconButton } from "../LucideIconButton"

describe("LucideIconButton", () => {
	it("renders the icon and exposes the title as aria-label", () => {
		render(<LucideIconButton icon={Play} title="Play" />)
		expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument()
	})

	it("shows a spinner instead of the icon while loading", () => {
		const { container } = render(<LucideIconButton icon={Play} title="Play" isLoading />)
		expect(container.querySelector(".animate-spin")).toBeInTheDocument()
	})

	it("fires onClick when enabled", () => {
		const onClick = vi.fn()
		render(<LucideIconButton icon={Play} title="Play" onClick={onClick} />)
		fireEvent.click(screen.getByRole("button", { name: "Play" }))
		expect(onClick).toHaveBeenCalledTimes(1)
	})

	it("is disabled and does not fire onClick when disabled", () => {
		const onClick = vi.fn()
		render(<LucideIconButton icon={Play} title="Play" onClick={onClick} disabled />)
		const btn = screen.getByRole("button", { name: "Play" })
		expect(btn).toBeDisabled()
		fireEvent.click(btn)
		expect(onClick).not.toHaveBeenCalled()
	})

	it("renders without a tooltip when tooltip is false and forwards the ref", () => {
		const ref = createRef<HTMLButtonElement>()
		render(<LucideIconButton ref={ref} icon={Play} title="Play" tooltip={false} />)
		expect(ref.current).toBeInstanceOf(HTMLButtonElement)
	})
})
