import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import TaskItem from "../TaskItem"

vi.mock("@src/utils/vscode")
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/utils/format", () => ({
	formatTimeAgo: vi.fn(() => "2 hours ago"),
	formatDate: vi.fn(() => "January 15 at 2:30 PM"),
	formatLargeNumber: vi.fn((num: number) => num.toString()),
}))

const mockTask = {
	id: "1",
	number: 1,
	task: "Test task",
	ts: Date.now(),
	tokensIn: 100,
	tokensOut: 50,
	totalCost: 0.002,
	workspace: "/test/workspace",
}

describe("TaskItem", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders task information", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		expect(screen.getByText("Test task")).toBeInTheDocument()
		expect(screen.getByText("$0.00")).toBeInTheDocument() // Component shows $0.00 for small amounts
	})

	it("handles selection in selection mode", () => {
		const onToggleSelection = vi.fn()
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={onToggleSelection}
				isSelectionMode={true}
			/>,
		)

		const checkbox = screen.getByRole("checkbox")
		fireEvent.click(checkbox)

		expect(onToggleSelection).toHaveBeenCalledWith("1", true)
	})

	it("shows action buttons", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		// Should show copy and export buttons
		expect(screen.getByTestId("copy-prompt-button")).toBeInTheDocument()
		expect(screen.getByTestId("export")).toBeInTheDocument()
	})

	it("displays time ago information", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		// Should display time ago format
		expect(screen.getByText(/ago/)).toBeInTheDocument()
	})

	it("applies hover effect class", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		const taskItem = screen.getByTestId("task-item-1")
		expect(taskItem).toHaveClass("hover:text-vscode-foreground")
	})
	it("opens the task when the row is clicked", () => {
		render(<TaskItem item={mockTask} variant="full" />)

		fireEvent.click(screen.getByTestId("task-item-1"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "1" })
	})

	it("toggles selection instead of opening while selecting", () => {
		const onToggleSelection = vi.fn()
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelectionMode
				isSelected={false}
				onToggleSelection={onToggleSelection}
			/>,
		)

		fireEvent.click(screen.getByTestId("task-item-1"))

		expect(onToggleSelection).toHaveBeenCalledWith("1", true)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("opens the task while selecting when there is nothing to toggle", () => {
		render(<TaskItem item={mockTask} variant="full" isSelectionMode />)

		fireEvent.click(screen.getByTestId("task-item-1"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "1" })
	})

	it("shows the search highlight when the search produced one", () => {
		render(<TaskItem item={{ ...mockTask, highlight: "Test <span>task</span>" }} variant="full" />)

		expect(screen.getByTestId("task-content").querySelector("span")).toHaveTextContent("task")
	})
	it("rounds off the bottom corners only when subtasks follow", () => {
		const { rerender } = render(<TaskItem item={mockTask} variant="full" />)
		expect(screen.getByTestId("task-item-1").className).toContain("rounded-xl")

		rerender(<TaskItem item={mockTask} variant="full" hasSubtasks />)
		expect(screen.getByTestId("task-item-1").className).toContain("rounded-t-xl")
	})

	it("shows the workspace when asked to", () => {
		const { rerender } = render(<TaskItem item={mockTask} variant="full" showWorkspace />)
		expect(screen.getByText("/test/workspace")).toBeInTheDocument()

		rerender(<TaskItem item={{ ...mockTask, workspace: undefined }} variant="full" showWorkspace />)
		expect(screen.queryByText("/test/workspace")).not.toBeInTheDocument()
	})

	it("gives the text room to breathe next to the selection checkbox", () => {
		const { rerender } = render(
			<TaskItem item={mockTask} variant="full" isSelectionMode onToggleSelection={vi.fn()} />,
		)
		expect(screen.getByTestId("task-content").className).toContain("mb-1")

		// Highlighted search results are rendered through a different branch.
		rerender(
			<TaskItem
				item={{ ...mockTask, highlight: "Test <span>task</span>" }}
				variant="full"
				isSelectionMode
				onToggleSelection={vi.fn()}
			/>,
		)
		expect(screen.getByTestId("task-content").className).toContain("mb-1")

		rerender(<TaskItem item={{ ...mockTask, highlight: "Test task" }} variant="compact" />)
		expect(screen.getByTestId("task-content").className).not.toContain("mb-1")
	})
})
