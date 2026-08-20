import { render, screen, fireEvent } from "@/utils/test-utils"

import SubtaskCollapsibleRow from "../SubtaskCollapsibleRow"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options?.count !== undefined ? `${key}:${options.count}` : key,
	}),
}))

describe("SubtaskCollapsibleRow", () => {
	it("shows how many subtasks there are", () => {
		render(<SubtaskCollapsibleRow count={3} isExpanded={false} onToggle={vi.fn()} />)

		expect(screen.getByTestId("subtask-collapsible-row")).toHaveTextContent("history:subtasks:3")
	})

	it("stays out of the way when there are no subtasks", () => {
		const { container } = render(<SubtaskCollapsibleRow count={0} isExpanded={false} onToggle={vi.fn()} />)

		expect(container).toBeEmptyDOMElement()
	})

	it("announces and shows whether the list is open", () => {
		const { rerender, container } = render(
			<SubtaskCollapsibleRow count={2} isExpanded={false} onToggle={vi.fn()} />,
		)
		const row = screen.getByTestId("subtask-collapsible-row")

		expect(row).toHaveAttribute("aria-expanded", "false")
		expect(row).toHaveAttribute("aria-label", "history:expandSubtasks")
		expect(container.querySelector(".rotate-90")).not.toBeInTheDocument()

		rerender(<SubtaskCollapsibleRow count={2} isExpanded onToggle={vi.fn()} />)

		expect(row).toHaveAttribute("aria-expanded", "true")
		expect(row).toHaveAttribute("aria-label", "history:collapseSubtasks")
		expect(container.querySelector(".rotate-90")).toBeInTheDocument()
	})

	it("toggles without also opening the task behind it", () => {
		const onToggle = vi.fn()
		const onRowClick = vi.fn()
		render(
			<div onClick={onRowClick}>
				<SubtaskCollapsibleRow count={2} isExpanded={false} onToggle={onToggle} />
			</div>,
		)

		fireEvent.click(screen.getByTestId("subtask-collapsible-row"))

		expect(onToggle).toHaveBeenCalledTimes(1)
		expect(onRowClick).not.toHaveBeenCalled()
	})

	it("keeps any extra styling it was given", () => {
		render(<SubtaskCollapsibleRow count={1} isExpanded={false} onToggle={vi.fn()} className="my-class" />)

		expect(screen.getByTestId("subtask-collapsible-row").className).toContain("my-class")
	})
})
