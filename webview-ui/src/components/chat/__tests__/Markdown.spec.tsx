import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"

import { Markdown } from "../Markdown"

const copyWithFeedback = vi.fn()

vi.mock("@src/components/common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div data-testid="markdown-block">{markdown}</div>,
}))

vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback }),
}))

vi.mock("@src/components/ui", () => ({
	StandardTooltip: ({ children }: any) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, className }: any) => (
		<button data-testid="copy-button" className={className} onClick={onClick}>
			{children}
		</button>
	),
}))

describe("Markdown", () => {
	beforeEach(() => {
		copyWithFeedback.mockReset()
		copyWithFeedback.mockResolvedValue(true)
	})

	it("returns null when markdown is undefined", () => {
		const { container } = render(<Markdown />)
		expect(container.firstChild).toBeNull()
	})

	it("returns null when markdown is an empty string", () => {
		const { container } = render(<Markdown markdown="" />)
		expect(container.firstChild).toBeNull()
	})

	it("renders the markdown block but no copy button until hovered", () => {
		render(<Markdown markdown="hello" />)
		expect(screen.getByTestId("markdown-block")).toHaveTextContent("hello")
		expect(screen.queryByTestId("copy-button")).not.toBeInTheDocument()
	})

	it("shows the copy button on hover and hides it again on leave", () => {
		const { container } = render(<Markdown markdown="hello" />)
		const wrapper = container.firstChild as HTMLElement
		fireEvent.mouseEnter(wrapper)
		expect(screen.getByTestId("copy-button")).toBeInTheDocument()
		fireEvent.mouseLeave(wrapper)
		expect(screen.queryByTestId("copy-button")).not.toBeInTheDocument()
	})

	it("does not show the copy button when partial is true even while hovering", () => {
		const { container } = render(<Markdown markdown="hello" partial />)
		fireEvent.mouseEnter(container.firstChild as HTMLElement)
		expect(screen.queryByTestId("copy-button")).not.toBeInTheDocument()
	})

	it("copies markdown and runs the highlight side-effect (success path)", async () => {
		const { container } = render(<Markdown markdown="hello" />)
		fireEvent.mouseEnter(container.firstChild as HTMLElement)
		fireEvent.click(screen.getByTestId("copy-button"))
		await waitFor(() => expect(copyWithFeedback).toHaveBeenCalledWith("hello"))
		// 成功後の背景ハイライトは setTimeout でリセットされる（コールバック本体まで到達させる）
		await new Promise((r) => setTimeout(r, 250))
	})

	it("skips the highlight side-effect when copy reports failure", async () => {
		copyWithFeedback.mockResolvedValue(false)
		const { container } = render(<Markdown markdown="hello" />)
		fireEvent.mouseEnter(container.firstChild as HTMLElement)
		fireEvent.click(screen.getByTestId("copy-button"))
		await waitFor(() => expect(copyWithFeedback).toHaveBeenCalledTimes(1))
	})
})
