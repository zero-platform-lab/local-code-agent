// npx vitest run src/components/history/__tests__/HistoryView.spec.tsx

import { render, screen, fireEvent, within } from "@/utils/test-utils"

import { useExtensionState } from "@src/context/ExtensionStateContext"

import HistoryView from "../HistoryView"

vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode")

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
	}),
}))

// Virtuoso は jsdom では高さ 0 で何も描画しないため、行を素直に展開するモックに差し替える。
vi.mock("react-virtuoso", () => ({
	Virtuoso: ({ data, itemContent, components }: any) => {
		const List = components?.List ?? "div"
		return (
			<List data-testid="virtuoso-list">
				{data.map((item: any, index: number) => (
					<div key={index}>{itemContent(index, item)}</div>
				))}
			</List>
		)
	},
}))

vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	const { createContext, useContext } = await import("react")
	const SelectContext = createContext<(value: string) => void>(() => {})

	return {
		...actual,
		Select: ({ children, value, onValueChange }: any) => (
			<SelectContext.Provider value={onValueChange}>
				<div data-value={value}>{children}</div>
			</SelectContext.Provider>
		),
		SelectContent: ({ children }: any) => <div>{children}</div>,
		SelectTrigger: ({ children }: any) => <div>{children}</div>,
		SelectValue: ({ children }: any) => <div data-testid="select-value">{children}</div>,
		SelectItem: ({ children, value, disabled, ...rest }: any) => {
			const onValueChange = useContext(SelectContext)
			return (
				<button
					data-testid={`select-item-${value}`}
					disabled={disabled}
					onClick={() => onValueChange(value)}
					{...rest}>
					{children}
				</button>
			)
		},
	}
})

vi.mock("../TaskItem", () => ({
	__esModule: true,
	default: ({ item, showWorkspace, isSelectionMode, isSelected, onToggleSelection, onDelete }: any) => (
		<div
			data-testid={`task-item-${item.id}`}
			data-show-workspace={String(showWorkspace)}
			data-selection-mode={String(isSelectionMode)}
			data-selected={String(isSelected)}
			data-subtask={String(item.isSubtask)}>
			<button data-testid={`task-item-${item.id}-select`} onClick={() => onToggleSelection(item.id, true)} />
			<button data-testid={`task-item-${item.id}-deselect`} onClick={() => onToggleSelection(item.id, false)} />
			<button data-testid={`task-item-${item.id}-delete`} onClick={() => onDelete(item.id)} />
		</div>
	),
}))

vi.mock("../TaskGroupItem", () => ({
	__esModule: true,
	default: ({
		group,
		showWorkspace,
		isSelectionMode,
		isSelected,
		onToggleSelection,
		onDelete,
		onToggleExpand,
		onToggleSubtaskExpand,
	}: any) => (
		<div
			data-testid={`task-group-${group.parent.id}`}
			data-show-workspace={String(showWorkspace)}
			data-selection-mode={String(isSelectionMode)}
			data-selected={String(isSelected)}
			data-expanded={String(group.isExpanded)}
			data-subtasks={group.subtasks.length}>
			<button
				data-testid={`task-group-${group.parent.id}-select`}
				onClick={() => onToggleSelection(group.parent.id, true)}
			/>
			<button
				data-testid={`task-group-${group.parent.id}-deselect`}
				onClick={() => onToggleSelection(group.parent.id, false)}
			/>
			<button data-testid={`task-group-${group.parent.id}-delete`} onClick={() => onDelete(group.parent.id)} />
			<button data-testid={`task-group-${group.parent.id}-expand`} onClick={onToggleExpand} />
			{group.subtasks.map((subtask: any) => (
				<button
					key={subtask.item.id}
					data-testid={`task-group-${group.parent.id}-expand-${subtask.item.id}`}
					data-expanded={String(subtask.isExpanded)}
					onClick={() => onToggleSubtaskExpand(subtask.item.id)}
				/>
			))}
		</div>
	),
}))

vi.mock("../DeleteTaskDialog", () => ({
	DeleteTaskDialog: ({ taskId, subtaskCount, open, onOpenChange }: any) => (
		<div
			data-testid="delete-task-dialog"
			data-task-id={taskId}
			data-subtask-count={subtaskCount}
			data-open={String(open)}>
			<button data-testid="delete-task-dialog-close" onClick={() => onOpenChange(false)} />
			<button data-testid="delete-task-dialog-keep-open" onClick={() => onOpenChange(true)} />
		</div>
	),
}))

vi.mock("../BatchDeleteTaskDialog", () => ({
	BatchDeleteTaskDialog: ({ taskIds, open, onOpenChange }: any) => (
		<div data-testid="batch-delete-dialog" data-task-ids={taskIds.join(",")} data-open={String(open)}>
			<button data-testid="batch-delete-dialog-close" onClick={() => onOpenChange(false)} />
			<button data-testid="batch-delete-dialog-keep-open" onClick={() => onOpenChange(true)} />
		</div>
	),
}))

const baseTs = 1_700_000_000_000

const mockTaskHistory = [
	{
		id: "1",
		task: "alpha parent task",
		ts: baseTs,
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.002,
		workspace: "/test/workspace",
	},
	{
		id: "2",
		task: "beta subtask",
		ts: baseTs + 1000,
		tokensIn: 200,
		tokensOut: 100,
		totalCost: 0.003,
		workspace: "/test/workspace",
		parentTaskId: "1",
	},
	{
		id: "3",
		task: "gamma standalone",
		ts: baseTs + 2000,
		tokensIn: 10,
		tokensOut: 5,
		totalCost: 0.001,
		workspace: "/test/workspace",
	},
	{
		id: "4",
		task: "delta other workspace",
		ts: baseTs + 3000,
		tokensIn: 1,
		tokensOut: 1,
		totalCost: 0.004,
		workspace: "/other/workspace",
	},
]

const search = () => screen.getByPlaceholderText("history:searchPlaceholder")

const typeSearch = (value: string) => fireEvent.input(search(), { target: { value } })

const enterSelectionMode = () => fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

// 先に描画されるのがワークスペース、次がソートの Select。
const workspaceLabel = () => screen.getAllByTestId("select-value")[0].textContent
const sortLabel = () => screen.getAllByTestId("select-value")[1].textContent

describe("HistoryView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			taskHistory: mockTaskHistory,
			cwd: "/test/workspace",
		})
	})

	it("renders the history interface", () => {
		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.getByText("history:history")).toBeInTheDocument()
		expect(screen.getByText("history:done")).toBeInTheDocument()
		expect(search()).toBeInTheDocument()
	})

	it("calls onDone when done button is clicked", () => {
		const onDone = vi.fn()
		render(<HistoryView onDone={onDone} />)

		fireEvent.click(screen.getByTestId("history-done-button"))

		expect(onDone).toHaveBeenCalled()
	})

	it("groups subtasks under their parent and hides tasks from other workspaces", () => {
		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-subtasks", "1")
		expect(screen.getByTestId("task-group-3")).toHaveAttribute("data-subtasks", "0")
		// 別ワークスペースのタスクと、親にぶら下がるサブタスクはトップレベルには出ない。
		expect(screen.queryByTestId("task-group-4")).not.toBeInTheDocument()
		expect(screen.queryByTestId("task-group-2")).not.toBeInTheDocument()
	})

	describe("search", () => {
		it("switches to a flat list and marks subtasks while searching", () => {
			render(<HistoryView onDone={vi.fn()} />)

			typeSearch("task")

			expect(screen.queryByTestId("task-group-1")).not.toBeInTheDocument()
			expect(screen.getByTestId("task-item-1")).toHaveAttribute("data-subtask", "false")
			expect(screen.getByTestId("task-item-2")).toHaveAttribute("data-subtask", "true")
		})

		it("switches the sort order to most relevant on the first keystroke only", () => {
			render(<HistoryView onDone={vi.fn()} />)

			expect(sortLabel()).toContain("history:sort.newest")

			typeSearch("beta")
			expect(sortLabel()).toContain("history:sort.mostRelevant")

			// 2 文字目以降は既に mostRelevant なので何も起きない。
			typeSearch("beta s")
			expect(sortLabel()).toContain("history:sort.mostRelevant")
		})

		it("keeps an explicitly chosen sort order while the query keeps changing", () => {
			render(<HistoryView onDone={vi.fn()} />)

			typeSearch("task")
			fireEvent.click(screen.getByTestId("select-oldest"))
			expect(sortLabel()).toContain("history:sort.oldest")

			typeSearch("task 1")

			expect(sortLabel()).toContain("history:sort.oldest")
		})

		it("restores the previous sort order when the search is cleared", () => {
			render(<HistoryView onDone={vi.fn()} />)

			fireEvent.click(screen.getByTestId("select-oldest"))
			typeSearch("beta")
			expect(sortLabel()).toContain("history:sort.mostRelevant")

			fireEvent.click(screen.getByLabelText("Clear search"))

			expect(sortLabel()).toContain("history:sort.oldest")
			expect(screen.queryByLabelText("Clear search")).not.toBeInTheDocument()
			expect(screen.getByTestId("task-group-1")).toBeInTheDocument()
		})

		it("keeps the sort order when the search box is emptied by editing", () => {
			render(<HistoryView onDone={vi.fn()} />)

			typeSearch("")

			expect(sortLabel()).toContain("history:sort.newest")
			expect(screen.queryByLabelText("Clear search")).not.toBeInTheDocument()
		})

		it("only enables the most relevant option while a query is present", () => {
			render(<HistoryView onDone={vi.fn()} />)

			expect(screen.getByTestId("select-most-relevant")).toBeDisabled()

			typeSearch("beta")

			expect(screen.getByTestId("select-most-relevant")).toBeEnabled()
		})
	})

	describe("workspace filter", () => {
		it("shows every workspace when the filter is switched to all", () => {
			render(<HistoryView onDone={vi.fn()} />)

			expect(workspaceLabel()).toContain("history:workspace.current")

			fireEvent.click(screen.getByTestId("select-item-all"))

			expect(workspaceLabel()).toContain("history:workspace.all")
			expect(screen.getByTestId("task-group-4")).toBeInTheDocument()
			expect(screen.getByTestId("task-group-4")).toHaveAttribute("data-show-workspace", "true")
		})

		it("switches back to the current workspace only", () => {
			render(<HistoryView onDone={vi.fn()} />)

			fireEvent.click(screen.getByTestId("select-item-all"))
			fireEvent.click(screen.getByTestId("select-item-current"))

			expect(screen.queryByTestId("task-group-4")).not.toBeInTheDocument()
			expect(screen.getByTestId("task-group-3")).toHaveAttribute("data-show-workspace", "false")
		})
	})

	it("re-sorts the search results when another sort option is picked", () => {
		render(<HistoryView onDone={vi.fn()} />)

		const idsInOrder = () =>
			screen
				.getAllByTestId(/^task-item-\d+$/)
				.map((element) => element.getAttribute("data-testid")?.replace("task-item-", ""))

		typeSearch("task")
		expect(idsInOrder()).toEqual(["1", "2"])

		fireEvent.click(screen.getByTestId("select-oldest"))
		expect(sortLabel()).toContain("history:sort.oldest")
		expect(idsInOrder()).toEqual(["1", "2"])

		fireEvent.click(screen.getByTestId("select-newest"))
		expect(idsInOrder()).toEqual(["2", "1"])

		fireEvent.click(screen.getByTestId("select-most-expensive"))
		expect(idsInOrder()).toEqual(["2", "1"])

		fireEvent.click(screen.getByTestId("select-most-tokens"))
		expect(idsInOrder()).toEqual(["2", "1"])
	})

	it("expands a group and its subtasks", () => {
		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-expanded", "false")

		fireEvent.click(screen.getByTestId("task-group-1-expand"))
		expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-expanded", "true")

		fireEvent.click(screen.getByTestId("task-group-1-expand-2"))
		expect(screen.getByTestId("task-group-1-expand-2")).toHaveAttribute("data-expanded", "true")
	})

	describe("selection mode", () => {
		it("shows the select-all control and hides it again when leaving the mode", () => {
			render(<HistoryView onDone={vi.fn()} />)

			expect(screen.getByText("history:selectionMode")).toBeInTheDocument()
			expect(screen.queryByText("history:selectAll")).not.toBeInTheDocument()

			enterSelectionMode()

			expect(screen.getByText("history:exitSelection")).toBeInTheDocument()
			expect(screen.getByText("history:selectAll")).toBeInTheDocument()
			expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-selection-mode", "true")

			enterSelectionMode()

			expect(screen.getByText("history:selectionMode")).toBeInTheDocument()
			expect(screen.queryByText("history:selectAll")).not.toBeInTheDocument()
		})

		it("does not show the select-all control when there is nothing to select", () => {
			;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
				taskHistory: [],
				cwd: "/test/workspace",
			})
			render(<HistoryView onDone={vi.fn()} />)

			enterSelectionMode()

			expect(screen.queryByText("history:selectAll")).not.toBeInTheDocument()
		})

		it("tracks individual selection and clears it when leaving the mode", () => {
			render(<HistoryView onDone={vi.fn()} />)

			enterSelectionMode()
			fireEvent.click(screen.getByTestId("task-group-1-select"))

			expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-selected", "true")
			expect(screen.getAllByText('history:selectedItems:{"selected":1,"total":3}')).toHaveLength(2)

			fireEvent.click(screen.getByTestId("task-group-1-deselect"))
			expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-selected", "false")

			fireEvent.click(screen.getByTestId("task-group-1-select"))
			enterSelectionMode()
			enterSelectionMode()

			expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-selected", "false")
		})

		it("selects and deselects every task at once", () => {
			render(<HistoryView onDone={vi.fn()} />)

			enterSelectionMode()
			const selectAll = screen.getByRole("checkbox")

			fireEvent.click(selectAll)

			expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-selected", "true")
			expect(screen.getByTestId("task-group-3")).toHaveAttribute("data-selected", "true")
			expect(screen.getByText("history:deselectAll")).toBeInTheDocument()

			fireEvent.click(screen.getByRole("checkbox"))

			expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-selected", "false")
			expect(screen.getByText("history:selectAll")).toBeInTheDocument()
		})

		it("clears the selection from the action bar", () => {
			render(<HistoryView onDone={vi.fn()} />)

			enterSelectionMode()
			fireEvent.click(screen.getByTestId("task-group-1-select"))

			const actionBar = screen.getByText("history:clearSelection").closest("div")!.parentElement!
			fireEvent.click(within(actionBar).getByText("history:clearSelection"))

			expect(screen.queryByText("history:clearSelection")).not.toBeInTheDocument()
			expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-selected", "false")
		})
	})

	describe("batch delete", () => {
		it("opens the batch dialog with the selected task ids", () => {
			render(<HistoryView onDone={vi.fn()} />)

			enterSelectionMode()
			fireEvent.click(screen.getByTestId("task-group-1-select"))
			fireEvent.click(screen.getByTestId("task-group-3-select"))

			expect(screen.queryByTestId("batch-delete-dialog")).not.toBeInTheDocument()

			fireEvent.click(screen.getByText("history:deleteSelected"))

			const dialog = screen.getByTestId("batch-delete-dialog")
			expect(dialog).toHaveAttribute("data-task-ids", "1,3")
			expect(dialog).toHaveAttribute("data-open", "true")
		})

		it("leaves selection mode once the batch dialog closes", () => {
			render(<HistoryView onDone={vi.fn()} />)

			enterSelectionMode()
			fireEvent.click(screen.getByTestId("task-group-1-select"))
			fireEvent.click(screen.getByText("history:deleteSelected"))

			fireEvent.click(screen.getByTestId("batch-delete-dialog-close"))

			expect(screen.queryByTestId("batch-delete-dialog")).not.toBeInTheDocument()
			expect(screen.getByText("history:selectionMode")).toBeInTheDocument()
			expect(screen.getByTestId("task-group-1")).toHaveAttribute("data-selected", "false")
		})

		it("keeps the batch dialog open when it reports itself as open", () => {
			render(<HistoryView onDone={vi.fn()} />)

			enterSelectionMode()
			fireEvent.click(screen.getByTestId("task-group-1-select"))
			fireEvent.click(screen.getByText("history:deleteSelected"))

			fireEvent.click(screen.getByTestId("batch-delete-dialog-keep-open"))

			expect(screen.getByTestId("batch-delete-dialog")).toHaveAttribute("data-open", "true")
		})
	})

	describe("single delete", () => {
		it("passes the number of nested subtasks to the dialog", () => {
			render(<HistoryView onDone={vi.fn()} />)

			expect(screen.queryByTestId("delete-task-dialog")).not.toBeInTheDocument()

			fireEvent.click(screen.getByTestId("task-group-1-delete"))

			const dialog = screen.getByTestId("delete-task-dialog")
			expect(dialog).toHaveAttribute("data-task-id", "1")
			expect(dialog).toHaveAttribute("data-subtask-count", "1")
		})

		it("reports zero subtasks for tasks deleted from the search results", () => {
			render(<HistoryView onDone={vi.fn()} />)

			typeSearch("task")
			fireEvent.click(screen.getByTestId("task-item-1-delete"))

			expect(screen.getByTestId("delete-task-dialog")).toHaveAttribute("data-subtask-count", "0")
		})

		it("closes the dialog and forgets the task once it is dismissed", () => {
			render(<HistoryView onDone={vi.fn()} />)

			fireEvent.click(screen.getByTestId("task-group-1-delete"))
			fireEvent.click(screen.getByTestId("delete-task-dialog-close"))

			expect(screen.queryByTestId("delete-task-dialog")).not.toBeInTheDocument()
		})

		it("keeps the dialog open when it reports itself as open", () => {
			render(<HistoryView onDone={vi.fn()} />)

			fireEvent.click(screen.getByTestId("task-group-1-delete"))
			fireEvent.click(screen.getByTestId("delete-task-dialog-keep-open"))

			expect(screen.getByTestId("delete-task-dialog")).toHaveAttribute("data-task-id", "1")
		})

		it("selects tasks from the search results", () => {
			render(<HistoryView onDone={vi.fn()} />)

			enterSelectionMode()
			typeSearch("task")

			fireEvent.click(screen.getByTestId("task-item-2-select"))
			expect(screen.getByTestId("task-item-2")).toHaveAttribute("data-selected", "true")

			fireEvent.click(screen.getByTestId("task-item-2-deselect"))
			expect(screen.getByTestId("task-item-2")).toHaveAttribute("data-selected", "false")
		})
	})
})
