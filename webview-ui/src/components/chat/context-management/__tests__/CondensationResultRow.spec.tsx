import { render, screen, fireEvent } from "@/utils/test-utils"

import { CondensationResultRow } from "../CondensationResultRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("../../Markdown", () => ({
	Markdown: ({ markdown }: { markdown: string }) => <div data-testid="summary">{markdown}</div>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeBadge: ({ children, className }: any) => (
		<span data-testid="cost-badge" className={className}>
			{children}
		</span>
	),
}))

const fullData = {
	cost: 0.05,
	prevContextTokens: 1000,
	newContextTokens: 400,
	summary: "condensed summary",
} as any

describe("CondensationResultRow", () => {
	it("renders the token reduction and a visible cost badge when cost > 0", () => {
		render(<CondensationResultRow data={fullData} />)
		expect(screen.getByText("chat:contextManagement.condensation.title")).toBeInTheDocument()
		expect(screen.getByText(/1,000 → 400/)).toBeInTheDocument()
		const badge = screen.getByTestId("cost-badge")
		expect(badge).toHaveTextContent("$0.05")
		expect(badge.className).toContain("opacity-100")
	})

	it("hides the cost badge (opacity-0) and defaults null tokens/cost to 0", () => {
		render(
			<CondensationResultRow
				data={{ cost: null, prevContextTokens: null, newContextTokens: null, summary: "s" } as any}
			/>,
		)
		expect(screen.getByText(/0 → 0/)).toBeInTheDocument()
		const badge = screen.getByTestId("cost-badge")
		expect(badge).toHaveTextContent("$0.00")
		expect(badge.className).toContain("opacity-0")
	})

	it("reveals the summary markdown only after expanding", () => {
		const { container } = render(<CondensationResultRow data={fullData} />)
		expect(screen.queryByTestId("summary")).not.toBeInTheDocument()

		const header = container.querySelector(".cursor-pointer") as HTMLElement
		fireEvent.click(header)
		expect(screen.getByTestId("summary")).toHaveTextContent("condensed summary")
		expect(container.querySelector(".codicon-chevron-up")).toBeInTheDocument()

		fireEvent.click(header)
		expect(screen.queryByTestId("summary")).not.toBeInTheDocument()
	})
})
