import { render, screen, fireEvent } from "@/utils/test-utils"

import { TodoListDisplay } from "../TodoListDisplay"

vi.mock("i18next", () => ({
	t: (key: string, opts?: Record<string, unknown>) => `${key}:${JSON.stringify(opts ?? {})}`,
}))

describe("TodoListDisplay", () => {
	it("renders nothing for a non-array or empty list", () => {
		expect(render(<TodoListDisplay todos={[]} />).container.firstChild).toBeNull()
		expect(render(<TodoListDisplay todos={undefined as any} />).container.firstChild).toBeNull()
	})

	it("collapsed: shows the in-progress todo content and the count badge, in yellow", () => {
		const { container } = render(
			<TodoListDisplay
				todos={[
					{ id: "1", content: "done", status: "completed" },
					{ id: "2", content: "current", status: "in_progress" },
					{ id: "3", content: "later", status: "pending" },
				]}
			/>,
		)
		// 折りたたみ時は最重要 todo の content
		expect(screen.getByText("current")).toBeInTheDocument()
		// 完了数/総数バッジ
		expect(screen.getByText("1/3")).toBeInTheDocument()
		// in_progress かつ collapsed → 黄色
		expect(container.querySelector(".text-vscode-charts-yellow")).toBeInTheDocument()
	})

	it("collapsed: shows the complete label when all todos are done", () => {
		render(
			<TodoListDisplay
				todos={[
					{ id: "1", content: "a", status: "completed" },
					{ id: "2", content: "b", status: "completed" },
				]}
			/>,
		)
		expect(screen.getByText(/chat:todo\.complete/)).toBeInTheDocument()
		// 全完了時はカウントバッジを出さない
		expect(screen.queryByText("2/2")).not.toBeInTheDocument()
	})

	it("expands to show every item with status-specific styling and toggles back", () => {
		const { container } = render(
			<TodoListDisplay
				todos={[
					{ id: "1", content: "done", status: "completed" },
					{ id: "2", content: "current", status: "in_progress" },
					{ id: "3", content: "later", status: "pending" },
				]}
			/>,
		)
		const header = container.querySelector(".cursor-pointer") as HTMLElement
		fireEvent.click(header)
		// 展開時は partial ラベル
		expect(screen.getByText(/chat:todo\.partial/)).toBeInTheDocument()
		// 全アイテムが表示される
		expect(screen.getByText("done")).toBeInTheDocument()
		expect(screen.getByText("later")).toBeInTheDocument()
		// pending は opacity-60
		expect(container.querySelector(".opacity-60")).toBeInTheDocument()

		fireEvent.click(header)
		expect(screen.queryByText(/chat:todo\.partial/)).not.toBeInTheDocument()
	})

	it("expands cleanly when every todo is completed (scrollIndex === -1 path)", () => {
		const { container } = render(
			<TodoListDisplay
				todos={[
					{ id: "1", content: "a", status: "completed" },
					{ id: "2", content: "b", status: "completed" },
				]}
			/>,
		)
		fireEvent.click(container.querySelector(".cursor-pointer") as HTMLElement)
		expect(screen.getByText("a")).toBeInTheDocument()
		expect(screen.getByText("b")).toBeInTheDocument()
	})

	it("keys expanded rows by content when a todo has no id", () => {
		const { container } = render(
			<TodoListDisplay
				todos={[
					{ content: "no-id-a", status: "pending" },
					{ content: "no-id-b", status: "pending" },
				]}
			/>,
		)
		fireEvent.click(container.querySelector(".cursor-pointer") as HTMLElement)
		expect(screen.getByText("no-id-a")).toBeInTheDocument()
		expect(screen.getByText("no-id-b")).toBeInTheDocument()
	})

	it("uses the first non-completed todo when none is in progress (collapsed content)", () => {
		render(
			<TodoListDisplay
				todos={[
					{ id: "1", content: "done", status: "completed" },
					{ id: "2", content: "next-up", status: "pending" },
				]}
			/>,
		)
		expect(screen.getByText("next-up")).toBeInTheDocument()
	})
})
