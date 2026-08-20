import { render, screen, fireEvent } from "@/utils/test-utils"

import UpdateTodoListToolBlock from "../UpdateTodoListToolBlock"

vi.mock("../../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown?: string }) => <div data-testid="markdown-block">{markdown}</div>,
}))

const todos = [
	{ id: "a", content: "First todo", status: "" },
	{ id: "b", content: "Second todo", status: "in_progress" },
	{ id: "c", content: "Third todo", status: "completed" },
]

const startEditing = () => fireEvent.click(screen.getByRole("button", { name: "Edit" }))

describe("UpdateTodoListToolBlock — reading the list", () => {
	it("lists every todo it was given", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} />)

		expect(screen.getByText("First todo")).toBeInTheDocument()
		expect(screen.getByText("Second todo")).toBeInTheDocument()
		expect(screen.getByText("Third todo")).toBeInTheDocument()
	})

	it("falls back to the raw content when there is no list", () => {
		render(<UpdateTodoListToolBlock todos={[]} content="raw text" onChange={vi.fn()} />)

		expect(screen.getByTestId("markdown-block")).toHaveTextContent("raw text")
	})

	it("shows only that the user edited the list when that is what happened", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} userEdited />)

		expect(screen.getByText("User Edit")).toBeInTheDocument()
		expect(screen.queryByText("First todo")).not.toBeInTheDocument()
	})

	it("offers no editing when editing is switched off", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} editable={false} />)

		expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument()
	})

	it("gives every todo an id, even ones that arrive without one", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={[{ content: "No id here" }]} onChange={onChange} />)
		startEditing()

		fireEvent.change(screen.getByDisplayValue("No id here"), { target: { value: "Renamed" } })

		expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ content: "Renamed", id: expect.any(String) })])
	})

	it("follows the list it is given when that list changes", () => {
		const { rerender } = render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} />)

		rerender(<UpdateTodoListToolBlock todos={[{ id: "z", content: "Only this" }]} onChange={vi.fn()} />)

		expect(screen.getByText("Only this")).toBeInTheDocument()
		expect(screen.queryByText("First todo")).not.toBeInTheDocument()
	})

	it("complains when nobody is listening for changes", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		render(<UpdateTodoListToolBlock todos={todos} onChange={undefined as never} />)

		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
	})
})

describe("UpdateTodoListToolBlock — editing", () => {
	it("switches in and out of edit mode", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} />)

		startEditing()
		expect(screen.getByDisplayValue("First todo")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Done" }))
		expect(screen.queryByDisplayValue("First todo")).not.toBeInTheDocument()
	})

	it("leaves edit mode when editing is taken away", () => {
		const { rerender } = render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} />)
		startEditing()

		rerender(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} editable={false} />)

		expect(screen.queryByDisplayValue("First todo")).not.toBeInTheDocument()
	})

	it("reports an edited todo straight away", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()

		fireEvent.change(screen.getByDisplayValue("First todo"), { target: { value: "Changed" } })

		expect(onChange).toHaveBeenCalledWith([
			expect.objectContaining({ id: "a", content: "Changed" }),
			expect.objectContaining({ id: "b" }),
			expect.objectContaining({ id: "c" }),
		])
	})

	it("reports a status change", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()

		fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "completed" } })

		expect(onChange).toHaveBeenCalledWith([
			expect.objectContaining({ id: "a", status: "completed" }),
			expect.objectContaining({ id: "b" }),
			expect.objectContaining({ id: "c" }),
		])
	})

	it("asks before removing a todo and keeps it when the answer is no", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()

		fireEvent.click(screen.getAllByTitle("Remove")[0])
		expect(screen.getByText(/Are you sure/)).toBeInTheDocument()
		expect(onChange).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(screen.queryByText(/Are you sure/)).not.toBeInTheDocument()
		expect(onChange).not.toHaveBeenCalled()
	})

	it("removes exactly the confirmed todo", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()

		fireEvent.click(screen.getAllByTitle("Remove")[1])
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))

		expect(onChange).toHaveBeenCalledWith([
			expect.objectContaining({ id: "a" }),
			expect.objectContaining({ id: "c" }),
		])
		expect(screen.queryByText(/Are you sure/)).not.toBeInTheDocument()
	})

	it("closes the confirmation when the backdrop is clicked", () => {
		const { container } = render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} />)
		startEditing()
		fireEvent.click(screen.getAllByTitle("Remove")[0])

		fireEvent.click(container.querySelector("[style*='position: fixed']")!)

		expect(screen.queryByText(/Are you sure/)).not.toBeInTheDocument()
	})

	it("keeps the confirmation open when the dialog itself is clicked", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} />)
		startEditing()
		fireEvent.click(screen.getAllByTitle("Remove")[0])

		fireEvent.click(screen.getByText(/Are you sure/))

		expect(screen.getByText(/Are you sure/)).toBeInTheDocument()
	})

	it("offers to remove a todo that was emptied out", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} />)
		startEditing()

		const input = screen.getByDisplayValue("First todo")
		fireEvent.change(input, { target: { value: "   " } })
		fireEvent.blur(input, { target: { value: "   " } })

		expect(screen.getByText(/Are you sure/)).toBeInTheDocument()
	})

	it("leaves a todo alone when it still has content after editing", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} />)
		startEditing()

		fireEvent.blur(screen.getByDisplayValue("First todo"), { target: { value: "still here" } })

		expect(screen.queryByText(/Are you sure/)).not.toBeInTheDocument()
	})
})

describe("UpdateTodoListToolBlock — adding", () => {
	it("adds a todo from the inline form", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()

		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))
		fireEvent.change(screen.getByPlaceholderText("Enter todo item, press Enter to add"), {
			target: { value: "  New todo  " },
		})
		fireEvent.click(screen.getByRole("button", { name: "Add" }))

		expect(onChange).toHaveBeenCalledWith([
			...todos.map((todo) => expect.objectContaining({ id: todo.id })),
			expect.objectContaining({ content: "New todo", status: "" }),
		])
		expect(screen.queryByPlaceholderText("Enter todo item, press Enter to add")).not.toBeInTheDocument()
	})

	it("adds a todo with the Enter key", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()
		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))

		const input = screen.getByPlaceholderText("Enter todo item, press Enter to add")
		fireEvent.change(input, { target: { value: "Typed todo" } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(onChange).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ content: "Typed todo" })]),
		)
	})

	it("adds nothing for an empty entry", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()
		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))

		fireEvent.change(screen.getByPlaceholderText("Enter todo item, press Enter to add"), {
			target: { value: "   " },
		})
		fireEvent.click(screen.getByRole("button", { name: "Add" }))

		expect(onChange).not.toHaveBeenCalled()
		expect(screen.getByPlaceholderText("Enter todo item, press Enter to add")).toBeInTheDocument()
	})

	it("abandons the entry with Escape", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()
		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))

		const input = screen.getByPlaceholderText("Enter todo item, press Enter to add")
		fireEvent.change(input, { target: { value: "Never mind" } })
		fireEvent.keyDown(input, { key: "Escape" })

		expect(onChange).not.toHaveBeenCalled()
		expect(screen.queryByPlaceholderText("Enter todo item, press Enter to add")).not.toBeInTheDocument()
	})

	it("ignores other keys while typing a new todo", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()
		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))

		const input = screen.getByPlaceholderText("Enter todo item, press Enter to add")
		fireEvent.change(input, { target: { value: "Half typed" } })
		fireEvent.keyDown(input, { key: "a" })

		expect(onChange).not.toHaveBeenCalled()
		expect(screen.getByPlaceholderText("Enter todo item, press Enter to add")).toBeInTheDocument()
	})

	it("abandons the entry from the cancel button", () => {
		render(<UpdateTodoListToolBlock todos={todos} onChange={vi.fn()} />)
		startEditing()
		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))

		fireEvent.change(screen.getByPlaceholderText("Enter todo item, press Enter to add"), {
			target: { value: "Never mind" },
		})
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(screen.queryByPlaceholderText("Enter todo item, press Enter to add")).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))
		expect(screen.getByPlaceholderText("Enter todo item, press Enter to add")).toHaveValue("")
	})
	it("adds nothing when Enter is pressed on an empty entry", () => {
		const onChange = vi.fn()
		render(<UpdateTodoListToolBlock todos={todos} onChange={onChange} />)
		startEditing()
		fireEvent.click(screen.getByRole("button", { name: "+ Add Todo" }))

		fireEvent.keyDown(screen.getByPlaceholderText("Enter todo item, press Enter to add"), { key: "Enter" })

		expect(onChange).not.toHaveBeenCalled()
		expect(screen.getByPlaceholderText("Enter todo item, press Enter to add")).toBeInTheDocument()
	})
})
