import { render, screen, fireEvent } from "@/utils/test-utils"

import CodeAccordion from "../CodeAccordion"

vi.mock("../CodeBlock", () => ({
	default: ({ source, language }: { source: string; language: string }) => (
		<div data-testid="code-block" data-language={language}>
			{source}
		</div>
	),
}))

vi.mock("../DiffView", () => ({
	default: ({ source, filePath }: { source: string; filePath?: string }) => (
		<div data-testid="diff-view" data-file-path={filePath}>
			{source}
		</div>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeProgressRing: () => <div data-testid="progress-ring" />,
}))

describe("CodeAccordion", () => {
	const base = {
		language: "typescript",
		isExpanded: false,
		onToggleExpand: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows the code without a header when there is nothing to label it with", () => {
		render(<CodeAccordion {...base} code="const a = 1" />)

		expect(screen.getByTestId("code-block")).toHaveTextContent("const a = 1")
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})

	it("hides the code behind the header until it is expanded", () => {
		const { rerender } = render(<CodeAccordion {...base} path="src/a.ts" code="const a = 1" />)

		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()

		rerender(<CodeAccordion {...base} path="src/a.ts" code="const a = 1" isExpanded />)

		expect(screen.getByTestId("code-block")).toBeInTheDocument()
	})

	it("toggles when the header is clicked", () => {
		const onToggleExpand = vi.fn()
		render(<CodeAccordion {...base} onToggleExpand={onToggleExpand} path="src/a.ts" />)

		fireEvent.click(screen.getByText(/a\.ts/))

		expect(onToggleExpand).toHaveBeenCalledTimes(1)
	})

	it("trims the code before handing it over", () => {
		render(<CodeAccordion {...base} code={"\n\n  const a = 1  \n\n"} />)

		expect(screen.getByTestId("code-block").textContent).toBe("const a = 1")
	})

	it("renders diffs with the diff view instead of the code block", () => {
		render(<CodeAccordion {...base} language="diff" path="src/a.ts" isExpanded code="@@ -1 +1 @@" />)

		expect(screen.getByTestId("diff-view")).toHaveAttribute("data-file-path", "src/a.ts")
		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
	})

	it("shows a spinner while the tool is still running", () => {
		render(<CodeAccordion {...base} path="src/a.ts" isLoading />)

		expect(screen.getByTestId("progress-ring")).toBeInTheDocument()
	})

	it("shows no spinner once the tool has finished", () => {
		render(<CodeAccordion {...base} path="src/a.ts" />)

		expect(screen.queryByTestId("progress-ring")).not.toBeInTheDocument()
	})

	it("prefers an explicit header over the path", () => {
		const { container } = render(<CodeAccordion {...base} path="src/a.ts" header="my-server" />)

		expect(screen.getByText("my-server")).toBeInTheDocument()
		expect(container.querySelector(".codicon-server")).toBeInTheDocument()
		expect(screen.queryByText(/a\.ts/)).not.toBeInTheDocument()
	})

	it("labels feedback blocks as user edits", () => {
		const { container } = render(<CodeAccordion {...base} isFeedback />)

		expect(screen.getByText("User Edits")).toBeInTheDocument()
		expect(container.querySelector(".codicon-feedback")).toBeInTheDocument()
	})

	it("keeps the leading dot of a dotfile path visible", () => {
		render(<CodeAccordion {...base} path=".env.local" />)

		expect(screen.getByText(".")).toBeInTheDocument()
	})

	it("shows diff stats when there are any", () => {
		render(<CodeAccordion {...base} path="src/a.ts" diffStats={{ added: 3, removed: 2 }} />)

		expect(screen.getByText("+3")).toBeInTheDocument()
		expect(screen.getByText("-2")).toBeInTheDocument()
	})

	it("prefers diff stats over the progress text", () => {
		render(
			<CodeAccordion
				{...base}
				path="src/a.ts"
				diffStats={{ added: 1, removed: 0 }}
				progressStatus={{ text: "Applying...", icon: "sync" }}
			/>,
		)

		expect(screen.getByText("+1")).toBeInTheDocument()
		expect(screen.queryByText("Applying...")).not.toBeInTheDocument()
	})

	it("ignores empty diff stats and falls back to the progress text", () => {
		const { container } = render(
			<CodeAccordion
				{...base}
				path="src/a.ts"
				diffStats={{ added: 0, removed: 0 }}
				progressStatus={{ text: "Applying...", icon: "sync" }}
			/>,
		)

		expect(screen.getByText("Applying...")).toBeInTheDocument()
		expect(container.querySelector(".codicon-sync")).toBeInTheDocument()
	})

	it("shows progress text without an icon when none was given", () => {
		const { container } = render(
			<CodeAccordion {...base} path="src/a.ts" progressStatus={{ text: "Applying..." }} />,
		)

		expect(screen.getByText("Applying...")).toBeInTheDocument()
		expect(container.querySelector(".codicon-sync")).not.toBeInTheDocument()
	})

	it("shows nothing for a progress status with no text", () => {
		render(<CodeAccordion {...base} path="src/a.ts" progressStatus={{ icon: "sync" } as any} />)

		expect(screen.queryByText("Applying...")).not.toBeInTheDocument()
	})

	it("offers a jump-to-file affordance that does not also toggle the accordion", () => {
		const onJumpToFile = vi.fn()
		const onToggleExpand = vi.fn()
		render(<CodeAccordion {...base} path="src/a.ts" onJumpToFile={onJumpToFile} onToggleExpand={onToggleExpand} />)

		fireEvent.click(screen.getByLabelText("Open file: src/a.ts"))

		expect(onJumpToFile).toHaveBeenCalledTimes(1)
		expect(onToggleExpand).not.toHaveBeenCalled()
	})

	it("shows a chevron that follows the expanded state when there is no jump target", () => {
		const { container, rerender } = render(<CodeAccordion {...base} path="src/a.ts" />)

		expect(container.querySelector(".codicon-chevron-down")).toBeInTheDocument()

		rerender(<CodeAccordion {...base} path="src/a.ts" isExpanded />)

		expect(container.querySelector(".codicon-chevron-up")).toBeInTheDocument()
	})

	it("shows no chevron when a jump target replaces it", () => {
		const { container } = render(<CodeAccordion {...base} path="src/a.ts" onJumpToFile={vi.fn()} />)

		expect(container.querySelector("[class*='codicon-chevron']")).not.toBeInTheDocument()
	})

	it("keeps the jump affordance hidden without a path to jump to", () => {
		render(<CodeAccordion {...base} isFeedback onJumpToFile={vi.fn()} />)

		expect(screen.queryByLabelText(/Open file/)).not.toBeInTheDocument()
	})

	it("renders an empty block when no code was supplied at all", () => {
		render(<CodeAccordion {...base} />)

		expect(screen.getByTestId("code-block").textContent).toBe("")
	})
})

describe("CodeAccordion — language inference", () => {
	const base = {
		isExpanded: true,
		onToggleExpand: vi.fn(),
	}

	it("infers the language from the path when none was given", () => {
		render(<CodeAccordion {...base} language={undefined as unknown as string} path="src/a.ts" code="x" />)

		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "typescript")
	})

	it("falls back to plain text when there is neither language nor path", () => {
		render(<CodeAccordion {...base} language={undefined as unknown as string} code="x" />)

		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "txt")
	})
})
