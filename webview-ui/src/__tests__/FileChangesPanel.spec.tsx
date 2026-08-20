import React from "react"
import { fireEvent, render, screen } from "@/utils/test-utils"
import type { ClineMessage } from "@openai-agent/types"
import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"
import FileChangesPanel from "../components/chat/FileChangesPanel"

const mockPostMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
	},
}))

// Mock i18n to return readable header with count
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: { count?: number }) => {
			if (key === "chat:fileChangesInConversation.header" && opts?.count != null) {
				return `${opts.count} file(s) changed in this conversation`
			}
			return key
		},
	}),
}))

// Lightweight mock so we don't pull in CodeBlock/DiffView
vi.mock("@src/components/common/CodeAccordion", () => ({
	default: ({
		path,
		code,
		isExpanded,
		onToggleExpand,
		onJumpToFile,
		diffStats,
	}: {
		path?: string
		code?: string
		isExpanded: boolean
		onToggleExpand: () => void
		onJumpToFile?: () => void
		diffStats?: { added: number; removed: number }
	}) => (
		<div data-testid="code-accordian" data-stats={diffStats ? `${diffStats.added}/${diffStats.removed}` : "none"}>
			<span data-testid="accordian-path">{path}</span>
			<pre data-testid="accordian-code">{code}</pre>
			<button type="button" onClick={onToggleExpand} data-testid="accordian-toggle">
				{isExpanded ? "expanded" : "collapsed"}
			</button>
			{onJumpToFile ? <button type="button" data-testid="accordian-jump" onClick={onJumpToFile} /> : null}
		</div>
	),
}))

function createFileEditMessage(
	path: string,
	diff: string,
	diffStats?: { added: number; removed: number },
	originalContent?: string,
): ClineMessage {
	return {
		type: "ask",
		ask: "tool",
		ts: Date.now(),
		partial: false,
		isAnswered: true,
		text: JSON.stringify({
			tool: "appliedDiff",
			path,
			diff,
			...(diffStats && { diffStats }),
			...(originalContent !== undefined && { originalContent }),
		}),
	}
}

function renderPanel(messages: ClineMessage[] | undefined) {
	return render(
		<TranslationProvider>
			<FileChangesPanel clineMessages={messages} />
		</TranslationProvider>,
	)
}

describe("FileChangesPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders nothing when clineMessages is undefined", () => {
		const { container } = renderPanel(undefined)
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when clineMessages is empty", () => {
		const { container } = renderPanel([])
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when there are no file-edit messages", () => {
		const messages: ClineMessage[] = [
			{
				type: "say",
				say: "text",
				ts: Date.now(),
				partial: false,
				text: "hello",
			},
			{
				type: "ask",
				ask: "tool",
				ts: Date.now(),
				partial: false,
				text: JSON.stringify({ tool: "read_file", path: "x.ts" }),
			},
		]
		const { container } = renderPanel(messages)
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when file-edit ask tool is not approved (isAnswered false or missing)", () => {
		const messages: ClineMessage[] = [
			{
				type: "ask",
				ask: "tool",
				ts: Date.now(),
				partial: false,
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "src/foo.ts",
					diff: "+line",
				}),
			},
		]
		const { container } = renderPanel(messages)
		expect(container.firstChild).toBeNull()
	})

	it("renders panel with header when there is one file edit", () => {
		const messages = [createFileEditMessage("src/foo.ts", "@@ -1 +1 @@\n+line")]
		renderPanel(messages)

		expect(screen.getByText("1 file(s) changed in this conversation")).toBeInTheDocument()
		// Expand panel so file row is in DOM (CollapsibleContent may not render when closed in some setups)
		fireEvent.click(screen.getByText("1 file(s) changed in this conversation").closest("button")!)
		expect(screen.getByTestId("accordian-path")).toHaveTextContent("src/foo.ts")
	})

	it("renders one row per unique path when multiple files edited", () => {
		const messages = [createFileEditMessage("src/a.ts", "diff a"), createFileEditMessage("src/b.ts", "diff b")]
		renderPanel(messages)

		expect(screen.getByText("2 file(s) changed in this conversation")).toBeInTheDocument()
		// Expand panel so file rows are rendered
		fireEvent.click(screen.getByText("2 file(s) changed in this conversation").closest("button")!)
		const paths = screen.getAllByTestId("accordian-path")
		expect(paths).toHaveLength(2)
		expect(paths.map((el) => el.textContent)).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]))
	})

	it("collapsed by default: panel trigger shows chevron and expanding reveals file rows", () => {
		const messages = [createFileEditMessage("src/foo.ts", "diff")]
		renderPanel(messages)

		// Header visible
		const headerText = screen.getByText("1 file(s) changed in this conversation")
		expect(headerText).toBeInTheDocument()
		// Trigger is the button that contains the header text
		const trigger = headerText.closest("button")
		expect(trigger).toBeInTheDocument()

		// Expand panel
		fireEvent.click(trigger!)
		expect(screen.getByTestId("accordian-path")).toHaveTextContent("src/foo.ts")
	})

	it("toggling a file row expand calls onToggleExpand", () => {
		const messages = [createFileEditMessage("src/foo.ts", "diff")]
		renderPanel(messages)

		// Expand panel first so the file row is rendered
		const headerText = screen.getByText("1 file(s) changed in this conversation")
		fireEvent.click(headerText.closest("button")!)

		const accordianToggle = screen.getByTestId("accordian-toggle")
		expect(accordianToggle).toHaveTextContent("collapsed")
		fireEvent.click(accordianToggle)
		expect(accordianToggle).toHaveTextContent("expanded")
	})

	it("hides aggregate stats when no diffStats are present", () => {
		const messages = [createFileEditMessage("src/a.ts", "diff a"), createFileEditMessage("src/b.ts", "diff b")]
		renderPanel(messages)

		expect(screen.queryByTestId("total-added")).not.toBeInTheDocument()
		expect(screen.queryByTestId("total-removed")).not.toBeInTheDocument()
	})

	it("shows aggregated + and - totals in the header when diffStats are present", () => {
		const messages = [
			createFileEditMessage("src/a.ts", "diff a", { added: 3, removed: 1 }),
			createFileEditMessage("src/b.ts", "diff b", { added: 2, removed: 5 }),
		]
		renderPanel(messages)

		expect(screen.getByTestId("total-added")).toHaveTextContent("+5")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-6")
	})
	const expandPanelAndRow = () => {
		fireEvent.click(screen.getByText(/file\(s\) changed/))
		fireEvent.click(screen.getByTestId("accordian-toggle"))
	}

	const sendFileContent = (path: string, content: string | null) => {
		fireEvent(
			window,
			new MessageEvent("message", { data: { type: "fileContent", fileContent: { path, content } } }),
		)
	}

	it("asks for the file's current content when a row with a known original is opened", () => {
		renderPanel([createFileEditMessage("./src/a.ts", "@@ -1 +1 @@", undefined, "old\n")])

		expandPanelAndRow()

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "readFileContent", text: "src/a.ts" })
	})

	it("asks only once, however often the row is toggled", () => {
		renderPanel([createFileEditMessage("src/a.ts", "@@ -1 +1 @@", undefined, "old\n")])

		expandPanelAndRow()
		fireEvent.click(screen.getByTestId("accordian-toggle"))
		fireEvent.click(screen.getByTestId("accordian-toggle"))

		expect(mockPostMessage.mock.calls.filter((call) => call[0].type === "readFileContent")).toHaveLength(1)
	})

	it("asks for nothing when the edit carries no original content", () => {
		renderPanel([createFileEditMessage("src/a.ts", "@@ -1 +1 @@")])

		expandPanelAndRow()

		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "readFileContent" }))
	})

	it("shows the whole-file diff once the current content arrives", () => {
		renderPanel([createFileEditMessage("src/a.ts", "partial hunk", undefined, "line one\n")])
		expandPanelAndRow()

		sendFileContent("src/a.ts", "line two\n")

		const code = screen.getByTestId("accordian-code").textContent ?? ""
		expect(code).toContain("-line one")
		expect(code).toContain("+line two")
	})

	it("keeps the recorded hunks when the file could not be read back", () => {
		renderPanel([createFileEditMessage("src/a.ts", "partial hunk", undefined, "line one\n")])
		expandPanelAndRow()

		sendFileContent("src/a.ts", null)

		expect(screen.getByTestId("accordian-code")).toHaveTextContent("partial hunk")
	})

	it("keeps the recorded hunks when the file came back empty", () => {
		renderPanel([createFileEditMessage("src/a.ts", "partial hunk", undefined, "line one\n")])
		expandPanelAndRow()

		sendFileContent("src/a.ts", "")

		expect(screen.getByTestId("accordian-code")).toHaveTextContent("partial hunk")
	})

	it("ignores a file content message that names no file", () => {
		renderPanel([createFileEditMessage("src/a.ts", "partial hunk", undefined, "line one\n")])
		expandPanelAndRow()

		fireEvent(window, new MessageEvent("message", { data: { type: "fileContent", fileContent: { content: "x" } } }))

		expect(screen.getByTestId("accordian-code")).toHaveTextContent("partial hunk")
	})

	it("joins several edits to the same file", () => {
		renderPanel([
			createFileEditMessage("src/a.ts", "first hunk", { added: 1, removed: 0 }),
			createFileEditMessage("src/a.ts", "second hunk", { added: 2, removed: 3 }),
		])
		expandPanelAndRow()

		expect(screen.getByTestId("accordian-code").textContent).toContain("first hunk")
		expect(screen.getByTestId("accordian-code").textContent).toContain("second hunk")
		expect(screen.getByTestId("code-accordian")).toHaveAttribute("data-stats", "3/3")
	})

	it("shows no per-file stats when every edit reported none", () => {
		renderPanel([createFileEditMessage("src/a.ts", "hunk")])
		fireEvent.click(screen.getByText(/file\(s\) changed/))

		expect(screen.getByTestId("code-accordian")).toHaveAttribute("data-stats", "none")
	})

	it("opens the file in the editor from the row, always as a relative path", () => {
		renderPanel([createFileEditMessage("src/a.ts", "hunk")])
		fireEvent.click(screen.getByText(/file\(s\) changed/))

		fireEvent.click(screen.getByTestId("accordian-jump"))

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "openFile", text: "./src/a.ts" })
	})

	it("keeps an already relative path as it is", () => {
		renderPanel([createFileEditMessage("./src/a.ts", "hunk")])
		fireEvent.click(screen.getByText(/file\(s\) changed/))

		fireEvent.click(screen.getByTestId("accordian-jump"))

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "openFile", text: "./src/a.ts" })
	})
	it("forgets rows that the new conversation no longer has", () => {
		const { rerender } = renderPanel([createFileEditMessage("src/a.ts", "hunk", undefined, "old\n")])
		expandPanelAndRow()
		mockPostMessage.mockClear()

		rerender(
			<TranslationProvider>
				<FileChangesPanel clineMessages={[createFileEditMessage("src/b.ts", "other hunk")]} />
			</TranslationProvider>,
		)

		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "readFileContent" }))
		expect(screen.getByTestId("accordian-path")).toHaveTextContent("src/b.ts")
		expect(screen.getByTestId("accordian-toggle")).toHaveTextContent("collapsed")
	})
})
