// npx vitest src/components/mcp/__tests__/McpErrorRow.spec.tsx

import { render, screen } from "@/utils/test-utils"

import type { McpErrorEntry } from "@openai-agent/types"

import { McpErrorRow } from "../McpErrorRow"

const makeError = (level: McpErrorEntry["level"], message = "boom"): McpErrorEntry => ({
	message,
	level,
	timestamp: Date.now(),
})

describe("McpErrorRow", () => {
	it("renders the error message", () => {
		render(<McpErrorRow error={makeError("error", "something failed")} />)
		expect(screen.getByText("something failed")).toBeInTheDocument()
	})

	it("uses the failed icon color for error level", () => {
		render(<McpErrorRow error={makeError("error")} />)
		const message = screen.getByText("boom")
		expect(message).toHaveStyle({ color: "var(--vscode-testing-iconFailed)" })
	})

	it("uses the yellow chart color for warn level", () => {
		render(<McpErrorRow error={makeError("warn")} />)
		const message = screen.getByText("boom")
		expect(message).toHaveStyle({ color: "var(--vscode-charts-yellow)" })
	})

	it("uses the passed icon color for info level", () => {
		render(<McpErrorRow error={makeError("info")} />)
		const message = screen.getByText("boom")
		expect(message).toHaveStyle({ color: "var(--vscode-testing-iconPassed)" })
	})

	it("renders a relative timestamp", () => {
		render(<McpErrorRow error={{ message: "boom", level: "info", timestamp: Date.now() }} />)
		// formatRelative renders "today at ..." for a current timestamp
		expect(screen.getByText(/today at/i)).toBeInTheDocument()
	})
})
