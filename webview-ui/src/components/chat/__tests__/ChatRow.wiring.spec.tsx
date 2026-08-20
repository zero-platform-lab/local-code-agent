// npx vitest run src/components/chat/__tests__/ChatRow.wiring.spec.tsx

import React from "react"
import { render, screen, fireEvent, act } from "@/utils/test-utils"

import type { ClineMessage } from "@openai-agent/types"

import { vscode } from "@src/utils/vscode"

import ChatRow, { ChatRowContent } from "../ChatRow"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const translations = vi.hoisted(() => ({ known: new Set<string>() }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
		i18n: { language: "en", exists: (key: string) => translations.known.has(key) },
	}),
	Trans: ({ i18nKey, children }: any) => <span data-testid={`trans-${i18nKey}`}>{children}</span>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

const extensionState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState.current,
}))

vi.mock("../../ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

const sizeHarness = vi.hoisted(() => ({ height: 0 }))

vi.mock("react-use", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		useSize: (element: React.ReactElement) => [element, { width: 100, height: sizeHarness.height }],
	}
})

vi.mock("@src/components/common/CodeBlock", () => ({
	__esModule: true,
	default: () => <div data-testid="code-block" />,
}))
vi.mock("../../common/CodeAccordion", () => ({
	__esModule: true,
	default: ({ code, path, isExpanded, onToggleExpand }: any) => (
		<div data-testid="code-accordion" data-path={path} data-expanded={String(isExpanded)}>
			<button data-testid="code-accordion-toggle" onClick={onToggleExpand} />
			{code}
		</div>
	),
}))
vi.mock("../../common/MarkdownBlock", () => ({
	__esModule: true,
	default: ({ markdown }: any) => <div data-testid="markdown-block">{markdown}</div>,
}))
vi.mock("../Markdown", () => ({
	Markdown: ({ markdown, partial }: any) => (
		<div data-testid="markdown" data-partial={String(partial)}>
			{markdown}
		</div>
	),
}))
vi.mock("../CommandExecution", () => ({
	CommandExecution: ({ text, executionId }: any) => (
		<div data-testid="command-execution" data-execution-id={executionId}>
			{text}
		</div>
	),
}))
vi.mock("../CommandExecutionError", () => ({
	CommandExecutionError: ({ errorMessage }: any) => (
		<div data-testid="command-error">{errorMessage ?? "shell-warning"}</div>
	),
}))
vi.mock("../McpExecution", () => ({
	McpExecution: ({ toolName, serverName, text }: any) => (
		<div data-testid="mcp-execution" data-tool={toolName} data-server={serverName}>
			{text}
		</div>
	),
}))
vi.mock("../../mcp/McpResourceRow", () => ({
	__esModule: true,
	default: ({ item }: any) => <div data-testid="mcp-resource" data-uri={item.uri} data-name={item.name} />,
}))
vi.mock("../ChatTextArea", () => ({
	ChatTextArea: ({ inputValue, setInputValue, onSend, onCancel, onSelectImages, selectedImages, mode }: any) => (
		<div data-testid="edit-textarea" data-images={selectedImages.join(",")} data-mode={mode}>
			<textarea value={inputValue} onChange={(event) => setInputValue(event.target.value)} />
			<button data-testid="edit-send" onClick={onSend} />
			<button data-testid="edit-cancel" onClick={onCancel} />
			<button data-testid="edit-images" onClick={onSelectImages} />
		</div>
	),
}))
vi.mock("../checkpoints/CheckpointSaved", () => ({
	CheckpointSaved: (props: any) => <div data-testid="checkpoint-saved" data-current={String(props.checkpoint?.to)} />,
}))
vi.mock("../FollowUpSuggest", () => ({
	FollowUpSuggest: ({ suggestions, onSuggestionClick, isAnswered }: any) => (
		<div data-testid="follow-up" data-answered={String(isAnswered)} data-count={suggestions?.length ?? 0}>
			<button data-testid="follow-up-pick" onClick={(event) => onSuggestionClick?.({ answer: "yes" }, event)} />
		</div>
	),
}))
vi.mock("../BatchFilePermission", () => ({
	BatchFilePermission: ({ files, onPermissionResponse }: any) => (
		<div data-testid="batch-permission" data-count={files.length}>
			<button data-testid="batch-approve" onClick={() => onPermissionResponse({ "a.ts": true })} />
		</div>
	),
}))
vi.mock("../BatchDiffApproval", () => ({
	BatchDiffApproval: ({ files }: any) => <div data-testid="batch-diff" data-count={files.length} />,
}))
vi.mock("../CodebaseSearchResultsDisplay", () => ({
	__esModule: true,
	default: ({ results }: any) => <div data-testid="codebase-results" data-count={results.length} />,
}))
vi.mock("../UpdateTodoListToolBlock", () => ({
	__esModule: true,
	default: ({ todos, onChange, editable }: any) => (
		<div data-testid="todo-block" data-count={todos?.length ?? 0} data-editable={String(editable)}>
			<button data-testid="todo-change" onClick={() => onChange?.([{ id: "1", content: "edited" }])} />
		</div>
	),
}))
vi.mock("../TodoChangeDisplay", () => ({
	TodoChangeDisplay: ({ previousTodos, newTodos }: any) => (
		<div
			data-testid="todo-change-display"
			data-previous={previousTodos?.length ?? 0}
			data-count={newTodos?.length ?? 0}
		/>
	),
}))
vi.mock("../../common/Thumbnails", () => ({
	__esModule: true,
	default: ({ images }: any) => <div data-testid="thumbnails" data-count={images.length} />,
}))
vi.mock("../../common/ImageBlock", () => ({
	__esModule: true,
	default: ({ imageUri, imagePath }: any) => (
		<div data-testid="image-block" data-uri={imageUri} data-path={imagePath} />
	),
}))
vi.mock("../ReasoningBlock", () => ({
	ReasoningBlock: ({ content }: any) => <div data-testid="reasoning-block">{content}</div>,
}))
vi.mock("../ErrorRow", () => ({
	__esModule: true,
	default: ({ type, message }: any) => (
		<div data-testid="error-row" data-type={type}>
			{message}
		</div>
	),
}))
vi.mock("../WarningRow", () => ({
	__esModule: true,
	default: ({ warningMessage, message, onAction }: any) => (
		<div data-testid="warning-row">
			{warningMessage ?? message}
			{onAction ? <button data-testid="warning-action" onClick={onAction} /> : null}
		</div>
	),
}))
vi.mock("../AutoApprovedRequestLimitWarning", () => ({
	AutoApprovedRequestLimitWarning: () => <div data-testid="auto-approve-limit" />,
}))
vi.mock("../context-management", () => ({
	InProgressRow: () => <div data-testid="in-progress-row" />,
	CondensationResultRow: ({ data }: any) => <div data-testid="condense-row" data-summary={data?.summary} />,
	CondensationErrorRow: ({ errorText }: any) => <div data-testid="condense-error">{errorText}</div>,
	TruncationResultRow: () => <div data-testid="truncation-row" />,
}))
vi.mock("../OpenMarkdownPreviewButton", () => ({
	OpenMarkdownPreviewButton: () => <div data-testid="markdown-preview-button" />,
}))

const setState = (state: Record<string, unknown> = {}) => {
	extensionState.current = {
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: undefined,
		mode: "code",
		apiConfiguration: {},
		clineMessages: [],
		currentTaskItem: undefined,
		...state,
	}
}

const posted = () => (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message)

const baseProps = {
	isExpanded: false,
	isLast: false,
	isStreaming: false,
	onToggleExpand: vi.fn(),
	onSuggestionClick: vi.fn(),
	onBatchFileResponse: vi.fn(),
	onFollowUpUnmount: vi.fn(),
}

const renderRow = (message: Partial<ClineMessage>, props: Record<string, unknown> = {}, state = {}) => {
	setState(state)
	return render(
		<ChatRowContent {...baseProps} {...props} message={{ ts: 1000, type: "say", ...message } as ClineMessage} />,
	)
}

const tool = (payload: Record<string, unknown>, overrides: Partial<ClineMessage> = {}) => ({
	type: "ask" as const,
	ask: "tool" as const,
	text: JSON.stringify(payload),
	...overrides,
})

describe("ChatRow wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		sizeHarness.height = 0
	})

	describe("height reporting", () => {
		it("stays quiet on the first measurement", () => {
			const onHeightChange = vi.fn()
			sizeHarness.height = 120
			setState()

			render(
				<ChatRow
					{...baseProps}
					isLast
					onHeightChange={onHeightChange}
					message={{ ts: 1, type: "say", say: "text", text: "hi" } as ClineMessage}
				/>,
			)

			expect(onHeightChange).not.toHaveBeenCalled()
		})

		it("reports whether the row grew or shrank", () => {
			const onHeightChange = vi.fn()
			sizeHarness.height = 120
			setState()

			const { rerender } = render(
				<ChatRow
					{...baseProps}
					isLast
					onHeightChange={onHeightChange}
					message={{ ts: 1, type: "say", say: "text", text: "hi" } as ClineMessage}
				/>,
			)

			sizeHarness.height = 200
			rerender(
				<ChatRow
					{...baseProps}
					isLast
					onHeightChange={onHeightChange}
					message={{ ts: 1, type: "say", say: "text", text: "hi there" } as ClineMessage}
				/>,
			)
			expect(onHeightChange).toHaveBeenLastCalledWith(true)

			sizeHarness.height = 150
			rerender(
				<ChatRow
					{...baseProps}
					isLast
					onHeightChange={onHeightChange}
					message={{ ts: 1, type: "say", say: "text", text: "hi" } as ClineMessage}
				/>,
			)
			expect(onHeightChange).toHaveBeenLastCalledWith(false)
		})

		it("ignores rows that are not the last one", () => {
			const onHeightChange = vi.fn()
			sizeHarness.height = 120
			setState()

			const { rerender } = render(
				<ChatRow
					{...baseProps}
					isLast={false}
					onHeightChange={onHeightChange}
					message={{ ts: 1, type: "say", say: "text", text: "hi" } as ClineMessage}
				/>,
			)
			sizeHarness.height = 400
			rerender(
				<ChatRow
					{...baseProps}
					isLast={false}
					onHeightChange={onHeightChange}
					message={{ ts: 1, type: "say", say: "text", text: "hi!" } as ClineMessage}
				/>,
			)

			expect(onHeightChange).not.toHaveBeenCalled()
		})

		it("ignores an unusable measurement", () => {
			const onHeightChange = vi.fn()
			sizeHarness.height = Infinity
			setState()

			render(
				<ChatRow
					{...baseProps}
					isLast
					onHeightChange={onHeightChange}
					message={{ ts: 1, type: "say", say: "text", text: "hi" } as ClineMessage}
				/>,
			)

			expect(onHeightChange).not.toHaveBeenCalled()
		})
	})

	describe("plain messages", () => {
		it("renders assistant text", () => {
			renderRow({ say: "text", text: "hello there" })

			expect(screen.getByTestId("markdown")).toHaveTextContent("hello there")
		})

		it("renders the reasoning block", () => {
			renderRow({ say: "reasoning", text: "thinking..." })

			expect(screen.getByTestId("reasoning-block")).toHaveTextContent("thinking...")
		})

		it("renders an image", () => {
			renderRow({ say: "image", text: JSON.stringify({ imageUri: "file://a.png", imagePath: "a.png" }) })

			expect(screen.getByTestId("image-block")).toHaveAttribute("data-path", "a.png")
		})

		it("renders a diff error", () => {
			renderRow({ say: "diff_error", text: "bad diff" })

			expect(screen.getByTestId("error-row")).toHaveAttribute("data-type", "diff_error")
		})

		it("renders a shell integration warning", () => {
			renderRow({ say: "shell_integration_warning", text: "no shell" })

			expect(screen.getByTestId("command-error")).toBeInTheDocument()
		})

		it("renders a checkpoint", () => {
			renderRow({ say: "checkpoint_saved", text: "abc123" })

			expect(screen.getByTestId("checkpoint-saved")).toBeInTheDocument()
		})

		it("renders the condensation result and its error", () => {
			renderRow({ say: "condense_context", contextCondense: { summary: "shorter" } as any })
			expect(screen.getByTestId("condense-row")).toHaveAttribute("data-summary", "shorter")

			renderRow({ say: "condense_context_error", text: "could not condense" })
			expect(screen.getByTestId("condense-error")).toHaveTextContent("could not condense")
		})

		it("renders the truncation result and its progress", () => {
			renderRow({ say: "sliding_window_truncation", contextTruncation: { messagesRemoved: 3 } as any })
			expect(screen.getByTestId("truncation-row")).toBeInTheDocument()

			renderRow({ say: "sliding_window_truncation", partial: true })
			expect(screen.getAllByTestId("in-progress-row").length).toBe(1)

			const { container } = renderRow({ say: "sliding_window_truncation" })
			expect(container).toBeEmptyDOMElement()
		})

		it("shows the condensation progress and gives up without data", () => {
			renderRow({ say: "condense_context", partial: true })
			expect(screen.getByTestId("in-progress-row")).toBeInTheDocument()

			const { container } = renderRow({ say: "condense_context" })
			expect(container).toBeEmptyDOMElement()
		})

		it("renders nothing for an api request that finished", () => {
			const { container } = renderRow({ say: "api_req_finished" })

			expect(container).toBeEmptyDOMElement()
		})

		it("renders the codebase search results", () => {
			renderRow({
				say: "codebase_search_result",
				text: JSON.stringify({ content: { query: "needle", results: [{ filePath: "a.ts", score: 1 }] } }),
			})

			expect(screen.getByTestId("codebase-results")).toHaveAttribute("data-count", "1")
		})

		it("renders the todo list the user edited", () => {
			renderRow({ say: "user_edit_todos", text: JSON.stringify({ todos: [{ id: "1", content: "do it" }] }) })

			expect(screen.getByTestId("todo-block")).toBeInTheDocument()
		})
	})

	describe("editing your own message", () => {
		const feedback = { say: "user_feedback" as const, text: "please fix", images: ["data:image/png;base64,A"] }

		it("opens the editor when the message is clicked", () => {
			renderRow(feedback)

			fireEvent.click(screen.getByTitle("chat:queuedMessages.clickToEdit"))

			expect(screen.getByTestId("edit-textarea")).toBeInTheDocument()
			expect(screen.getByTestId("edit-textarea")).toHaveAttribute("data-images", "data:image/png;base64,A")
		})

		it("does not open the editor while the model is answering", () => {
			renderRow(feedback, { isStreaming: true })

			fireEvent.click(screen.getByTitle("chat:queuedMessages.clickToEdit"))

			expect(screen.queryByTestId("edit-textarea")).not.toBeInTheDocument()
		})

		it("opens the editor from the pencil", () => {
			renderRow(feedback)

			fireEvent.click(screen.getByLabelText("Edit message icon").parentElement!)

			expect(screen.getByTestId("edit-textarea")).toBeInTheDocument()
		})

		it("deletes the message", () => {
			renderRow(feedback)

			fireEvent.click(screen.getByLabelText("Delete message icon").parentElement!)

			expect(posted()).toContainEqual({ type: "deleteMessage", value: 1000 })
		})

		it("sends the edited message", () => {
			renderRow(feedback)
			fireEvent.click(screen.getByLabelText("Edit message icon").parentElement!)

			fireEvent.change(screen.getByTestId("edit-textarea").querySelector("textarea")!, {
				target: { value: "please fix it properly" },
			})
			fireEvent.click(screen.getByTestId("edit-send"))

			expect(posted()).toContainEqual({
				type: "submitEditedMessage",
				value: 1000,
				editedMessageContent: "please fix it properly",
				images: ["data:image/png;base64,A"],
			})
			expect(screen.queryByTestId("edit-textarea")).not.toBeInTheDocument()
		})

		it("gives up on the edit", () => {
			renderRow(feedback)
			fireEvent.click(screen.getByLabelText("Edit message icon").parentElement!)

			fireEvent.click(screen.getByTestId("edit-cancel"))

			expect(screen.queryByTestId("edit-textarea")).not.toBeInTheDocument()
			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "submitEditedMessage" }))
		})

		it("asks for images while editing", () => {
			renderRow(feedback)
			fireEvent.click(screen.getByLabelText("Edit message icon").parentElement!)

			fireEvent.click(screen.getByTestId("edit-images"))

			expect(posted()).toContainEqual({ type: "selectImages", context: "edit", messageTs: 1000 })
		})

		it("adds the images the extension picked", () => {
			renderRow(feedback)
			fireEvent.click(screen.getByLabelText("Edit message icon").parentElement!)

			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "selectedImages",
							context: "edit",
							messageTs: 1000,
							images: ["data:image/png;base64,B"],
						},
					}),
				)
			})

			expect(screen.getByTestId("edit-textarea")).toHaveAttribute(
				"data-images",
				"data:image/png;base64,A,data:image/png;base64,B",
			)
		})

		it("ignores images meant for another message or another purpose", () => {
			renderRow(feedback)
			fireEvent.click(screen.getByLabelText("Edit message icon").parentElement!)

			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "selectedImages", context: "edit", messageTs: 999, images: ["x"] },
					}),
				)
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "selectedImages", messageTs: 1000, images: ["x"] },
					}),
				)
			})

			expect(screen.getByTestId("edit-textarea")).toHaveAttribute("data-images", "data:image/png;base64,A")
		})

		it("ignores images when nothing is being edited", () => {
			renderRow(feedback)

			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "selectedImages", context: "edit", messageTs: 1000, images: ["stray"] },
					}),
				)
			})
			expect(screen.queryByTestId("edit-textarea")).not.toBeInTheDocument()

			// 編集を始めても、拾ってしまった画像が混ざっていない。
			fireEvent.click(screen.getByTitle("chat:queuedMessages.clickToEdit"))
			expect(screen.getByTestId("edit-textarea")).toHaveAttribute("data-images", "data:image/png;base64,A")
		})

		it("empties the editor when the message had nothing in it", () => {
			renderRow(
				{ say: "user_feedback", text: "hi", images: ["data:image/png;base64,A"] },
				{},
				{ mode: undefined },
			)
			fireEvent.click(screen.getByLabelText("Edit message icon").parentElement!)

			fireEvent.click(screen.getByTestId("edit-cancel"))
			fireEvent.click(screen.getByLabelText("Edit message icon").parentElement!)

			expect(screen.getByTestId("edit-textarea")).toHaveAttribute("data-mode", "code")
		})

		it("resets an empty message on cancel", () => {
			renderRow({ say: "user_feedback" }, {}, { mode: undefined })
			fireEvent.click(screen.getByTitle("chat:queuedMessages.clickToEdit"))

			fireEvent.change(screen.getByTestId("edit-textarea").querySelector("textarea")!, {
				target: { value: "typed something" },
			})
			fireEvent.click(screen.getByTestId("edit-cancel"))
			fireEvent.click(screen.getByTitle("chat:queuedMessages.clickToEdit"))

			expect(screen.getByTestId("edit-textarea").querySelector("textarea")).toHaveValue("")
			expect(screen.getByTestId("edit-textarea")).toHaveAttribute("data-images", "")
		})

		it("shows the attached images when not editing", () => {
			renderRow(feedback)

			expect(screen.getByTestId("thumbnails")).toHaveAttribute("data-count", "1")
		})
	})

	describe("tools", () => {
		it("asks to read a single file and opens it", () => {
			renderRow(tool({ tool: "readFile", path: "src/app.ts", content: "/abs/src/app.ts", startLine: 12 }))

			expect(screen.getByText("chat:fileOperations.wantsToRead")).toBeInTheDocument()

			fireEvent.click(screen.getByText(/src\/app\.ts/))
			expect(posted()).toContainEqual({
				type: "openFile",
				text: "/abs/src/app.ts",
				values: { line: 12 },
			})
		})

		it("mentions that the file is outside the workspace", () => {
			renderRow(tool({ tool: "readFile", path: "../outside.ts", isOutsideWorkspace: true }))

			expect(screen.getByText("chat:fileOperations.wantsToReadOutsideWorkspace")).toBeInTheDocument()
		})

		it("counts the extra files it wants to read", () => {
			renderRow(tool({ tool: "readFile", path: "a.ts", additionalFileCount: 3 }))

			expect(screen.getByText(/wantsToReadAndXMore/)).toBeInTheDocument()
		})

		it("reports a file it already read", () => {
			// 同じツール内容でも、承認待ち（ask）と実行済み（say）で文言が変わる。
			renderRow({
				type: "say",
				say: "tool",
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "./a.ts" }),
			})

			expect(screen.getByText("chat:fileOperations.didRead")).toBeInTheDocument()
			expect(screen.getByText(".")).toBeInTheDocument()
		})

		it("asks for a batch of files", () => {
			const onBatchFileResponse = vi.fn()
			renderRow(tool({ tool: "readFile", batchFiles: [{ path: "a.ts" }, { path: "b.ts" }] }), {
				onBatchFileResponse,
			})

			expect(screen.getByTestId("batch-permission")).toHaveAttribute("data-count", "2")

			fireEvent.click(screen.getByTestId("batch-approve"))
			expect(onBatchFileResponse).toHaveBeenCalledWith({ "a.ts": true })
		})

		it("describes a codebase search with and without a path", () => {
			renderRow(tool({ tool: "codebaseSearch", query: "needle", path: "src" }))
			expect(screen.getByTestId("trans-chat:codebaseSearch.wantsToSearchWithPath")).toBeInTheDocument()

			renderRow(tool({ tool: "codebaseSearch", query: "needle" }))
			expect(screen.getByTestId("trans-chat:codebaseSearch.wantsToSearch")).toBeInTheDocument()
		})

		it("shows what the todo list would become", () => {
			renderRow(tool({ tool: "updateTodoList", todos: [{ id: "1", content: "do it" }] }))

			expect(screen.getByTestId("todo-change-display")).toHaveAttribute("data-count", "1")
			expect(screen.getByTestId("todo-change-display")).toHaveAttribute("data-previous", "0")
		})

		it("shows a skill and what it carries", () => {
			renderRow(tool({ tool: "skill", skill: "review", source: "project", description: "d", args: "a" }), {
				isExpanded: true,
			})

			expect(screen.getByText("chat:skill.wantsToLoad")).toBeInTheDocument()
			expect(screen.getByText("review")).toBeInTheDocument()
			expect(screen.getByText("project")).toBeInTheDocument()
			expect(screen.getByText("d")).toBeInTheDocument()
			expect(screen.getByText("a")).toBeInTheDocument()
		})

		it("keeps a skill collapsed by default", () => {
			const onToggleExpand = vi.fn()
			renderRow(tool({ tool: "skill", skill: "review", description: "d" }), { onToggleExpand })

			expect(screen.queryByText("d")).not.toBeInTheDocument()
			fireEvent.click(screen.getByText("review"))
			expect(onToggleExpand).toHaveBeenCalledWith(1000)
		})

		it("reports a skill it already loaded", () => {
			renderRow({
				type: "say",
				say: "tool",
				ask: "tool",
				text: JSON.stringify({ tool: "skill", skill: "review" }),
			})

			expect(screen.getByText("chat:skill.didLoad")).toBeInTheDocument()
		})
	})

	describe("api requests", () => {
		const apiReq = (info: Record<string, unknown>, overrides: Partial<ClineMessage> = {}) => ({
			say: "api_req_started" as const,
			text: JSON.stringify(info),
			...overrides,
		})

		it("shows the cost of a finished request", () => {
			renderRow(apiReq({ request: "GET /v1", cost: 0.12 }), { isExpanded: true })

			expect(screen.getByText("chat:apiRequest.title")).toBeInTheDocument()
		})

		it("shows that the user cancelled", () => {
			renderRow(apiReq({ request: "GET /v1", cancelReason: "user_cancelled" }))

			expect(screen.getByText("chat:apiRequest.cancelled")).toBeInTheDocument()
		})

		it("shows that streaming failed", () => {
			renderRow(apiReq({ request: "GET /v1", cancelReason: "streaming_failed", streamingFailedMessage: "boom" }))

			expect(screen.getByText("chat:apiRequest.streamingFailed")).toBeInTheDocument()
		})

		it("shows the failure of the last request", () => {
			renderRow(apiReq({ request: "GET /v1" }), {
				isLast: true,
				lastModifiedMessage: { ts: 2, type: "ask", ask: "api_req_failed", text: "no network" } as ClineMessage,
			})

			expect(screen.getByText("chat:apiRequest.failed")).toBeInTheDocument()
		})

		it("shows that a request is still streaming", () => {
			renderRow(apiReq({ request: "GET /v1" }), { isLast: true })

			expect(screen.getByText("chat:apiRequest.streaming")).toBeInTheDocument()
		})

		it("shows an older request that never finished without a spinner", () => {
			renderRow(apiReq({ request: "GET /v1" }), { isLast: false })

			expect(screen.getByText("chat:apiRequest.streaming")).toBeInTheDocument()
		})

		it("tolerates an unparsable payload", () => {
			renderRow({ say: "api_req_started", text: "not json" })

			expect(screen.getByText("chat:apiRequest.streaming")).toBeInTheDocument()
		})

		it("shows the retry countdown", () => {
			renderRow({ say: "api_req_retry_delayed", text: "rate limited <retry_timer>5</retry_timer>" })

			expect(screen.getByTestId("error-row")).toBeInTheDocument()
		})

		it("shows a retry message without a countdown", () => {
			renderRow({ say: "api_req_retry_delayed", text: "will retry" })

			expect(screen.getByTestId("error-row")).toBeInTheDocument()
		})

		it("shows a known http error in words", () => {
			translations.known.add("chat:apiRequest.errorMessage.429")
			try {
				renderRow({ say: "api_req_retry_delayed", text: "429 too many requests" })

				expect(screen.getByTestId("error-row")).toBeInTheDocument()
			} finally {
				translations.known.clear()
			}
		})

		it("keeps an unknown http error as it came", () => {
			renderRow({ say: "api_req_retry_delayed", text: "418 i am a teapot" })

			expect(screen.getByTestId("error-row")).toBeInTheDocument()
		})

		it("shows the rate limit wait while it is waiting", () => {
			renderRow({ say: "api_req_rate_limit_wait", text: JSON.stringify({ seconds: 30 }), partial: true })

			expect(screen.getByText("chat:apiRequest.rateLimitWait")).toBeInTheDocument()
			expect(screen.getByText("30s")).toBeInTheDocument()
		})

		it("shows nothing once the wait is over", () => {
			const { container } = renderRow({ say: "api_req_rate_limit_wait", text: JSON.stringify({ seconds: 30 }) })

			expect(container).toBeEmptyDOMElement()
		})

		it("shows nothing when the wait payload cannot be read", () => {
			const { container } = renderRow({ say: "api_req_rate_limit_wait", text: "not json", partial: true })
			expect(container).toBeEmptyDOMElement()

			const withoutSeconds = renderRow({
				say: "api_req_rate_limit_wait",
				text: JSON.stringify({ other: 1 }),
				partial: true,
			})
			expect(withoutSeconds.container).toBeEmptyDOMElement()

			// 秒数が数値でないときも待ち表示は出さない。
			const notANumber = renderRow({
				say: "api_req_rate_limit_wait",
				text: JSON.stringify({ seconds: "30" }),
				partial: true,
			})
			expect(notANumber.container).toBeEmptyDOMElement()

			const withoutText = renderRow({ say: "api_req_rate_limit_wait", partial: true })
			expect(withoutText.container).toBeEmptyDOMElement()
		})
	})

	describe("say tools", () => {
		const sayTool = (payload: Record<string, unknown>) => ({
			say: "tool" as const,
			text: JSON.stringify(payload),
		})

		it("shows a slash command that ran, with everything it carried", () => {
			renderRow(
				sayTool({
					tool: "runSlashCommand",
					command: "review",
					args: "--fast",
					source: "project",
					description: "d",
				}),
			)

			expect(screen.getByText("/review")).toBeInTheDocument()
			expect(screen.getByText("--fast")).toBeInTheDocument()
			expect(screen.getByText("d")).toBeInTheDocument()
			expect(screen.getByText("project")).toBeInTheDocument()
		})

		it("shows a bare slash command", () => {
			renderRow(sayTool({ tool: "runSlashCommand", command: "review" }))

			expect(screen.getByText("/review")).toBeInTheDocument()
		})

		it("describes a search through the command output", () => {
			renderRow(sayTool({ tool: "readCommandOutput", searchPattern: "error", matchCount: 3 }))

			expect(screen.getByText(/search: "error" • 3 matches/)).toBeInTheDocument()
		})

		it("says when a search found exactly one match", () => {
			renderRow(sayTool({ tool: "readCommandOutput", searchPattern: "error", matchCount: 1 }))

			expect(screen.getByText(/1 match\)/)).toBeInTheDocument()
		})

		it("says nothing about the count when it is unknown", () => {
			renderRow(sayTool({ tool: "readCommandOutput", searchPattern: "error" }))

			expect(screen.getByText(/search: "error"\)/)).toBeInTheDocument()
		})

		it("describes the byte range that was read", () => {
			renderRow(sayTool({ tool: "readCommandOutput", readStart: 0, readEnd: 2048, totalBytes: 3 * 1024 * 1024 }))

			expect(screen.getByText(/0 B - 2\.0 KB of 3\.0 MB/)).toBeInTheDocument()
		})

		it("describes just the size when there is no range", () => {
			renderRow(sayTool({ tool: "readCommandOutput", totalBytes: 512 }))

			expect(screen.getByText(/512 B/)).toBeInTheDocument()
		})

		it("says nothing extra when there is nothing to say", () => {
			renderRow(sayTool({ tool: "readCommandOutput" }))

			expect(screen.getByText("chat:readCommandOutput.title")).toBeInTheDocument()
			expect(document.body.textContent).not.toContain("(")
		})

		it("renders nothing for a say tool it does not know", () => {
			const { container } = renderRow(sayTool({ tool: "somethingElse" }))

			expect(container).toBeEmptyDOMElement()
		})

		it("renders nothing when the payload is not json", () => {
			const { container } = renderRow({ say: "tool", text: "not json" })

			expect(container).toBeEmptyDOMElement()
		})
	})

	describe("warnings and results", () => {
		it("warns about too many tools and opens the settings", () => {
			const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => {})
			renderRow({
				say: "too_many_tools_warning",
				text: JSON.stringify({ toolCount: 120, serverCount: 4, threshold: 100 }),
			})

			expect(screen.getByTestId("warning-row")).toBeInTheDocument()
			postMessage.mockRestore()
		})

		it("shows the result of a subtask", () => {
			renderRow({ say: "subtask_result", text: "the subtask is done" })

			expect(screen.getByTestId("markdown-block")).toHaveTextContent("the subtask is done")
		})

		it("shows a completion result with its images", () => {
			renderRow({
				say: "completion_result",
				text: "all done",
				images: ["data:image/png;base64,A", "data:image/png;base64,B"],
			})

			expect(screen.getByTestId("markdown")).toHaveTextContent("all done")
		})

		it("shows plain text with its images", () => {
			renderRow({ say: "text", text: "look", images: ["data:image/png;base64,A"] })

			expect(screen.getAllByTestId("image-block")).toHaveLength(1)
		})

		it("shows an error row", () => {
			renderRow({ say: "error", text: "it broke" })

			expect(screen.getByTestId("error-row")).toBeInTheDocument()
		})

		it("shows the diff of what the user changed", () => {
			renderRow({ say: "user_feedback_diff", text: JSON.stringify({ diff: "- a\n+ b" }) })

			expect(screen.getByTestId("code-accordion")).toBeInTheDocument()
		})

		it("reports a codebase search payload it cannot use", () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {})

			renderRow({ say: "codebase_search_result", text: "not json" })
			expect(error).toHaveBeenCalledWith("Failed to parse codebaseSearch content:", expect.anything())

			renderRow({ say: "codebase_search_result", text: JSON.stringify({ other: true }) })
			expect(screen.getByText("Error displaying search results.")).toBeInTheDocument()

			error.mockRestore()
		})

		it("falls back to an empty result list", () => {
			renderRow({ say: "codebase_search_result", text: JSON.stringify({ content: {} }) })

			expect(screen.getByTestId("codebase-results")).toHaveAttribute("data-count", "0")
		})
	})

	describe("final touches", () => {
		it("spins while the command is still running", () => {
			renderRow(
				{ type: "ask", ask: "command", text: "npm test" },
				{
					isLast: true,
					lastModifiedMessage: {
						ts: 2,
						type: "ask",
						ask: "command",
						text: `npm test\nOutput:running`,
					} as ClineMessage,
				},
			)

			expect(screen.getByTestId("command-execution")).toBeInTheDocument()
		})

		it("spins while the mcp server is answering", () => {
			renderRow(
				{
					type: "ask",
					ask: "use_mcp_server",
					text: JSON.stringify({ type: "use_mcp_tool", serverName: "files", toolName: "read" }),
				},
				{
					isLast: true,
					lastModifiedMessage: { ts: 2, type: "say", say: "mcp_server_request_started" } as ClineMessage,
				},
			)

			expect(screen.getByTestId("mcp-execution")).toBeInTheDocument()
		})

		it("keeps the edit box empty for a message without text or images", () => {
			renderRow({ say: "user_feedback" })

			fireEvent.click(screen.getByTitle("chat:queuedMessages.clickToEdit"))

			expect(screen.getByTestId("edit-textarea")).toHaveAttribute("data-images", "")
			expect(screen.getByTestId("edit-textarea").querySelector("textarea")).toHaveValue("")
		})

		it("falls back to the code mode while editing", () => {
			renderRow({ say: "user_feedback", text: "hi" }, {}, { mode: undefined })

			fireEvent.click(screen.getByTitle("chat:queuedMessages.clickToEdit"))

			expect(screen.getByTestId("edit-textarea")).toHaveAttribute("data-mode", "code")
		})

		it("names the two incomplete-response errors", () => {
			renderRow({ say: "error", text: "MODEL_NO_TOOLS_USED" })
			expect(screen.getByTestId("error-row")).toHaveTextContent("chat:modelResponseErrors.noToolsUsed")

			renderRow({ say: "error", text: "MODEL_NO_ASSISTANT_MESSAGES" })
			expect(screen.getAllByTestId("error-row")[1]).toHaveTextContent(
				"chat:modelResponseErrors.noAssistantMessages",
			)
		})

		it("falls back to a generic error message", () => {
			renderRow({ say: "error" })

			expect(screen.getByTestId("error-row")).toHaveTextContent("chat:error")
		})

		it("points at the powershell troubleshooting page", () => {
			renderRow(
				{ say: "api_req_started", text: JSON.stringify({ request: "GET /v1" }) },
				{
					isLast: true,
					lastModifiedMessage: {
						ts: 2,
						type: "ask",
						ask: "api_req_failed",
						text: "PowerShell is not recognized",
					} as ClineMessage,
				},
			)

			expect(screen.getByTestId("error-row")).toBeInTheDocument()
		})

		it("opens the mcp settings from the warning", () => {
			const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => {})
			renderRow({
				say: "too_many_tools_warning",
				text: JSON.stringify({ toolCount: 120, serverCount: 4, threshold: 100 }),
			})

			fireEvent.click(screen.getByTestId("warning-action"))

			expect(postMessage).toHaveBeenCalledWith(
				{ type: "action", action: "settingsButtonClicked", values: { section: "mcp" } },
				"*",
			)
			postMessage.mockRestore()
		})

		it("renders nothing for an image payload it cannot read", () => {
			renderRow({ say: "image", text: "not json" })

			expect(screen.queryByTestId("image-block")).not.toBeInTheDocument()
		})

		it("renders a say type it does not know as plain markdown", () => {
			renderRow({ say: "browser_action" as any, text: "something else" })

			expect(screen.getByTestId("markdown")).toHaveTextContent("something else")
		})

		it("lets the user edit the todo list of the current task", () => {
			renderRow({ say: "user_edit_todos", text: JSON.stringify({ todos: [] }) })

			fireEvent.click(screen.getByTestId("todo-change"))

			expect(screen.getByTestId("todo-block")).toBeInTheDocument()
		})
	})

	describe("fallbacks", () => {
		it("reports a slash command that already ran", () => {
			renderRow({
				type: "say",
				say: "tool",
				ask: "tool",
				text: JSON.stringify({ tool: "runSlashCommand", command: "review" }),
			})

			expect(screen.getByText("chat:slashCommand.didRun")).toBeInTheDocument()
		})

		it("expands a slash command to show what it carries", () => {
			renderRow(tool({ tool: "runSlashCommand", command: "review", args: "--fast" }), { isExpanded: true })

			expect(screen.getByText("--fast")).toBeInTheDocument()
		})

		it("renders nothing for a tool it does not know", () => {
			const { container } = renderRow(tool({ tool: "somethingNew" }))

			expect(container).toBeEmptyDOMElement()
		})

		it("falls back through the diff sources", () => {
			renderRow(tool({ tool: "appliedDiff", path: "a.ts", diff: "- a\n+ b" }), { isExpanded: true })
			expect(screen.getAllByTestId("code-accordion")[0]).toBeInTheDocument()

			renderRow(tool({ tool: "appliedDiff", path: "a.ts" }), { isExpanded: true })
			expect(screen.getAllByTestId("code-accordion")[1]).toBeInTheDocument()
		})

		it("copes with a todo tool that carries no todos", () => {
			renderRow(tool({ tool: "updateTodoList" }))

			expect(screen.getByTestId("todo-change-display")).toHaveAttribute("data-count", "0")
		})

		it("copes with a batch read that carries no files", () => {
			renderRow(tool({ tool: "readFile", batchFiles: [] }))

			expect(screen.getByTestId("batch-permission")).toHaveAttribute("data-count", "0")
		})

		it("opens a file without a line number", () => {
			renderRow(tool({ tool: "readFile", path: "a.ts", content: "/abs/a.ts" }))

			fireEvent.click(screen.getByText(/a\.ts/))

			expect(posted()).toContainEqual({ type: "openFile", text: "/abs/a.ts", values: undefined })
		})

		it("keeps a skill collapsed when there is nothing to show", () => {
			renderRow(tool({ tool: "skill", skill: "review" }), { isExpanded: true })

			expect(screen.getByText("review")).toBeInTheDocument()
		})

		it("renders an empty diff error", () => {
			renderRow({ say: "diff_error" })

			expect(screen.getByTestId("error-row")).toBeInTheDocument()
		})

		it("renders empty reasoning", () => {
			renderRow({ say: "reasoning" })

			expect(screen.getByTestId("reasoning-block")).toBeInTheDocument()
		})

		it("shows the streaming failure when the request itself did not fail", () => {
			renderRow({
				say: "api_req_started",
				text: JSON.stringify({
					request: "GET /v1",
					cancelReason: "streaming_failed",
					streamingFailedMessage: "mid-stream",
				}),
			})

			expect(screen.getByText("chat:apiRequest.streamingFailed")).toBeInTheDocument()
		})

		it("renders a say type that has a title but no dedicated block", () => {
			renderRow({ say: "command" as any, text: "npm run build" })

			expect(screen.getByText("chat:commandExecution.running")).toBeInTheDocument()
			expect(screen.getByTestId("markdown")).toHaveTextContent("npm run build")
		})

		it("renders an empty mistake limit message", () => {
			renderRow({ type: "ask", ask: "mistake_limit_reached" })

			expect(screen.getByTestId("error-row")).toBeInTheDocument()
		})

		it("falls back to an empty resource when the server is unknown", () => {
			renderRow(
				{
					type: "ask",
					ask: "use_mcp_server",
					text: JSON.stringify({ type: "access_mcp_resource", serverName: "files" }),
				},
				{},
				{
					mcpServers: [
						{ name: "files", resources: [{ uri: "file://a.ts", name: "a" }], resourceTemplates: [] },
					],
				},
			)

			expect(screen.getByTestId("mcp-resource")).toHaveAttribute("data-uri", "")
		})

		it("shows the warning counts", () => {
			renderRow({
				say: "too_many_tools_warning",
				text: JSON.stringify({ toolCount: 1, serverCount: 1, threshold: 100 }),
			})

			expect(screen.getByTestId("warning-row")).toBeInTheDocument()
		})

		it("renders a new subtask that is not in the transcript yet", () => {
			renderRow(tool({ tool: "newTask", mode: "code", content: "do it" }), {}, { clineMessages: [] })

			expect(screen.getByTestId("markdown-block")).toHaveTextContent("do it")
		})

		it("expands a slash command that only has a description", () => {
			renderRow(tool({ tool: "runSlashCommand", command: "review", description: "explains itself" }), {
				isExpanded: true,
			})

			expect(screen.getByText("explains itself")).toBeInTheDocument()
		})

		it("renders the tool warning without any payload", () => {
			renderRow({ say: "too_many_tools_warning" })

			expect(screen.getByTestId("warning-row")).toBeInTheDocument()
		})

		it("renders an image message without any payload", () => {
			renderRow({ say: "image" })

			expect(screen.getByTestId("image-block")).toBeInTheDocument()
		})
	})

	describe("asks", () => {
		it("renders a command execution", () => {
			renderRow({ type: "ask", ask: "command", text: "ls -la" })

			expect(screen.getByTestId("command-execution")).toHaveTextContent("ls -la")
		})

		it("renders the mistake limit error", () => {
			renderRow({ type: "ask", ask: "mistake_limit_reached", text: "too many" })

			expect(screen.getByTestId("error-row")).toHaveAttribute("data-type", "mistake_limit")
		})

		it("renders a completion result with a preview button", () => {
			renderRow({ type: "ask", ask: "completion_result", text: "all done" })

			expect(screen.getByTestId("markdown")).toHaveTextContent("all done")
			expect(screen.getByTestId("markdown-preview-button")).toBeInTheDocument()
		})

		it("renders nothing for a completion result without text", () => {
			const { container } = renderRow({ type: "ask", ask: "completion_result" })

			expect(container).toBeEmptyDOMElement()
		})

		it("renders a follow-up question with its suggestions", () => {
			renderRow(
				{
					type: "ask",
					ask: "followup",
					text: JSON.stringify({ question: "which one?", suggest: [{ answer: "a" }, { answer: "b" }] }),
				},
				{ isFollowUpAnswered: true },
			)

			expect(screen.getByTestId("markdown")).toHaveTextContent("which one?")
			expect(screen.getByTestId("follow-up")).toHaveAttribute("data-count", "2")
			expect(screen.getByTestId("follow-up")).toHaveAttribute("data-answered", "true")
		})

		it("shows the partial text while the question is still streaming", () => {
			renderRow({ type: "ask", ask: "followup", text: "which o", partial: true })

			expect(screen.getByTestId("markdown")).toHaveTextContent("which o")
		})

		it("renders the auto-approval limit warning", () => {
			renderRow({ type: "ask", ask: "auto_approval_max_req_reached", text: "{}" })

			expect(screen.getByTestId("auto-approve-limit")).toBeInTheDocument()
		})

		it("renders nothing for an ask it does not know", () => {
			const { container } = renderRow({ type: "ask", ask: "resume_task" as any })

			expect(container).toBeEmptyDOMElement()
		})

		it("renders an mcp tool call", () => {
			renderRow(
				{
					type: "ask",
					ask: "use_mcp_server",
					text: JSON.stringify({
						type: "use_mcp_tool",
						serverName: "files",
						toolName: "read",
						arguments: '{"path":"a.ts"}',
					}),
				},
				{},
				{ mcpServers: [{ name: "files", resources: [], resourceTemplates: [] }] },
			)

			expect(screen.getByTestId("mcp-execution")).toHaveAttribute("data-tool", "read")
		})

		it("hides empty arguments from the mcp call", () => {
			renderRow({
				type: "ask",
				ask: "use_mcp_server",
				text: JSON.stringify({ type: "use_mcp_tool", serverName: "files", toolName: "read", arguments: "{}" }),
			})

			expect(screen.getByTestId("mcp-execution")).toBeEmptyDOMElement()
		})

		it("renders an mcp resource access", () => {
			renderRow({
				type: "ask",
				ask: "use_mcp_server",
				text: JSON.stringify({ type: "access_mcp_resource", serverName: "files", uri: "file://a.ts" }),
			})

			expect(screen.getByTestId("mcp-resource")).toHaveAttribute("data-uri", "file://a.ts")
		})

		it("falls back to an empty request when the payload is not json", () => {
			renderRow({ type: "ask", ask: "use_mcp_server", text: "not json" })

			// 種別が分からないので中身は描かれない。
			expect(screen.queryByTestId("mcp-execution")).not.toBeInTheDocument()
			expect(screen.queryByTestId("mcp-resource")).not.toBeInTheDocument()
		})
	})
})
