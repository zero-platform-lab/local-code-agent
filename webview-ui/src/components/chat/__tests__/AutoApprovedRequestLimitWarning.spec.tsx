import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import { AutoApprovedRequestLimitWarning } from "../AutoApprovedRequestLimitWarning"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) => (
		<span data-count={values?.count as number}>{i18nKey}</span>
	),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: any) => (
		<button data-testid="ack-button" onClick={onClick}>
			{children}
		</button>
	),
}))

const makeMessage = (text?: string) => ({ ts: 1, type: "say" as const, text }) as any

describe("AutoApprovedRequestLimitWarning", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the request-limit keys for the default 'requests' type", () => {
		render(<AutoApprovedRequestLimitWarning message={makeMessage(JSON.stringify({ count: 5 }))} />)
		expect(screen.getByText("ask.autoApprovedRequestLimitReached.title")).toBeInTheDocument()
		// count が Trans の description に渡っている
		expect(screen.getByText("ask.autoApprovedRequestLimitReached.description")).toHaveAttribute("data-count", "5")
	})

	it("renders the cost-limit keys when type is 'cost'", () => {
		render(<AutoApprovedRequestLimitWarning message={makeMessage(JSON.stringify({ count: 2, type: "cost" }))} />)
		expect(screen.getByText("ask.autoApprovedCostLimitReached.title")).toBeInTheDocument()
		expect(screen.getByText("ask.autoApprovedCostLimitReached.description")).toBeInTheDocument()
		expect(screen.getByText("ask.autoApprovedCostLimitReached.button")).toBeInTheDocument()
	})

	it("falls back to an empty object when text is undefined (no crash)", () => {
		render(<AutoApprovedRequestLimitWarning message={makeMessage(undefined)} />)
		expect(screen.getByText("ask.autoApprovedRequestLimitReached.title")).toBeInTheDocument()
	})

	it("posts yesButtonClicked and hides itself after the button is clicked", () => {
		const { container } = render(
			<AutoApprovedRequestLimitWarning message={makeMessage(JSON.stringify({ count: 1 }))} />,
		)
		fireEvent.click(screen.getByTestId("ack-button"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "askResponse", askResponse: "yesButtonClicked" })
		// buttonClicked=true で null を返す
		expect(container.querySelector("[data-testid='ack-button']")).not.toBeInTheDocument()
	})
})
