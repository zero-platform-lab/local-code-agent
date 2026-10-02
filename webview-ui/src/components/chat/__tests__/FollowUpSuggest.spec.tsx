import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@radix-ui/react-tooltip"

import { FollowUpSuggest } from "../FollowUpSuggest"

vi.mock("@src/i18n/TranslationContext", () => ({
	TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
	useAppTranslation: () => ({
		t: (key: string) => (key === "chat:followUpSuggest.copyToInput" ? "Copy to input" : key),
	}),
}))

const renderWithProviders = (component: React.ReactElement) => render(<TooltipProvider>{component}</TooltipProvider>)

// 候補は押されたときだけ送る。待ち時間で自動的に選ぶ仕組み（カウントダウン）は持たない。
describe("FollowUpSuggest", () => {
	const mockSuggestions = [{ answer: "First suggestion" }, { answer: "Second suggestion" }]
	const mockOnSuggestionClick = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders every suggestion", () => {
		renderWithProviders(
			<FollowUpSuggest suggestions={mockSuggestions} onSuggestionClick={mockOnSuggestionClick} ts={1} />,
		)

		expect(screen.getByText("First suggestion")).toBeInTheDocument()
		expect(screen.getByText("Second suggestion")).toBeInTheDocument()
	})

	it("never chooses a suggestion on its own, however long it waits", () => {
		vi.useFakeTimers()
		try {
			renderWithProviders(
				<FollowUpSuggest suggestions={mockSuggestions} onSuggestionClick={mockOnSuggestionClick} ts={1} />,
			)

			vi.advanceTimersByTime(10 * 60 * 1000)

			expect(mockOnSuggestionClick).not.toHaveBeenCalled()
			expect(screen.queryByText(/Selecting in/)).not.toBeInTheDocument()
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not render when no suggestions are provided", () => {
		const { container } = renderWithProviders(
			<FollowUpSuggest suggestions={[]} onSuggestionClick={mockOnSuggestionClick} ts={1} />,
		)

		expect(container.firstChild).toBeNull()
	})

	it("does not render when onSuggestionClick is not provided", () => {
		const { container } = renderWithProviders(<FollowUpSuggest suggestions={mockSuggestions} ts={1} />)

		expect(container.firstChild).toBeNull()
	})

	it("hands the clicked suggestion to the parent", () => {
		renderWithProviders(
			<FollowUpSuggest suggestions={mockSuggestions} onSuggestionClick={mockOnSuggestionClick} ts={1} />,
		)

		fireEvent.click(screen.getByText("Second suggestion"))

		expect(mockOnSuggestionClick).toHaveBeenCalledTimes(1)
		expect(mockOnSuggestionClick.mock.calls[0][0]).toEqual({ answer: "Second suggestion" })
	})

	it("treats the copy-to-input control as a shift-click", () => {
		renderWithProviders(
			<FollowUpSuggest suggestions={mockSuggestions} onSuggestionClick={mockOnSuggestionClick} ts={1} />,
		)

		const copyIcon = document.querySelector(".lucide-clipboard-copy")!.parentElement!
		fireEvent.click(copyIcon)

		expect(mockOnSuggestionClick).toHaveBeenCalledTimes(1)
		expect(mockOnSuggestionClick.mock.calls[0][0]).toEqual({ answer: "First suggestion" })
		expect(mockOnSuggestionClick.mock.calls[0][1]).toMatchObject({ shiftKey: true })
	})

	it("shows which mode a suggestion would switch to", () => {
		renderWithProviders(
			<FollowUpSuggest
				suggestions={[{ answer: "Plan it", mode: "research" }, { answer: "No mode" }]}
				onSuggestionClick={mockOnSuggestionClick}
				ts={1}
			/>,
		)

		expect(screen.getByText("research")).toBeInTheDocument()
	})
})
