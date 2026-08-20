import { render, screen, fireEvent } from "@/utils/test-utils"

import { BatchDiffApproval } from "../BatchDiffApproval"

vi.mock("../../common/CodeAccordion", () => ({
	default: ({ path, code, language, isExpanded, onToggleExpand, diffStats }: any) => (
		<button
			data-testid={`accordion-${path}`}
			data-language={language}
			data-expanded={String(isExpanded)}
			data-stats={diffStats ? `${diffStats.added}/${diffStats.removed}` : "none"}
			onClick={onToggleExpand}>
			{code}
		</button>
	),
}))

const file = (path: string, extra: Record<string, unknown> = {}) => ({
	path,
	changeCount: 1,
	key: path,
	content: `--- a/${path}`,
	...extra,
})

describe("BatchDiffApproval", () => {
	it("renders one collapsed diff per file", () => {
		render(<BatchDiffApproval files={[file("a.ts"), file("b.ts")]} ts={1} />)

		expect(screen.getByTestId("accordion-a.ts")).toHaveAttribute("data-expanded", "false")
		expect(screen.getByTestId("accordion-b.ts")).toHaveAttribute("data-expanded", "false")
		expect(screen.getByTestId("accordion-a.ts")).toHaveAttribute("data-language", "diff")
	})

	it("renders nothing when there are no files", () => {
		const { container } = render(<BatchDiffApproval files={[]} ts={1} />)

		expect(container).toBeEmptyDOMElement()
	})

	it("renders nothing when the file list is missing entirely", () => {
		const { container } = render(<BatchDiffApproval files={undefined as never} ts={1} />)

		expect(container).toBeEmptyDOMElement()
	})

	it("expands only the file that was clicked, and folds it again on a second click", () => {
		render(<BatchDiffApproval files={[file("a.ts"), file("b.ts")]} ts={1} />)

		fireEvent.click(screen.getByTestId("accordion-a.ts"))

		expect(screen.getByTestId("accordion-a.ts")).toHaveAttribute("data-expanded", "true")
		expect(screen.getByTestId("accordion-b.ts")).toHaveAttribute("data-expanded", "false")

		fireEvent.click(screen.getByTestId("accordion-a.ts"))

		expect(screen.getByTestId("accordion-a.ts")).toHaveAttribute("data-expanded", "false")
	})

	it("passes the diff itself through untouched", () => {
		render(<BatchDiffApproval files={[file("a.ts", { content: "@@ -1 +1 @@" })]} ts={1} />)

		expect(screen.getByTestId("accordion-a.ts")).toHaveTextContent("@@ -1 +1 @@")
	})

	it("renders an empty diff rather than nothing when the backend sent no content", () => {
		render(<BatchDiffApproval files={[file("a.ts", { content: undefined })]} ts={1} />)

		expect(screen.getByTestId("accordion-a.ts")).toBeInTheDocument()
		expect(screen.getByTestId("accordion-a.ts").textContent).toBe("")
	})

	it("forwards the stats the backend computed", () => {
		render(
			<BatchDiffApproval files={[file("a.ts", { diffStats: { added: 3, removed: 1 } }), file("b.ts")]} ts={1} />,
		)

		expect(screen.getByTestId("accordion-a.ts")).toHaveAttribute("data-stats", "3/1")
		expect(screen.getByTestId("accordion-b.ts")).toHaveAttribute("data-stats", "none")
	})
})
