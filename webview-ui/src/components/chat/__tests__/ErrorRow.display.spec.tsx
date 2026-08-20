import { render, screen, fireEvent, act, waitFor } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { ErrorRow } from "../ErrorRow"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const selectedModel = vi.hoisted(() => ({ provider: "openai", id: "gpt-4" }))
const copyWithFeedback = vi.hoisted(() => vi.fn(async () => true))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ version: "1.2.3", apiConfiguration: {} }),
}))

vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => selectedModel,
}))

vi.mock("@/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback }),
}))

vi.mock("../../common/CodeBlock", () => ({
	default: ({ source }: { source: string }) => <div data-testid="code-block">{source}</div>,
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "code" in options ? `${key}${options.code}` : key,
	}),
	initReactI18next: { type: "3rdParty", init: vi.fn() },
}))

describe("ErrorRow — titles", () => {
	it.each([
		["error", "chat:error"],
		["mistake_limit", "chat:troubleMessage"],
		["api_failure", "chat:apiRequest.failed"],
		["streaming_failed", "chat:apiRequest.streamingFailed"],
		["cancelled", "chat:apiRequest.cancelled"],
		["diff_error", "chat:diffError.title"],
	])("labels a %s as %s", (type, expected) => {
		render(<ErrorRow type={type as never} message="boom" />)

		expect(screen.getByText(expected)).toBeInTheDocument()
	})

	it("puts the status code in the retry title when there is one", () => {
		const { rerender } = render(<ErrorRow type="api_req_retry_delayed" message="boom" code={429} />)
		expect(screen.getByText("chat:apiRequest.errorTitle · 429")).toBeInTheDocument()

		rerender(<ErrorRow type="api_req_retry_delayed" message="boom" />)
		expect(screen.getByText("chat:apiRequest.errorTitle")).toBeInTheDocument()
	})

	it("prefers a title it was handed", () => {
		render(<ErrorRow type="error" message="boom" title="Custom title" />)

		expect(screen.getByText("Custom title")).toBeInTheDocument()
		expect(screen.queryByText("chat:error")).not.toBeInTheDocument()
	})

	it("shows only the message for an unknown error kind", () => {
		render(<ErrorRow type={"something_else" as never} message="boom" />)

		expect(screen.getByText("boom")).toBeInTheDocument()
		expect(document.querySelector(".lucide-message-circle-warning")).not.toBeInTheDocument()
	})

	it("uses the class names it was given", () => {
		const { container } = render(
			<ErrorRow type="error" message="boom" headerClassName="my-header" messageClassName="my-message" />,
		)

		expect(container.querySelector(".my-header")).toBeInTheDocument()
		expect(container.querySelector(".my-message")).toBeInTheDocument()
	})

	it("renders whatever extra content it was given", () => {
		render(<ErrorRow type="error" message="boom" additionalContent={<div data-testid="extra" />} />)

		expect(screen.getByTestId("extra")).toBeInTheDocument()
	})
})

describe("ErrorRow — an expandable diff error", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		copyWithFeedback.mockResolvedValue(true)
	})

	it("keeps the details folded away until asked", () => {
		const { container } = render(<ErrorRow type="diff_error" message="the diff" expandable />)

		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
		expect(container.querySelector(".codicon-chevron-down")).toBeInTheDocument()

		fireEvent.click(screen.getByText("chat:diffError.title"))

		expect(screen.getByTestId("code-block")).toHaveTextContent("the diff")
		expect(container.querySelector(".codicon-chevron-up")).toBeInTheDocument()
	})

	it("can start out expanded", () => {
		render(<ErrorRow type="diff_error" message="the diff" expandable defaultExpanded />)

		expect(screen.getByTestId("code-block")).toBeInTheDocument()
	})

	it("copies the message and says so briefly", async () => {
		vi.useFakeTimers()
		const { container } = render(<ErrorRow type="diff_error" message="the diff" expandable showCopyButton />)

		await act(async () => {
			fireEvent.click(container.querySelector(".codicon-copy")!.parentElement!)
		})

		expect(copyWithFeedback).toHaveBeenCalledWith("the diff")
		expect(container.querySelector(".codicon-check")).toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(1000)
		})

		expect(container.querySelector(".codicon-copy")).toBeInTheDocument()
		vi.useRealTimers()
	})

	it("says nothing when the copy did not work", async () => {
		copyWithFeedback.mockResolvedValueOnce(false)
		const { container } = render(<ErrorRow type="diff_error" message="the diff" expandable showCopyButton />)

		await act(async () => {
			fireEvent.click(container.querySelector(".codicon-copy")!.parentElement!)
		})

		expect(container.querySelector(".codicon-check")).not.toBeInTheDocument()
	})

	it("keeps the copy click from also folding the block", async () => {
		const { container } = render(<ErrorRow type="diff_error" message="the diff" expandable showCopyButton />)

		await act(async () => {
			fireEvent.click(container.querySelector(".codicon-copy")!.parentElement!)
		})

		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
	})

	it("offers no copy button unless asked", () => {
		const { container } = render(<ErrorRow type="diff_error" message="the diff" expandable />)

		expect(container.querySelector(".codicon-copy")).not.toBeInTheDocument()
	})

	it("falls back to the plain layout when it is not expandable", () => {
		render(<ErrorRow type="diff_error" message="the diff" />)

		expect(screen.getByText("the diff")).toBeInTheDocument()
		expect(screen.queryByTestId("code-block")).not.toBeInTheDocument()
	})
})

describe("ErrorRow — documentation links", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("opens an external link through the host", () => {
		render(<ErrorRow type="error" message="boom" docsURL="https://example.com/docs" />)

		fireEvent.click(screen.getByRole("link"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openExternal", url: "https://example.com/docs" })
	})

	it("switches to the provider settings for an internal link", () => {
		render(<ErrorRow type="error" message="boom" docsURL="agent://settings" />)

		fireEvent.click(screen.getByRole("link"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "switchTab",
			tab: "settings",
			values: { section: "providers" },
		})
	})

	it("shows no link when there is nothing to link to", () => {
		render(<ErrorRow type="error" message="boom" />)

		expect(screen.queryByRole("link")).not.toBeInTheDocument()
	})
})

describe("ErrorRow — error details", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		copyWithFeedback.mockResolvedValue(true)
		selectedModel.provider = "openai"
	})

	it("offers no details link when there are no details", () => {
		render(<ErrorRow type="error" message="boom" />)

		expect(screen.queryByRole("button", { name: "chat:errorDetails.title" })).not.toBeInTheDocument()
	})

	it("stamps the report with the version, provider and model", async () => {
		render(<ErrorRow type="error" message="boom" errorDetails="stack trace here" />)

		fireEvent.click(screen.getByRole("button", { name: "chat:errorDetails.title" }))

		await waitFor(() => expect(document.body.textContent).toContain("stack trace here"))
		expect(document.body.textContent).toContain("Extension version: 1.2.3")
		expect(document.body.textContent).toContain("Provider: openai (proxy)")
		expect(document.body.textContent).toContain("Model: gpt-4")
	})

	it("mentions the proxy only for providers that use one", async () => {
		selectedModel.provider = "direct-provider"
		render(<ErrorRow type="error" message="boom" errorDetails="stack trace here" />)

		fireEvent.click(screen.getByRole("button", { name: "chat:errorDetails.title" }))

		await waitFor(() => expect(document.body.textContent).toContain("stack trace here"))
		expect(document.body.textContent).toContain("Provider: direct-provider")
		expect(document.body.textContent).not.toContain("(proxy)")
		expect(screen.queryByText("chat:errorDetails.proxyProvider")).not.toBeInTheDocument()
	})

	it("copies the whole report and acknowledges it", async () => {
		vi.useFakeTimers()
		render(<ErrorRow type="error" message="boom" errorDetails="stack trace here" />)
		fireEvent.click(screen.getByRole("button", { name: "chat:errorDetails.title" }))

		await act(async () => {
			fireEvent.click(screen.getByText("chat:errorDetails.copyToClipboard"))
		})

		expect(copyWithFeedback).toHaveBeenCalledWith(expect.stringContaining("stack trace here"))
		expect(screen.getByText("chat:errorDetails.copied")).toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(1000)
		})

		expect(screen.getByText("chat:errorDetails.copyToClipboard")).toBeInTheDocument()
		vi.useRealTimers()
	})

	it("says nothing when copying the report failed", async () => {
		copyWithFeedback.mockResolvedValueOnce(false)
		render(<ErrorRow type="error" message="boom" errorDetails="stack trace here" />)
		fireEvent.click(screen.getByRole("button", { name: "chat:errorDetails.title" }))

		await act(async () => {
			fireEvent.click(screen.getByText("chat:errorDetails.copyToClipboard"))
		})

		expect(screen.queryByText("chat:errorDetails.copied")).not.toBeInTheDocument()
	})

	it("sends the diagnostics without the message body when there are no details", async () => {
		render(<ErrorRow type="error" message="boom" errorDetails="stack trace here" />)
		fireEvent.click(screen.getByRole("button", { name: "chat:errorDetails.title" }))

		fireEvent.click(screen.getByText("chat:errorDetails.diagnostics"))

		await waitFor(() =>
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "downloadErrorDiagnostics" }),
			),
		)
	})
})
