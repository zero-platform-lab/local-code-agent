import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import { Mention } from "../Mention"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

describe("Mention", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns the raw text (empty fragment) when text is undefined", () => {
		const { container } = render(<Mention />)
		// 何もレンダリングされない（空フラグメント）
		expect(container.textContent).toBe("")
	})

	it("renders plain text unchanged when there are no mentions", () => {
		render(<Mention text="hello world" />)
		expect(screen.getByText("hello world")).toBeInTheDocument()
	})

	it("renders a mention span and posts openMention on click", () => {
		render(<Mention text="see @problems now" />)
		const mention = screen.getByText("@problems")
		expect(mention).toBeInTheDocument()
		fireEvent.click(mention)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openMention", text: "problems" })
	})

	it("uses the shadow highlight class when withShadow is true", () => {
		const { container } = render(<Mention text="@problems" withShadow />)
		expect(container.querySelector(".mention-context-highlight-with-shadow")).toBeInTheDocument()
		expect(container.querySelector(".mention-context-highlight")).not.toBeInTheDocument()
	})

	it("uses the plain highlight class when withShadow is false (default)", () => {
		const { container } = render(<Mention text="@problems" />)
		expect(container.querySelector(".mention-context-highlight")).toBeInTheDocument()
		expect(container.querySelector(".mention-context-highlight-with-shadow")).not.toBeInTheDocument()
	})
})
