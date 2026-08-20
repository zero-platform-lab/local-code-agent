import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { ReasoningBlock } from "../ReasoningBlock"

let mockCollapsed = false
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ reasoningBlockCollapsed: mockCollapsed }),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts && "count" in opts ? `${key}:${opts.count}` : key),
	}),
}))

vi.mock("@src/components/common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div data-testid="markdown-block">{markdown}</div>,
}))

describe("ReasoningBlock", () => {
	beforeEach(() => {
		mockCollapsed = false
	})

	it("shows the content when expanded and non-empty", () => {
		render(<ReasoningBlock content="my reasoning" ts={1} isStreaming={false} isLast={false} />)
		expect(screen.getByText("chat:reasoning.thinking")).toBeInTheDocument()
		expect(screen.getByTestId("markdown-block")).toHaveTextContent("my reasoning")
	})

	it("hides the content when collapsed by default preference", () => {
		mockCollapsed = true
		render(<ReasoningBlock content="my reasoning" ts={1} isStreaming={false} isLast={false} />)
		expect(screen.queryByTestId("markdown-block")).not.toBeInTheDocument()
	})

	it("does not render a markdown block for whitespace-only content", () => {
		render(<ReasoningBlock content="   " ts={1} isStreaming={false} isLast={false} />)
		expect(screen.queryByTestId("markdown-block")).not.toBeInTheDocument()
	})

	it("does not crash and renders no markdown block when content is missing", () => {
		// content が undefined でも optional chaining で安全に 0 扱いされる
		render(<ReasoningBlock content={undefined as any} ts={1} isStreaming={false} isLast={false} />)
		expect(screen.getByText("chat:reasoning.thinking")).toBeInTheDocument()
		expect(screen.queryByTestId("markdown-block")).not.toBeInTheDocument()
	})

	it("toggles collapse state when the header is clicked", () => {
		const { container } = render(
			<ReasoningBlock content="my reasoning" ts={1} isStreaming={false} isLast={false} />,
		)
		const header = container.querySelector(".cursor-pointer") as HTMLElement
		// 最初は展開 → クリックで折りたたみ
		fireEvent.click(header)
		expect(screen.queryByTestId("markdown-block")).not.toBeInTheDocument()
		// もう一度クリックで再展開
		fireEvent.click(header)
		expect(screen.getByTestId("markdown-block")).toBeInTheDocument()
	})

	it("ticks the elapsed timer while streaming as the last block", () => {
		vi.useFakeTimers()
		try {
			render(<ReasoningBlock content="x" ts={1} isStreaming={true} isLast={true} />)
			// 初期は elapsed=0 なので秒ラベルは非表示
			expect(screen.queryByText(/chat:reasoning\.seconds/)).not.toBeInTheDocument()
			act(() => {
				vi.advanceTimersByTime(1000)
			})
			expect(screen.getByText("chat:reasoning.seconds:1")).toBeInTheDocument()
		} finally {
			vi.useRealTimers()
		}
	})

	it("reacts to a change in the collapsed preference", () => {
		const { rerender } = render(<ReasoningBlock content="my reasoning" ts={1} isStreaming={false} isLast={false} />)
		expect(screen.getByTestId("markdown-block")).toBeInTheDocument()
		mockCollapsed = true
		rerender(<ReasoningBlock content="my reasoning" ts={2} isStreaming={false} isLast={false} />)
		expect(screen.queryByTestId("markdown-block")).not.toBeInTheDocument()
	})
})
