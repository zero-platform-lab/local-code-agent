import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { McpExecution } from "../McpExecution"

const messageHandlers = vi.hoisted(() => ({ current: [] as Array<(event: MessageEvent) => void> }))

vi.mock("react-use", () => ({
	useEvent: (name: string, handler: (event: MessageEvent) => void) => {
		if (name === "message") {
			messageHandlers.current = [handler]
		}
	},
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	initReactI18next: { type: "3rdParty", init: vi.fn() },
}))

vi.mock("../../common/CodeBlock", () => ({
	default: ({ source, language }: { source: string; language: string }) => (
		<div data-testid="code-block" data-language={language}>
			{source}
		</div>
	),
}))

vi.mock("../Markdown", () => ({
	Markdown: ({ markdown, partial }: { markdown: string; partial?: boolean }) => (
		<div data-testid="markdown" data-partial={String(!!partial)}>
			{markdown}
		</div>
	),
}))

vi.mock("../../mcp/McpToolRow", () => ({
	default: ({ tool, serverName, serverSource, alwaysAllowMcp }: any) => (
		<div
			data-testid="mcp-tool-row"
			data-tool={tool.name}
			data-description={tool.description}
			data-always-allow={String(tool.alwaysAllow)}
			data-server={serverName}
			data-source={serverSource ?? "none"}
			data-always-allow-mcp={String(alwaysAllowMcp)}
		/>
	),
}))

const sendStatus = (status: Record<string, unknown>) => {
	act(() => {
		for (const handler of messageHandlers.current) {
			handler({ data: { type: "mcpExecutionStatus", text: JSON.stringify(status) } } as MessageEvent)
		}
	})
}

const expandResponse = () => fireEvent.click(document.querySelector(".lucide-chevron-down")!.closest("button")!)

describe("McpExecution — status", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows nothing about status until the extension reports one", () => {
		render(<McpExecution executionId="exec-1" serverName="my-server" />)

		expect(screen.getByText("my-server")).toBeInTheDocument()
		expect(screen.queryByText("execution.running")).not.toBeInTheDocument()
	})

	it("reports a running, a finished and a failed execution", () => {
		const { container } = render(<McpExecution executionId="exec-1" serverName="my-server" />)

		sendStatus({ executionId: "exec-1", status: "started", serverName: "my-server", toolName: "t" })
		expect(screen.getByText("execution.running")).toBeInTheDocument()
		expect(container.querySelector(".bg-lime-400")).toBeInTheDocument()

		sendStatus({ executionId: "exec-1", status: "completed", response: "done" })
		expect(screen.getByText("execution.completed")).toBeInTheDocument()

		sendStatus({ executionId: "exec-1", status: "error", error: "it broke" })
		expect(screen.getByText("execution.error")).toBeInTheDocument()
		expect(screen.getByText("(it broke)")).toBeInTheDocument()
		expect(container.querySelector(".bg-red-400")).toBeInTheDocument()
	})

	it("shows a failure without a reason too", () => {
		render(<McpExecution executionId="exec-1" serverName="my-server" />)

		sendStatus({ executionId: "exec-1", status: "error" })

		expect(screen.getByText("execution.error")).toBeInTheDocument()
	})

	it("appends streamed output and replaces it when the run completes", () => {
		render(<McpExecution executionId="exec-1" serverName="my-server" />)

		sendStatus({ executionId: "exec-1", status: "output", response: "first " })
		sendStatus({ executionId: "exec-1", status: "output", response: "second" })
		expandResponse()
		expect(screen.getByTestId("markdown")).toHaveTextContent("first second")

		sendStatus({ executionId: "exec-1", status: "completed", response: "final" })
		expect(screen.getByTestId("markdown")).toHaveTextContent("final")
	})

	it("ignores output that has no text and status for other executions", () => {
		render(<McpExecution executionId="exec-1" serverName="my-server" text="original" />)

		sendStatus({ executionId: "exec-1", status: "output" })
		sendStatus({ executionId: "other", status: "completed", response: "not mine" })

		expandResponse()
		expect(screen.getByTestId("markdown")).toHaveTextContent("original")
	})

	it("ignores a status payload it cannot understand", () => {
		render(<McpExecution executionId="exec-1" serverName="my-server" />)

		act(() => {
			for (const handler of messageHandlers.current) {
				handler({ data: { type: "mcpExecutionStatus", text: "not json" } } as MessageEvent)
			}
		})

		expect(screen.queryByText("execution.running")).not.toBeInTheDocument()
	})

	it("ignores messages that are not MCP status updates", () => {
		render(<McpExecution executionId="exec-1" serverName="my-server" />)

		act(() => {
			for (const handler of messageHandlers.current) {
				handler({ data: { type: "somethingElse" } } as MessageEvent)
			}
		})

		expect(screen.queryByText("execution.running")).not.toBeInTheDocument()
	})
})

describe("McpExecution — the response body", () => {
	it("stays collapsed until asked", () => {
		render(<McpExecution executionId="exec-1" serverName="s" text="some response" />)

		expect(screen.queryByTestId("markdown")).not.toBeInTheDocument()

		expandResponse()

		expect(screen.getByTestId("markdown")).toBeInTheDocument()
	})

	it("offers no expander when there is nothing to show", () => {
		render(<McpExecution executionId="exec-1" serverName="s" />)

		expect(document.querySelector(".lucide-chevron-down")).not.toBeInTheDocument()
	})

	it("pretty-prints a finished JSON response", () => {
		render(<McpExecution executionId="exec-1" serverName="s" />)
		sendStatus({ executionId: "exec-1", status: "completed", response: '{"a":1}' })

		expandResponse()

		expect(screen.getByTestId("code-block")).toHaveTextContent('{ "a": 1 }')
		expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "json")
	})

	it("leaves an unfinished response alone rather than parsing half of it", () => {
		render(<McpExecution executionId="exec-1" serverName="s" />)
		sendStatus({ executionId: "exec-1", status: "output", response: '{"a":' })

		expandResponse()

		expect(screen.getByTestId("markdown")).toHaveTextContent('{"a":')
		expect(screen.getByTestId("markdown")).toHaveAttribute("data-partial", "true")
	})

	it("renders a finished non-JSON response as markdown", () => {
		render(<McpExecution executionId="exec-1" serverName="s" />)
		sendStatus({ executionId: "exec-1", status: "completed", response: "plain **text**" })

		expandResponse()

		expect(screen.getByTestId("markdown")).toHaveAttribute("data-partial", "false")
	})

	it("takes the response from the ask message when there is one", () => {
		render(
			<McpExecution
				executionId="exec-1"
				serverName="s"
				useMcpServer={{ type: "use_mcp_tool", serverName: "s", toolName: "t", response: "from ask" } as never}
			/>,
		)

		expandResponse()

		expect(screen.getByTestId("markdown")).toHaveTextContent("from ask")
	})
})

describe("McpExecution — arguments and the tool row", () => {
	it("pretty-prints complete JSON arguments", () => {
		render(<McpExecution executionId="exec-1" serverName="s" text='{"path":"a.ts"}' isArguments />)

		expect(screen.getByTestId("code-block")).toHaveTextContent('{ "path": "a.ts" }')
	})

	it("leaves incomplete JSON arguments as they are", () => {
		render(<McpExecution executionId="exec-1" serverName="s" text='{"path":' isArguments />)

		expect(screen.getByTestId("code-block")).toHaveTextContent('{"path":')
	})

	it("leaves broken JSON arguments as they are", () => {
		render(<McpExecution executionId="exec-1" serverName="s" text='{"path": oops}' isArguments />)

		expect(screen.getByTestId("code-block")).toHaveTextContent('{"path": oops}')
	})

	it("handles a JSON array of arguments", () => {
		render(<McpExecution executionId="exec-1" serverName="s" text="[1,2]" isArguments />)

		expect(screen.getByTestId("code-block")).toHaveTextContent("[ 1, 2 ]")
	})

	it("shows plain-text arguments unchanged", () => {
		render(<McpExecution executionId="exec-1" serverName="s" text="just text" isArguments />)

		expect(screen.getByTestId("code-block")).toHaveTextContent("just text")
	})

	it("shows no arguments block when there are none", () => {
		render(<McpExecution executionId="exec-1" serverName="s" />)

		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
	})

	it("describes the tool from the server's own list", () => {
		render(
			<McpExecution
				executionId="exec-1"
				useMcpServer={{ type: "use_mcp_tool", serverName: "s", toolName: "read_file" } as never}
				server={{ tools: [{ name: "read_file", description: "Reads", alwaysAllow: true }], source: "project" }}
				alwaysAllowMcp
			/>,
		)

		const row = screen.getByTestId("mcp-tool-row")
		expect(row).toHaveAttribute("data-tool", "read_file")
		expect(row).toHaveAttribute("data-description", "Reads")
		expect(row).toHaveAttribute("data-always-allow", "true")
		expect(row).toHaveAttribute("data-source", "project")
		expect(row).toHaveAttribute("data-always-allow-mcp", "true")
	})

	it("falls back to an empty description for a tool the server does not list", () => {
		render(
			<McpExecution
				executionId="exec-1"
				useMcpServer={{ type: "use_mcp_tool", serverName: "s", toolName: "unknown" } as never}
				server={{ tools: [] }}
			/>,
		)

		const row = screen.getByTestId("mcp-tool-row")
		expect(row).toHaveAttribute("data-description", "")
		expect(row).toHaveAttribute("data-always-allow", "false")
		expect(row).toHaveAttribute("data-source", "none")
	})

	it("shows a tool row from the plain server and tool names when there is no ask message", () => {
		render(<McpExecution executionId="exec-1" serverName="s" toolName="t" />)

		expect(screen.getByTestId("mcp-tool-row")).toHaveAttribute("data-tool", "t")
	})

	it("shows no tool row for a resource access", () => {
		render(
			<McpExecution
				executionId="exec-1"
				useMcpServer={{ type: "access_mcp_resource", serverName: "s", uri: "res://x" } as never}
			/>,
		)

		expect(screen.queryByTestId("mcp-tool-row")).not.toBeInTheDocument()
	})

	it("keeps clicks on the tool row from reaching the message behind it", () => {
		const onClick = vi.fn()
		render(
			<div onClick={onClick}>
				<McpExecution executionId="exec-1" serverName="s" toolName="t" />
			</div>,
		)

		fireEvent.click(screen.getByTestId("mcp-tool-row"))

		expect(onClick).not.toHaveBeenCalled()
	})

	it("picks up a server and tool name that arrive later", () => {
		const { rerender } = render(<McpExecution executionId="exec-1" />)

		rerender(<McpExecution executionId="exec-1" serverName="later-server" toolName="later-tool" />)

		expect(screen.getByText("later-server")).toBeInTheDocument()
		expect(screen.getByTestId("mcp-tool-row")).toHaveAttribute("data-tool", "later-tool")
	})
	it("keeps clicks on the tool row of an ask message from reaching the message behind it", () => {
		const onClick = vi.fn()
		render(
			<div onClick={onClick}>
				<McpExecution
					executionId="exec-1"
					useMcpServer={{ type: "use_mcp_tool", serverName: "s", toolName: "t" } as never}
				/>
			</div>,
		)

		fireEvent.click(screen.getByTestId("mcp-tool-row"))

		expect(onClick).not.toHaveBeenCalled()
	})

	it("describes a tool the server lists without a description", () => {
		render(
			<McpExecution
				executionId="exec-1"
				useMcpServer={{ type: "use_mcp_tool", serverName: "s", toolName: "read_file" } as never}
				server={{ tools: [{ name: "read_file" }] }}
			/>,
		)

		expect(screen.getByTestId("mcp-tool-row")).toHaveAttribute("data-description", "")
	})

	it("separates the arguments from the tool row above them", () => {
		const { container } = render(
			<McpExecution
				executionId="exec-1"
				useMcpServer={{ type: "use_mcp_tool", serverName: "s", toolName: "t", arguments: "{}" } as never}
				text='{"a":1}'
			/>,
		)

		expect(container.querySelector(".mt-1.pt-1")).toBeInTheDocument()
	})

	it("does not separate arguments that are the whole message", () => {
		const { container } = render(<McpExecution executionId="exec-1" serverName="s" text='{"a":1}' isArguments />)

		expect(container.querySelector(".mt-1.pt-1")).not.toBeInTheDocument()
	})

	it("survives a status message with no payload at all", () => {
		render(<McpExecution executionId="exec-1" serverName="s" />)

		act(() => {
			for (const handler of messageHandlers.current) {
				handler({ data: { type: "mcpExecutionStatus" } } as MessageEvent)
			}
		})

		expect(screen.queryByText("execution.running")).not.toBeInTheDocument()
	})
	it("renders a tool row even when the ask message names no tool", () => {
		render(<McpExecution executionId="exec-1" useMcpServer={{ type: "use_mcp_tool", serverName: "s" } as never} />)

		expect(screen.getByTestId("mcp-tool-row")).toHaveAttribute("data-tool", "")
	})

	it("separates the arguments from a plain tool row above them", () => {
		const { container } = render(<McpExecution executionId="exec-1" serverName="s" toolName="t" text='{"a":1}' />)

		expect(container.querySelector(".mt-1.pt-1")).toBeInTheDocument()
	})
})
