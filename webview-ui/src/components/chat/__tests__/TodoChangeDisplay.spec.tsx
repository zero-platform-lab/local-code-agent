import { render, screen } from "@/utils/test-utils"

import { TodoChangeDisplay } from "../TodoChangeDisplay"

vi.mock("i18next", () => ({
	t: (key: string) => key,
}))

describe("TodoChangeDisplay", () => {
	it("renders nothing when there is nothing new to display (updates with no changes)", () => {
		const { container } = render(
			<TodoChangeDisplay
				previousTodos={[{ id: "1", content: "a", status: "pending" }]}
				newTodos={[{ id: "1", content: "a", status: "pending" }]}
			/>,
		)
		expect(container.firstChild).toBeNull()
	})

	it("shows all todos in the initial state (no previous todos)", () => {
		render(
			<TodoChangeDisplay
				previousTodos={[]}
				newTodos={[
					{ id: "1", content: "first", status: "completed" },
					{ id: "2", content: "second", status: "in_progress" },
					{ id: "3", content: "third", status: "pending" },
				]}
			/>,
		)
		expect(screen.getByText("chat:todo.updated")).toBeInTheDocument()
		expect(screen.getByText("first")).toBeInTheDocument()
		expect(screen.getByText("second")).toBeInTheDocument()
		expect(screen.getByText("third")).toBeInTheDocument()
	})

	it("shows only newly-completed and newly-started todos on update", () => {
		render(
			<TodoChangeDisplay
				previousTodos={[
					{ id: "1", content: "done-already", status: "completed" },
					{ id: "2", content: "now-complete", status: "pending" },
					{ id: "3", content: "now-started", status: "pending" },
					{ id: "4", content: "still-pending", status: "pending" },
				]}
				newTodos={[
					{ id: "1", content: "done-already", status: "completed" },
					{ id: "2", content: "now-complete", status: "completed" },
					{ id: "3", content: "now-started", status: "in_progress" },
					{ id: "4", content: "still-pending", status: "pending" },
					{ id: "5", content: "brand-new-complete", status: "completed" },
					{ id: "6", content: "brand-new-started", status: "in_progress" },
				]}
			/>,
		)
		// 既に完了済みは再表示しない
		expect(screen.queryByText("done-already")).not.toBeInTheDocument()
		// 変化のない pending は表示しない
		expect(screen.queryByText("still-pending")).not.toBeInTheDocument()
		expect(screen.getByText("now-complete")).toBeInTheDocument()
		expect(screen.getByText("now-started")).toBeInTheDocument()
		// 直前に存在しなかった完了/開始も表示される（!previousTodo の分岐）
		expect(screen.getByText("brand-new-complete")).toBeInTheDocument()
		expect(screen.getByText("brand-new-started")).toBeInTheDocument()
	})

	it("keys by content and defaults to pending when a todo carries neither id nor status", () => {
		const { container } = render(<TodoChangeDisplay previousTodos={[]} newTodos={[{ content: "bare" }]} />)
		expect(screen.getByText("bare")).toBeInTheDocument()
		// status 無しは pending 扱い＝ in_progress の黄色にはしない
		expect(container.querySelector(".text-vscode-charts-yellow")).toBeNull()
	})

	it("matches previous todos by content when id is absent, and falls back to pending icon", () => {
		const { container } = render(
			<TodoChangeDisplay
				previousTodos={[{ content: "task", status: "in_progress" }]}
				newTodos={[{ content: "task", status: "in_progress" }]}
			/>,
		)
		// 既に in_progress の同一 content は変化なし → 何も出さない
		expect(container.firstChild).toBeNull()
	})
})
