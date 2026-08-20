import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import MarkdownBlock, { markdownComponents } from "../MarkdownBlock"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ theme: "dark" }),
}))

vi.mock("../CodeBlock", () => ({
	default: ({ source, language }: { source: string; language: string }) => (
		<div data-testid="code-block" data-language={language}>
			{source}
		</div>
	),
}))

describe("MarkdownBlock — tables", () => {
	it("wraps tables so wide ones can scroll instead of stretching the chat", async () => {
		const markdown = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n")

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		await screen.findByRole("table")
		expect(container.querySelector(".table-wrapper > table")).toBeInTheDocument()
	})
})

describe("MarkdownBlock — links", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const clickLink = async (markdown: string) => {
		render(<MarkdownBlock markdown={markdown} />)
		const link = await screen.findByRole("link")
		fireEvent.click(link)
		return link
	}

	it("leaves external links to the webview to open", async () => {
		await clickLink("[docs](https://example.com/page)")

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("opens an absolute path link in the editor", async () => {
		await clickLink("[file](/work/src/a.ts)")

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "/work/src/a.ts",
			values: undefined,
		})
	})

	it("jumps to the line a link names", async () => {
		await clickLink("[file](/work/src/a.ts:42)")

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "/work/src/a.ts",
			values: { line: 42 },
		})
	})

	it("uses the start of a line range", async () => {
		await clickLink("[file](/work/src/a.ts:10-20)")

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "/work/src/a.ts",
			values: { line: 10 },
		})
	})

	it("makes a bare relative path explicitly relative", async () => {
		await clickLink("[file](src/a.ts)")

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openFile", text: "./src/a.ts", values: undefined })
	})

	it("leaves an already-relative path alone", async () => {
		await clickLink("[file](./src/a.ts)")

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openFile", text: "./src/a.ts", values: undefined })
	})

	it("stops the browser from following a local link", async () => {
		render(<MarkdownBlock markdown="[file](./src/a.ts)" />)
		const link = await screen.findByRole("link")

		const event = new MouseEvent("click", { bubbles: true, cancelable: true })
		fireEvent(link, event)

		expect(event.defaultPrevented).toBe(true)
	})

	it("does not interfere with an external link's default behaviour", async () => {
		render(<MarkdownBlock markdown="[docs](https://example.com)" />)
		const link = await screen.findByRole("link")

		const event = new MouseEvent("click", { bubbles: true, cancelable: true })
		fireEvent(link, event)

		expect(event.defaultPrevented).toBe(false)
	})
})

describe("MarkdownBlock — code", () => {
	it("renders a fenced block with its language", async () => {
		const markdown = ["```ts", "const a = 1", "const b = 2", "```"].join("\n")

		render(<MarkdownBlock markdown={markdown} />)

		const block = await screen.findByTestId("code-block")
		expect(block).toHaveAttribute("data-language", "ts")
		expect(block.textContent).toBe("const a = 1\nconst b = 2\n")
	})

	it("labels a fence with no language as plain text", async () => {
		const markdown = ["```", "plain", "```"].join("\n")

		render(<MarkdownBlock markdown={markdown} />)

		expect(await screen.findByTestId("code-block")).toHaveAttribute("data-language", "text")
	})

	it("reduces a filename fence to its extension", async () => {
		const markdown = ["```src.utils.ts", "const a = 1", "```"].join("\n")

		render(<MarkdownBlock markdown={markdown} />)

		expect(await screen.findByTestId("code-block")).toHaveAttribute("data-language", "ts")
	})

	it("keeps inline code inline instead of promoting it to a block", async () => {
		render(<MarkdownBlock markdown="use `npm run test` here" />)

		const code = await screen.findByText("npm run test")
		expect(code.tagName).toBe("CODE")
		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
	})

	it("renders nothing for empty markdown", () => {
		const { container } = render(<MarkdownBlock markdown="" />)

		expect(container.querySelector("p")).not.toBeInTheDocument()
	})

	it("renders nothing when markdown is missing entirely", () => {
		const { container } = render(<MarkdownBlock markdown={undefined as unknown as string} />)

		expect(container.querySelector("p")).not.toBeInTheDocument()
	})
})

describe("markdownComponents.pre — shapes react-markdown can hand it", () => {
	const Pre = markdownComponents.pre

	it("joins the string parts of a multi-part code child", () => {
		const codeElement = {
			props: { className: "language-ts", children: ["const a = 1\n", { type: "span" }, "const b = 2\n"] },
		}

		render(<Pre>{codeElement}</Pre>)

		expect(screen.getByTestId("code-block").textContent).toBe("const a = 1\nconst b = 2\n")
		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "ts")
	})

	it("falls back to plain text when the class name carries no language", () => {
		render(<Pre>{{ props: { children: "plain" } }}</Pre>)

		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "text")
	})

	it("renders whatever it was given when there is no code element inside", () => {
		const { container } = render(<Pre>{"just text"}</Pre>)

		expect(container.querySelector("pre")).toHaveTextContent("just text")
		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
	})

	it("renders a bare pre when there is no child at all", () => {
		const { container } = render(<Pre>{null}</Pre>)

		expect(container.querySelector("pre")).toBeInTheDocument()
		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
	})

	it("produces an empty block for code children of an unexpected type", () => {
		render(<Pre>{{ props: { className: "language-ts", children: 42 } }}</Pre>)

		expect(screen.getByTestId("code-block").textContent).toBe("")
	})
})
