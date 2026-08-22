// npx vitest run src/components/chat/__tests__/ChatView.wiring.spec.tsx

import React from "react"
import { render, screen, act, fireEvent } from "@/utils/test-utils"

import type { ClineMessage } from "@openai-agent/types"

import { vscode } from "@src/utils/vscode"

import ChatView, { type ChatViewRef } from "../ChatView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const extensionState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState.current,
}))

const selectedModel = vi.hoisted(() => ({ current: { supportsImages: true } as Record<string, unknown> | undefined }))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: selectedModel.current }),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, disabled, className, "aria-label": ariaLabel }: any) => (
		<button onClick={onClick} disabled={disabled} className={className} aria-label={ariaLabel}>
			{children}
		</button>
	),
	StandardTooltip: ({ children, content }: any) => <div data-tooltip={content ?? "none"}>{children}</div>,
}))

vi.mock("react-virtuoso", () => ({
	Virtuoso: React.forwardRef(function MockVirtuoso(
		{ data, itemContent, atBottomStateChange, followOutput }: any,
		ref: React.Ref<unknown>,
	) {
		React.useImperativeHandle(ref, () => ({
			scrollToIndex: (options: unknown) => virtuosoCalls.scrollToIndex.push(options),
			scrollTo: (options: unknown) => virtuosoCalls.scrollTo.push(options),
		}))
		return (
			<div data-testid="virtuoso">
				<button data-testid="virtuoso-at-bottom" onClick={() => atBottomStateChange(true)} />
				<button data-testid="virtuoso-left-bottom" onClick={() => atBottomStateChange(false)} />
				<button data-testid="virtuoso-follow" onClick={() => followOutput(true)} />
				{data.map((item: ClineMessage, index: number) => (
					<div key={item.ts}>{itemContent(index, item)}</div>
				))}
			</div>
		)
	}),
}))

const virtuosoCalls = { scrollToIndex: [] as unknown[], scrollTo: [] as unknown[] }

vi.mock("../ChatRow", () => ({
	__esModule: true,
	default: ({
		message,
		isExpanded,
		editable,
		hasCheckpoint,
		isFollowUpAnswered,
		isFollowUpAutoApprovalPaused,
		isLast,
		onToggleExpand,
		onSuggestionClick,
		onBatchFileResponse,
		onFollowUpUnmount,
		onJumpToPreviousCheckpoint,
		onHeightChange,
	}: any) => (
		<div
			data-testid={`chat-row-${message.ts}`}
			data-expanded={String(isExpanded)}
			data-editable={String(editable)}
			data-has-checkpoint={String(hasCheckpoint)}
			data-answered={String(isFollowUpAnswered)}
			data-paused={String(isFollowUpAutoApprovalPaused)}
			data-last={String(isLast)}>
			<button data-testid={`row-${message.ts}-expand`} onClick={() => onToggleExpand(message.ts)} />
			<button
				data-testid={`row-${message.ts}-suggest`}
				onClick={(event) => onSuggestionClick({ answer: "picked" }, event)}
			/>
			<button
				data-testid={`row-${message.ts}-suggest-shift`}
				onClick={(event) => onSuggestionClick({ answer: "appended" }, { ...event, shiftKey: true })}
			/>
			<button
				data-testid={`row-${message.ts}-suggest-mode`}
				onClick={(event) => onSuggestionClick({ answer: "with mode", mode: "architect" }, event)}
			/>
			<button
				data-testid={`row-${message.ts}-suggest-auto`}
				onClick={() => onSuggestionClick({ answer: "auto", mode: "architect" })}
			/>
			<button data-testid={`row-${message.ts}-batch`} onClick={() => onBatchFileResponse({ "a.ts": true })} />
			<button data-testid={`row-${message.ts}-unmount`} onClick={() => onFollowUpUnmount()} />
			<button data-testid={`row-${message.ts}-jump`} onClick={() => onJumpToPreviousCheckpoint()} />
			<button data-testid={`row-${message.ts}-height`} onClick={() => onHeightChange(true)} />
		</div>
	),
}))

vi.mock("../ChatTextArea", () => {
	const ChatTextArea = React.forwardRef(function MockChatTextArea(props: any, ref: React.Ref<unknown>) {
		React.useImperativeHandle(ref, () => ({ focus: textAreaFocus }))
		return (
			<div
				data-testid="chat-textarea"
				data-sending-disabled={String(props.sendingDisabled)}
				data-select-config-disabled={String(props.selectApiConfigDisabled)}
				data-placeholder={props.placeholderText}
				data-images-disabled={String(props.shouldDisableImages)}
				data-streaming={String(props.isStreaming)}
				data-mode={props.mode}
				data-images={props.selectedImages.join(",")}
				data-value={props.inputValue}
				data-shortcut={props.modeShortcutText}>
				<input value={props.inputValue} onChange={(event) => props.setInputValue(event.target.value)} />
				<button data-testid="textarea-send" onClick={props.onSend} />
				<button data-testid="textarea-stop" onClick={props.onStop} />
				<button data-testid="textarea-enqueue" onClick={props.onEnqueueMessage} />
				<button data-testid="textarea-select-images" onClick={props.onSelectImages} />
				<button data-testid="textarea-height" onClick={props.onHeightChange} />
			</div>
		)
	})
	return { __esModule: true, ChatTextArea, default: ChatTextArea }
})

const textAreaFocus = vi.fn()

vi.mock("../TaskHeader", () => ({
	__esModule: true,
	default: ({
		task,
		aggregatedCost,
		hasSubtasks,
		costBreakdown,
		todos,
		buttonsDisabled,
		handleCondenseContext,
	}: any) => (
		<div
			data-testid="task-header"
			data-task={task.ts}
			data-aggregated-cost={String(aggregatedCost)}
			data-has-subtasks={String(hasSubtasks)}
			data-cost-breakdown={costBreakdown ?? "none"}
			data-todos={todos ? todos.map((todo: any) => todo.content).join(",") : "none"}
			data-buttons-disabled={String(buttonsDisabled)}>
			<button data-testid="condense" onClick={() => handleCondenseContext("task-1")} />
		</div>
	),
}))

vi.mock("../QueuedMessages", () => ({
	QueuedMessages: ({ queue, onRemove, onUpdate }: any) => (
		<div data-testid="queued-messages" data-count={queue.length}>
			<button data-testid="queue-remove" onClick={() => onRemove(0)} />
			<button data-testid="queue-remove-missing" onClick={() => onRemove(99)} />
			<button data-testid="queue-update" onClick={() => onUpdate(0, "edited")} />
			<button data-testid="queue-update-missing" onClick={() => onUpdate(99, "edited")} />
		</div>
	),
}))

vi.mock("../WorktreeSelector", () => ({ WorktreeSelector: () => <div data-testid="worktree-selector" /> }))
vi.mock("../FileChangesPanel", () => ({ __esModule: true, default: () => <div data-testid="file-changes" /> }))
vi.mock("../ProfileViolationWarning", () => ({
	__esModule: true,
	default: () => <div data-testid="profile-warning" />,
}))
vi.mock("../CheckpointWarning", () => ({
	CheckpointWarning: ({ warning }: any) => <div data-testid="checkpoint-warning">{warning}</div>,
}))
vi.mock("@src/components/welcome/AgentHero", () => ({ __esModule: true, default: () => <div data-testid="hero" /> }))
vi.mock("../../history/HistoryPreview", () => ({
	__esModule: true,
	default: () => <div data-testid="history-preview" />,
}))
vi.mock("../../common/VersionIndicator", () => ({
	__esModule: true,
	default: () => <div data-testid="version-indicator" />,
}))

const task = (overrides: Partial<ClineMessage> = {}): ClineMessage =>
	({ ts: 1000, type: "say", say: "text", text: "the task", ...overrides }) as ClineMessage

const setState = (state: Record<string, unknown>) => {
	extensionState.current = {
		clineMessages: [],
		taskHistory: [],
		currentTaskItem: undefined,
		currentTaskTodos: undefined,
		apiConfiguration: { apiProvider: "openai" },
		organizationAllowList: { allowAll: true, providers: {} },
		mode: "code",
		setMode: vi.fn(),
		customModes: [],
		messageQueue: [],
		showWorktreesInHomeScreen: false,
		...state,
	}
}

const renderChatView = (state: Record<string, unknown> = {}, props: { isHidden?: boolean } = {}) => {
	setState(state)
	const ref = React.createRef<ChatViewRef>()
	const utils = render(<ChatView ref={ref} isHidden={props.isHidden ?? false} />)
	return { ref, ...utils }
}

const posted = () => (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message)

const post = (data: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})
}

const textArea = () => screen.getByTestId("chat-textarea")

/** API リクエスト実行中（コスト未確定）のタスク。sendingDisabled/isStreaming が真になる。 */
const withBusyTask = () => ({
	clineMessages: [
		task(),
		{ ts: 1001, type: "say", say: "api_req_started", text: JSON.stringify({ request: "x" }) } as ClineMessage,
	],
})

const type = (value: string) => {
	fireEvent.change(textArea().querySelector("input")!, { target: { value } })
}

describe("ChatView wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		virtuosoCalls.scrollToIndex.length = 0
		virtuosoCalls.scrollTo.length = 0
		selectedModel.current = { supportsImages: true }
	})

	describe("welcome screen", () => {
		it("shows the hero and hides the task chrome", () => {
			renderChatView()

			expect(screen.getByTestId("hero")).toBeInTheDocument()
			expect(screen.queryByTestId("history-preview")).not.toBeInTheDocument()
			expect(screen.queryByTestId("task-header")).not.toBeInTheDocument()
			expect(screen.queryByTestId("worktree-selector")).not.toBeInTheDocument()
		})

		it("shows the history preview once there is history", () => {
			renderChatView({ taskHistory: [{ id: "1" }] })

			expect(screen.getByTestId("history-preview")).toBeInTheDocument()
		})

		it("shows the worktree selector when the setting is on", () => {
			renderChatView({ showWorktreesInHomeScreen: true })

			expect(screen.getByTestId("worktree-selector")).toBeInTheDocument()
		})

		it("starts a new task with the typed message", () => {
			renderChatView()

			type("build me a thing")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(posted()).toContainEqual({ type: "newTask", text: "build me a thing", images: [] })
		})

		it("ignores an empty send", () => {
			renderChatView()

			type("   ")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(posted()).toHaveLength(0)
		})
	})

	describe("ask flows", () => {
		const withAsk = (ask: string, extra: Partial<ClineMessage> = {}) => ({
			clineMessages: [task(), { ts: 1001, type: "ask", ask, text: "", ...extra } as ClineMessage],
		})

		it("shows the retry buttons for a failed api request", () => {
			renderChatView(withAsk("api_req_failed"))

			expect(screen.getByText("chat:retry.title")).toBeInTheDocument()
			expect(screen.getByText("chat:startNewTask.title")).toBeInTheDocument()
		})

		it("approves a tool without feedback", () => {
			renderChatView(withAsk("tool", { text: JSON.stringify({ tool: "readFile" }) }))

			fireEvent.click(screen.getByText("chat:approve.title"))

			expect(posted()).toContainEqual({ type: "askResponse", askResponse: "yesButtonClicked" })
			expect(screen.queryByText("chat:approve.title")).not.toBeInTheDocument()
		})

		it("approves a tool with the typed feedback", () => {
			renderChatView(withAsk("tool", { text: JSON.stringify({ tool: "readFile" }) }))

			type("  go ahead  ")
			fireEvent.click(screen.getByText("chat:approve.title"))

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "yesButtonClicked",
				text: "go ahead",
				images: [],
			})
			expect(textArea().querySelector("input")).toHaveValue("")
		})

		it("rejects a tool with the typed feedback", () => {
			renderChatView(withAsk("tool", { text: JSON.stringify({ tool: "readFile" }) }))

			type("no thanks")
			fireEvent.click(screen.getByText("chat:reject.title"))

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "noButtonClicked",
				text: "no thanks",
				images: [],
			})
		})

		it("rejects a tool without feedback", () => {
			renderChatView(withAsk("tool", { text: JSON.stringify({ tool: "readFile" }) }))

			fireEvent.click(screen.getByText("chat:reject.title"))

			expect(posted()).toContainEqual({ type: "askResponse", askResponse: "noButtonClicked" })
		})

		it("starts a new task instead of retrying", () => {
			renderChatView(withAsk("api_req_failed"))

			fireEvent.click(screen.getByText("chat:startNewTask.title"))

			expect(posted()).toContainEqual({ type: "clearTask" })
		})

		it("starts a new task from a completion result", () => {
			renderChatView(withAsk("completion_result"))

			fireEvent.click(screen.getByText("chat:startNewTask.title"))

			expect(posted()).toContainEqual({ type: "clearTask" })
		})

		it("continues and aborts a running command", () => {
			renderChatView(withAsk("command_output"))

			fireEvent.click(screen.getByText("chat:proceedWhileRunning.title"))
			expect(posted()).toContainEqual({ type: "terminalOperation", terminalOperation: "continue" })
		})

		it("kills a running command", () => {
			renderChatView(withAsk("command_output"))

			fireEvent.click(screen.getByText("chat:killCommand.title"))
			expect(posted()).toContainEqual({ type: "terminalOperation", terminalOperation: "abort" })
		})

		it("resumes a task", () => {
			renderChatView(withAsk("resume_task"))

			fireEvent.click(screen.getByText("chat:resumeTask.title"))

			expect(posted()).toContainEqual({ type: "askResponse", askResponse: "yesButtonClicked" })
		})

		it("resumes a task carrying the typed feedback", () => {
			renderChatView(withAsk("resume_task"))

			type("keep going")
			fireEvent.click(screen.getByText("chat:resumeTask.title"))

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "yesButtonClicked",
				text: "keep going",
				images: [],
			})
		})

		it("starts a new task when the finished subtask is resumed", () => {
			renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "say", say: "completion_result", text: "done" } as ClineMessage,
					{ ts: 1002, type: "ask", ask: "resume_task", text: "" } as ClineMessage,
				],
				currentTaskItem: { id: "child", parentTaskId: "parent" },
			})

			fireEvent.click(screen.getByText("chat:startNewTask.title"))

			expect(posted()).toContainEqual({ type: "clearTask" })
		})

		it("abandons the task from the secondary button when resuming", () => {
			renderChatView(withAsk("resume_task"))

			fireEvent.click(screen.getByText("chat:terminate.title"))

			expect(posted()).toContainEqual({ type: "clearTask" })
		})

		it("starts a new task when a completed task is resumed", () => {
			renderChatView(withAsk("resume_completed_task"))

			fireEvent.click(screen.getByText("chat:startNewTask.title"))

			expect(posted()).toContainEqual({ type: "clearTask" })
		})

		it("proceeds anyway after too many mistakes", () => {
			renderChatView(withAsk("mistake_limit_reached"))

			type("try again")
			fireEvent.click(screen.getByText("chat:proceedAnyways.title"))

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "yesButtonClicked",
				text: "try again",
				images: [],
			})
		})

		it("gives up after too many mistakes", () => {
			renderChatView(withAsk("mistake_limit_reached"))

			fireEvent.click(screen.getByText("chat:startNewTask.title"))

			expect(posted()).toContainEqual({ type: "clearTask" })
		})

		it("runs and rejects a command", () => {
			renderChatView(withAsk("command", { text: "ls -la" }))

			fireEvent.click(screen.getByText("chat:runCommand.title"))
			expect(posted()).toContainEqual({ type: "askResponse", askResponse: "yesButtonClicked" })
		})

		it("approves and rejects an mcp server call", () => {
			renderChatView(withAsk("use_mcp_server", { text: "{}" }))

			fireEvent.click(screen.getByText("chat:approve.title"))
			expect(posted()).toContainEqual({ type: "askResponse", askResponse: "yesButtonClicked" })
		})

		it("answers a followup through the text area", () => {
			renderChatView(withAsk("followup"))

			type("my answer")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "my answer",
				images: [],
			})
		})

		it("marks the question as answered when the reply is typed instead of picked", () => {
			renderChatView(withAsk("followup"))

			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-answered", "false")

			type("typed answer")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-answered", "true")
		})

		it("sends a plain message when no ask is pending", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "say", say: "text", text: "hi" } as ClineMessage],
			})

			type("another message")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "another message",
				images: [],
			})
		})

		it("pauses auto approval while the user types an answer", () => {
			renderChatView(withAsk("followup"))

			type("thinking...")

			expect(posted()).toContainEqual({ type: "cancelAutoApproval" })
			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-paused", "true")
		})
	})

	describe("queueing", () => {
		it("queues while the task is busy", () => {
			renderChatView(withBusyTask())

			type("queued text")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(posted()).toContainEqual({ type: "queueMessage", text: "queued text", images: [] })
			expect(textArea().querySelector("input")).toHaveValue("")
		})

		it("queues while other messages are already queued", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "followup", text: "" } as ClineMessage],
				messageQueue: [{ id: "q1", text: "first", images: [] }],
			})

			type("second")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(posted()).toContainEqual({ type: "queueMessage", text: "second", images: [] })
		})

		it("queues instead of talking to the terminal", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "command_output", text: "" } as ClineMessage],
			})

			type("for the model")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(posted()).toContainEqual({ type: "queueMessage", text: "for the model", images: [] })
		})

		it("keeps the text when queueing fails", () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {})
			renderChatView(withBusyTask())
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
				throw new Error("bridge down")
			})

			type("queued text")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(error).toHaveBeenCalledWith(expect.stringContaining("bridge down"))
			error.mockRestore()
		})

		it("enqueues the current message on demand", () => {
			renderChatView({ clineMessages: [task()] })

			type("hold this")
			fireEvent.click(screen.getByTestId("textarea-enqueue"))

			expect(posted()).toContainEqual({ type: "queueMessage", text: "hold this", images: [] })
			expect(textArea().querySelector("input")).toHaveValue("")
		})

		it("ignores an empty enqueue", () => {
			renderChatView({ clineMessages: [task()] })

			fireEvent.click(screen.getByTestId("textarea-enqueue"))

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "queueMessage" }))
		})

		it("removes and edits queued messages, ignoring unknown rows", () => {
			renderChatView({
				clineMessages: [task()],
				messageQueue: [{ id: "q1", text: "first", images: ["img"] }],
			})

			fireEvent.click(screen.getByTestId("queue-remove"))
			expect(posted()).toContainEqual({ type: "removeQueuedMessage", text: "q1" })

			fireEvent.click(screen.getByTestId("queue-update"))
			expect(posted()).toContainEqual({
				type: "editQueuedMessage",
				payload: { id: "q1", text: "edited", images: ["img"] },
			})
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockClear()

			fireEvent.click(screen.getByTestId("queue-remove-missing"))
			fireEvent.click(screen.getByTestId("queue-update-missing"))
			expect(posted()).toHaveLength(0)
		})
	})

	describe("extension messages", () => {
		it("focuses the input when the webview becomes visible", () => {
			renderChatView({ clineMessages: [task()] })
			textAreaFocus.mockClear()

			post({ type: "action", action: "didBecomeVisible" })

			expect(textAreaFocus).toHaveBeenCalled()
		})

		it("does not steal focus while a question is waiting", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "followup", text: "" } as ClineMessage],
			})
			textAreaFocus.mockClear()

			post({ type: "action", action: "didBecomeVisible" })

			expect(textAreaFocus).not.toHaveBeenCalled()
		})

		it("does not steal focus while hidden", () => {
			renderChatView({ clineMessages: [task()] }, { isHidden: true })
			textAreaFocus.mockClear()

			post({ type: "action", action: "didBecomeVisible" })

			expect(textAreaFocus).not.toHaveBeenCalled()
		})

		it("focuses on request", () => {
			renderChatView({ clineMessages: [task()] }, { isHidden: true })
			textAreaFocus.mockClear()

			post({ type: "action", action: "focusInput" })

			expect(textAreaFocus).toHaveBeenCalled()
		})

		it("ignores unknown actions", () => {
			renderChatView({ clineMessages: [task()] })
			textAreaFocus.mockClear()

			post({ type: "action", action: "settingsButtonClicked" })

			expect(textAreaFocus).not.toHaveBeenCalled()
		})

		it("adds selected images unless they belong to an edit", () => {
			renderChatView({ clineMessages: [task()] })

			post({ type: "selectedImages", images: ["data:image/png;base64,A"] })
			expect(textArea()).toHaveAttribute("data-images", "data:image/png;base64,A")

			post({ type: "selectedImages", images: ["data:image/png;base64,B"], context: "edit" })
			expect(textArea()).toHaveAttribute("data-images", "data:image/png;base64,A")
		})

		it("resets the chat on newChat", () => {
			renderChatView({ clineMessages: [task()] })
			type("draft")

			post({ type: "invoke", invoke: "newChat" })

			expect(textArea().querySelector("input")).toHaveValue("")
		})

		it("sends, fills and clicks through invoke", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "followup", text: "" } as ClineMessage],
			})

			post({ type: "invoke", invoke: "setChatBoxMessage", text: "prefilled" })
			expect(textArea().querySelector("input")).toHaveValue("prefilled")

			post({ type: "invoke", invoke: "setChatBoxMessage", text: "more" })
			expect(textArea().querySelector("input")).toHaveValue("prefilled more")

			post({ type: "invoke", invoke: "sendMessage", text: "sent" })
			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "sent",
				images: [],
			})
		})

		it("clicks the buttons through invoke", () => {
			renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile" }) } as ClineMessage,
				],
			})

			post({ type: "invoke", invoke: "primaryButtonClick" })
			expect(posted()).toContainEqual({ type: "askResponse", askResponse: "yesButtonClicked" })
		})

		it("clicks the secondary button through invoke", () => {
			renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile" }) } as ClineMessage,
				],
			})

			post({ type: "invoke", invoke: "secondaryButtonClick", text: "nope" })
			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "noButtonClicked",
				text: "nope",
				images: [],
			})
		})

		it("ignores an unknown invoke", () => {
			renderChatView({ clineMessages: [task()] })

			post({ type: "invoke", invoke: "somethingElse" })

			expect(posted()).toHaveLength(0)
		})

		it("shows and clears the checkpoint warning", () => {
			renderChatView({ clineMessages: [task()] })

			post({ type: "checkpointInitWarning", checkpointWarning: "slow checkpoint" })
			expect(screen.getByTestId("checkpoint-warning")).toHaveTextContent("slow checkpoint")

			post({ type: "checkpointInitWarning" })
			expect(screen.queryByTestId("checkpoint-warning")).not.toBeInTheDocument()
		})

		it("shows the aggregated costs of a task with subtasks", () => {
			renderChatView({ clineMessages: [task()], currentTaskItem: { id: "task-1" } })

			post({
				type: "taskWithAggregatedCosts",
				text: "task-1",
				aggregatedCosts: { totalCost: 1.5, childrenCost: 0.5, ownCost: 1 },
			})

			const header = screen.getByTestId("task-header")
			expect(header).toHaveAttribute("data-aggregated-cost", "1.5")
			expect(header).toHaveAttribute("data-has-subtasks", "true")
			expect(header.getAttribute("data-cost-breakdown")).not.toBe("none")
		})

		it("ignores aggregated costs without a payload", () => {
			renderChatView({ clineMessages: [task()], currentTaskItem: { id: "task-1" } })

			post({ type: "taskWithAggregatedCosts", text: "task-1" })

			expect(screen.getByTestId("task-header")).toHaveAttribute("data-aggregated-cost", "undefined")
		})

		it("asks for the aggregated costs of a task that has children", () => {
			renderChatView({
				clineMessages: [task()],
				currentTaskItem: { id: "task-1", childIds: ["child"] },
			})

			expect(posted()).toContainEqual({ type: "getTaskWithAggregatedCosts", text: "task-1" })
		})

		it("ignores messages it does not know", () => {
			renderChatView({ clineMessages: [task()] })

			post({ type: "somethingUnrelated" })

			expect(posted()).toHaveLength(0)
		})
	})

	describe("condensing", () => {
		it("requests condensation once and re-enables sending when it finishes", () => {
			renderChatView({ clineMessages: [task()] })

			fireEvent.click(screen.getByTestId("condense"))
			expect(posted()).toContainEqual({ type: "condenseTaskContextRequest", text: "task-1" })
			expect(textArea()).toHaveAttribute("data-sending-disabled", "true")
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockClear()

			fireEvent.click(screen.getByTestId("condense"))
			expect(posted()).toHaveLength(0)

			post({ type: "condenseTaskContextResponse", text: "task-1" })
			expect(textArea()).toHaveAttribute("data-sending-disabled", "false")
		})

		it("marks automatic condensation without disabling sending", () => {
			renderChatView({ clineMessages: [task()] })

			post({ type: "condenseTaskContextStarted", text: "task-1" })
			expect(textArea()).toHaveAttribute("data-sending-disabled", "false")

			post({ type: "condenseTaskContextResponse", text: "task-1" })
			expect(textArea()).toHaveAttribute("data-sending-disabled", "false")
		})

		it("ignores condensation messages without a task id", () => {
			renderChatView({ clineMessages: [task()] })

			post({ type: "condenseTaskContextStarted" })
			post({ type: "condenseTaskContextResponse" })

			expect(textArea()).toHaveAttribute("data-sending-disabled", "false")
		})
	})

	describe("acceptInput", () => {
		it("presses the primary button when one is offered", () => {
			const { ref } = renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile" }) } as ClineMessage,
				],
			})

			act(() => ref.current!.acceptInput())

			expect(posted()).toContainEqual({ type: "askResponse", askResponse: "yesButtonClicked" })
		})

		it("sends the typed message when no button is offered", () => {
			const { ref } = renderChatView({ clineMessages: [] })

			type("brand new task")
			act(() => ref.current!.acceptInput())

			expect(posted()).toContainEqual({ type: "newTask", text: "brand new task", images: [] })
		})

		it("queues the message instead of continuing a running command", () => {
			const { ref } = renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "command_output", text: "" } as ClineMessage],
			})

			type("for later")
			act(() => ref.current!.acceptInput())

			expect(posted()).toContainEqual({ type: "queueMessage", text: "for later", images: [] })
			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "terminalOperation" }))
		})

		it("does nothing without input", () => {
			const { ref } = renderChatView({ clineMessages: [task()] })

			act(() => ref.current!.acceptInput())

			expect(posted()).toHaveLength(0)
		})
	})

	describe("rows", () => {
		const withRows = (extra: Record<string, unknown> = {}) => ({
			clineMessages: [
				task(),
				{ ts: 1001, type: "say", say: "text", text: "hello" } as ClineMessage,
				{ ts: 1002, type: "say", say: "text", text: "world" } as ClineMessage,
			],
			...extra,
		})

		it("expands and collapses a row", () => {
			renderChatView(withRows())

			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-expanded", "false")

			fireEvent.click(screen.getByTestId("row-1001-expand"))
			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-expanded", "true")

			fireEvent.click(screen.getByTestId("row-1001-expand"))
			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-expanded", "false")
		})

		it("marks the last row", () => {
			renderChatView(withRows())

			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-last", "false")
			expect(screen.getByTestId("chat-row-1002")).toHaveAttribute("data-last", "true")
		})

		it("reports the height changes to the scroll lifecycle", () => {
			renderChatView(withRows())

			fireEvent.click(screen.getByTestId("row-1001-height"))

			expect(screen.getByTestId("chat-row-1001")).toBeInTheDocument()
		})

		it("answers a batch file question", () => {
			renderChatView(withRows())

			fireEvent.click(screen.getByTestId("row-1001-batch"))

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "objectResponse",
				text: JSON.stringify({ "a.ts": true }),
			})
		})

		it("cancels the backend auto approval when a follow-up unmounts", () => {
			renderChatView(withRows())

			fireEvent.click(screen.getByTestId("row-1001-unmount"))

			expect(posted()).toContainEqual({ type: "cancelAutoApproval" })
		})

		it("tells the rows whether a checkpoint exists", () => {
			renderChatView(withRows())
			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-has-checkpoint", "false")

			renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "say", say: "checkpoint_saved", text: "abc" } as ClineMessage,
				],
			})
			expect(screen.getAllByTestId("chat-row-1001")[1]).toHaveAttribute("data-has-checkpoint", "true")
		})

		it("makes a todo-list tool row editable only while its buttons are live", () => {
			renderChatView({
				clineMessages: [
					task(),
					{
						ts: 1001,
						type: "ask",
						ask: "tool",
						text: JSON.stringify({ tool: "updateTodoList" }),
					} as ClineMessage,
				],
			})

			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-editable", "true")
		})

		it("recognises a todo-list tool even when the payload is not valid json", () => {
			renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "ask", ask: "tool", text: "not json updateTodoList" } as ClineMessage,
				],
			})

			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-editable", "true")
		})

		it("leaves other tool rows read-only", () => {
			renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile" }) } as ClineMessage,
				],
			})

			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-editable", "false")
		})
	})

	describe("suggestions", () => {
		const followupState = (extra: Record<string, unknown> = {}) => ({
			clineMessages: [task(), { ts: 1001, type: "ask", ask: "followup", text: "" } as ClineMessage],
			...extra,
		})

		it("sends the picked answer and keeps the draft", () => {
			renderChatView(followupState())

			type("my draft")
			fireEvent.click(screen.getByTestId("row-1001-suggest"))

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "picked",
				images: [],
			})
			expect(textArea().querySelector("input")).toHaveValue("my draft")
			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-answered", "true")
		})

		it("appends the answer to the draft when shift is held", () => {
			renderChatView(followupState())

			fireEvent.click(screen.getByTestId("row-1001-suggest-shift"))
			expect(textArea().querySelector("input")).toHaveValue("appended")

			fireEvent.click(screen.getByTestId("row-1001-suggest-shift"))
			// input 要素は改行を落とすので、生の値は data 属性側で確かめる。
			expect(textArea()).toHaveAttribute("data-value", "appended \nappended")
		})

		it("switches mode when the user picks a suggestion that carries one", () => {
			const setMode = vi.fn()
			renderChatView(followupState({ setMode }))

			fireEvent.click(screen.getByTestId("row-1001-suggest-mode"))

			expect(setMode).toHaveBeenCalledWith("architect")
			expect(posted()).toContainEqual({ type: "mode", text: "architect" })
		})

		it("自動承認の経路ではモードを切り替えない（切替はユーザーのクリックのみ）", () => {
			const setMode = vi.fn()
			renderChatView(followupState({ setMode }))

			fireEvent.click(screen.getByTestId("row-1001-suggest-auto"))

			expect(setMode).not.toHaveBeenCalled()
		})
	})

	describe("checkpoints", () => {
		const withCheckpoints = () => ({
			clineMessages: [
				task(),
				{ ts: 1001, type: "say", say: "checkpoint_saved", text: "a" } as ClineMessage,
				{ ts: 1002, type: "say", say: "text", text: "middle" } as ClineMessage,
				{ ts: 1003, type: "say", say: "checkpoint_saved", text: "b" } as ClineMessage,
			],
		})

		/** スクロール制御が出す "LAST" 指定を除いた、チェックポイントジャンプだけ。 */
		const numericJumps = () =>
			(virtuosoCalls.scrollToIndex as Array<{ index: number | string }>)
				.filter((call) => typeof call.index === "number")
				.map((call) => call.index as number)

		it("walks backwards through the checkpoints", () => {
			renderChatView(withCheckpoints())

			fireEvent.click(screen.getByTestId("row-1002-jump"))
			fireEvent.click(screen.getByTestId("row-1002-jump"))

			const jumps = numericJumps()
			expect(jumps).toHaveLength(2)
			expect(jumps[0]).toBeGreaterThan(jumps[1])
		})

		it("keeps the position while unrelated messages keep arriving", () => {
			const { rerender } = renderChatView(withCheckpoints())

			fireEvent.click(screen.getByTestId("row-1002-jump"))
			fireEvent.click(screen.getByTestId("row-1002-jump"))
			const beforeUpdate = numericJumps().at(-1)

			// ストリーミング中は無関係なメッセージが次々に届く。
			setState({
				clineMessages: [
					task(),
					{ ts: 1001, type: "say", say: "checkpoint_saved", text: "a" } as ClineMessage,
					{ ts: 1002, type: "say", say: "text", text: "middle" } as ClineMessage,
					{ ts: 1003, type: "say", say: "checkpoint_saved", text: "b" } as ClineMessage,
					{ ts: 1004, type: "say", say: "text", text: "more output" } as ClineMessage,
				],
			})
			rerender(<ChatView isHidden={false} />)

			fireEvent.click(screen.getByTestId("row-1002-jump"))

			// 最古まで遡ったあとなので、そこに留まる（最新へ戻らない）。
			expect(numericJumps().at(-1)).toBe(beforeUpdate)
		})

		it("starts over when a new checkpoint appears", () => {
			const { rerender } = renderChatView(withCheckpoints())

			fireEvent.click(screen.getByTestId("row-1002-jump"))
			fireEvent.click(screen.getByTestId("row-1002-jump"))
			const oldest = numericJumps().at(-1)!

			setState({
				clineMessages: [
					task(),
					{ ts: 1001, type: "say", say: "checkpoint_saved", text: "a" } as ClineMessage,
					{ ts: 1002, type: "say", say: "text", text: "middle" } as ClineMessage,
					{ ts: 1003, type: "say", say: "checkpoint_saved", text: "b" } as ClineMessage,
					{ ts: 1004, type: "say", say: "checkpoint_saved", text: "c" } as ClineMessage,
				],
			})
			rerender(<ChatView isHidden={false} />)

			fireEvent.click(screen.getByTestId("row-1002-jump"))

			expect(numericJumps().at(-1)).toBeGreaterThan(oldest)
		})

		it("does nothing when the task has no checkpoint", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "say", say: "text", text: "hello" } as ClineMessage],
			})

			fireEvent.click(screen.getByTestId("row-1001-jump"))

			expect(numericJumps()).toHaveLength(0)
		})
	})

	describe("todos", () => {
		it("prefers the todos carried in the messages", () => {
			renderChatView({
				clineMessages: [
					task(),
					{
						ts: 1001,
						type: "say",
						say: "user_edit_todos",
						text: JSON.stringify({
							tool: "updateTodoList",
							todos: [{ id: "1", content: "from message", status: "pending" }],
						}),
					} as ClineMessage,
				],
				currentTaskTodos: [{ id: "0", content: "from state", status: "pending" }],
			})

			expect(screen.getByTestId("task-header")).toHaveAttribute("data-todos", "from message")
		})

		it("falls back to the todos carried in the state", () => {
			renderChatView({
				clineMessages: [task()],
				currentTaskTodos: [{ id: "0", content: "from state", status: "pending" }],
			})

			expect(screen.getByTestId("task-header")).toHaveAttribute("data-todos", "from state")
		})
	})

	describe("misc wiring", () => {
		it("asks the extension to pick images", () => {
			renderChatView({ clineMessages: [task()] })

			fireEvent.click(screen.getByTestId("textarea-select-images"))

			expect(posted()).toContainEqual({ type: "selectImages" })
		})

		it("disables images for models that cannot read them", () => {
			selectedModel.current = { supportsImages: false }
			renderChatView({ clineMessages: [task()] })

			expect(textArea()).toHaveAttribute("data-images-disabled", "true")
		})

		it("stops a running task", () => {
			renderChatView(withBusyTask())

			fireEvent.click(screen.getByTestId("textarea-stop"))

			expect(posted()).toContainEqual({ type: "cancelTask" })
		})

		it("cancels the task from the secondary button while streaming", () => {
			const { rerender } = renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile" }) } as ClineMessage,
				],
			})

			// ボタンが出たあとに部分メッセージが流れてくる（＝ストリーミング中）。
			setState({
				clineMessages: [
					task(),
					{ ts: 1001, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile" }) } as ClineMessage,
					{ ts: 1002, type: "say", say: "text", text: "streaming", partial: true } as ClineMessage,
				],
			})
			rerender(<ChatView isHidden={false} />)

			fireEvent.click(screen.getByText("chat:reject.title"))

			expect(posted()).toContainEqual({ type: "cancelTask" })
			expect(posted()).not.toContainEqual(expect.objectContaining({ askResponse: "noButtonClicked" }))
		})

		it("warns about a profile that the organization does not allow", () => {
			renderChatView({
				clineMessages: [task()],
				organizationAllowList: { allowAll: false, providers: {} },
			})

			expect(screen.getByTestId("profile-warning")).toBeInTheDocument()
			expect(textArea()).toHaveAttribute("data-sending-disabled", "true")
		})

		it("reacts to the text area growing", () => {
			renderChatView({ clineMessages: [task()] })

			fireEvent.click(screen.getByTestId("textarea-height"))

			expect(screen.getByTestId("chat-textarea")).toBeInTheDocument()
		})

		it("cycles the mode with the keyboard", () => {
			const setMode = vi.fn()
			renderChatView({ clineMessages: [task()], setMode })

			act(() => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", ctrlKey: true }))
			})
			expect(setMode).toHaveBeenCalledTimes(1)

			act(() => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", ctrlKey: true, shiftKey: true }))
			})
			expect(setMode).toHaveBeenCalledTimes(2)
			expect(setMode.mock.calls[0][0]).not.toBe(setMode.mock.calls[1][0])
		})

		it("ignores other keys", () => {
			const setMode = vi.fn()
			renderChatView({ clineMessages: [task()], setMode })

			act(() => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true }))
			})
			act(() => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "." }))
			})

			expect(setMode).not.toHaveBeenCalled()
		})

		it("clears the buttons when the task is emptied", () => {
			const { rerender } = renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile" }) } as ClineMessage,
				],
			})
			expect(screen.getByText("chat:approve.title")).toBeInTheDocument()

			setState({ clineMessages: [] })
			rerender(<ChatView isHidden={false} />)

			expect(screen.queryByText("chat:approve.title")).not.toBeInTheDocument()
		})
	})

	describe("remaining wiring", () => {
		it("retries a failed api request", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "api_req_failed", text: "" } as ClineMessage],
			})

			// 失敗中はプロファイルを選び直せる必要がある。
			expect(screen.getByTestId("chat-textarea")).toHaveAttribute("data-select-config-disabled", "false")

			fireEvent.click(screen.getByText("chat:retry.title"))

			expect(posted()).toContainEqual({ type: "askResponse", askResponse: "yesButtonClicked" })
		})

		it("rejects a command with feedback", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "command", text: "rm -rf /" } as ClineMessage],
			})

			type("absolutely not")
			fireEvent.click(screen.getByText("chat:reject.title"))

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "noButtonClicked",
				text: "absolutely not",
				images: [],
			})
		})

		it("shows the save tooltip for a file edit", () => {
			renderChatView({
				clineMessages: [
					task(),
					{
						ts: 1001,
						type: "ask",
						ask: "tool",
						text: JSON.stringify({ tool: "editedExistingFile" }),
					} as ClineMessage,
				],
			})

			expect(screen.getByText("chat:save.title").closest("[data-tooltip]")).toHaveAttribute(
				"data-tooltip",
				"chat:save.tooltip",
			)
			expect(screen.getByText("chat:reject.title").closest("[data-tooltip]")).toHaveAttribute(
				"data-tooltip",
				"chat:reject.tooltip",
			)
		})

		it("shows the tooltips of the command buttons", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "command_output", text: "" } as ClineMessage],
			})

			expect(screen.getByText("chat:proceedWhileRunning.title").closest("[data-tooltip]")).toHaveAttribute(
				"data-tooltip",
				"chat:proceedWhileRunning.tooltip",
			)
			expect(screen.getByText("chat:killCommand.title").closest("[data-tooltip]")).toHaveAttribute(
				"data-tooltip",
				"chat:killCommand.tooltip",
			)
		})

		it("shows the tooltips of the retry and terminate buttons", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "resume_task", text: "" } as ClineMessage],
			})

			expect(screen.getByText("chat:resumeTask.title").closest("[data-tooltip]")).toHaveAttribute(
				"data-tooltip",
				"chat:resumeTask.tooltip",
			)
			expect(screen.getByText("chat:terminate.title").closest("[data-tooltip]")).toHaveAttribute(
				"data-tooltip",
				"chat:terminate.tooltip",
			)
		})

		it("has no tooltip for a button it does not know", () => {
			renderChatView({
				clineMessages: [
					task(),
					{
						ts: 1001,
						type: "ask",
						ask: "tool",
						text: JSON.stringify({ tool: "finishTask" }),
					} as ClineMessage,
				],
			})

			expect(screen.getByText("chat:completeSubtaskAndReturn").closest("[data-tooltip]")).toHaveAttribute(
				"data-tooltip",
				"none",
			)
		})

		it("shows the batch tooltips as unmapped", () => {
			renderChatView({
				clineMessages: [
					task(),
					{
						ts: 1001,
						type: "ask",
						ask: "tool",
						text: JSON.stringify({ tool: "readFile", batchFiles: [] }),
					} as ClineMessage,
				],
			})

			expect(screen.getByText("chat:read-batch.deny.title").closest("[data-tooltip]")).toHaveAttribute(
				"data-tooltip",
				"none",
			)
		})

		it("reports a non-error queue failure", () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {})
			renderChatView(withBusyTask())
			;(vscode.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
				throw "plain string"
			})

			type("queued")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(error).toHaveBeenCalledWith(expect.stringContaining("plain string"))
			error.mockRestore()
		})

		it("passes the images that came with an invoke", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "followup", text: "" } as ClineMessage],
			})

			post({ type: "invoke", invoke: "setChatBoxMessage", images: ["data:image/png;base64,A"] })
			expect(textArea()).toHaveAttribute("data-images", "data:image/png;base64,A")

			post({ type: "invoke", invoke: "sendMessage", text: "go", images: ["data:image/png;base64,B"] })
			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "go",
				images: ["data:image/png;base64,B"],
			})
		})

		it("clicks the secondary button through invoke without arguments", () => {
			renderChatView({
				clineMessages: [
					task(),
					{ ts: 1001, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile" }) } as ClineMessage,
				],
			})

			post({ type: "invoke", invoke: "secondaryButtonClick" })

			expect(posted()).toContainEqual({ type: "askResponse", askResponse: "noButtonClicked" })
		})

		it("treats a tool ask without a payload as read-only", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "tool" } as ClineMessage],
			})

			expect(screen.getByTestId("chat-row-1001")).toHaveAttribute("data-editable", "false")
		})

		it("does not ask for aggregated costs when the task has no children", () => {
			renderChatView({ clineMessages: [task()], currentTaskItem: { id: "task-1", childIds: [] } })

			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "getTaskWithAggregatedCosts" }))
		})

		it("marks the followup as answered only when one exists", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "say", say: "text", text: "hi" } as ClineMessage],
			})

			type("plain message")
			fireEvent.click(screen.getByTestId("textarea-send"))

			expect(screen.queryByTestId("chat-row-1001")).toHaveAttribute("data-answered", "false")
		})
	})

	describe("platform and scrolling", () => {
		it("spells the shortcut with Ctrl outside macOS", () => {
			renderChatView({ clineMessages: [task()] })

			expect(textArea().getAttribute("data-shortcut")).toContain("Ctrl + .")
		})

		it("spells the shortcut with the command key on macOS", async () => {
			const platform = Object.getOwnPropertyDescriptor(window.navigator, "platform")
			Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true })
			vi.resetModules()

			const { default: MacChatView } = await import("../ChatView")
			setState({ clineMessages: [task()] })
			render(<MacChatView isHidden={false} />)

			expect(textArea().getAttribute("data-shortcut")).toContain("⌘ + .")

			if (platform) {
				Object.defineProperty(window.navigator, "platform", platform)
			}
		})

		it("follows the output again once the user returns to the bottom", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderChatView({
					clineMessages: [task(), { ts: 1001, type: "say", say: "text", text: "hi" } as ClineMessage],
				})

				// 起動直後のハイドレーション窓を抜けてから「最下部に居る」を通知する。
				act(() => vi.advanceTimersByTime(5000))
				fireEvent.click(screen.getByTestId("virtuoso-at-bottom"))
				fireEvent.click(screen.getByTestId("virtuoso-follow"))

				virtuosoCalls.scrollToIndex.length = 0
				fireEvent.click(screen.getByTestId("textarea-height"))
				act(() => vi.advanceTimersByTime(200))

				expect(virtuosoCalls.scrollToIndex.length).toBeGreaterThan(0)
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not chase the bottom while the user is reading history", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "say", say: "text", text: "hi" } as ClineMessage],
			})

			fireEvent.click(screen.getByTestId("virtuoso-left-bottom"))
			virtuosoCalls.scrollToIndex.length = 0

			fireEvent.click(screen.getByTestId("textarea-height"))

			expect(virtuosoCalls.scrollToIndex).toHaveLength(0)
		})

		it("sends an empty message when invoke carries no text", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "ask", ask: "followup", text: "" } as ClineMessage],
			})

			post({ type: "invoke", invoke: "sendMessage", images: ["data:image/png;base64,A"] })

			expect(posted()).toContainEqual({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "",
				images: ["data:image/png;base64,A"],
			})
		})
	})

	describe("task screen", () => {
		it("renders the task chrome and the rows", () => {
			renderChatView({
				clineMessages: [task(), { ts: 1001, type: "say", say: "text", text: "hello" }],
			})

			expect(screen.getByTestId("task-header")).toHaveAttribute("data-task", "1000")
			expect(screen.getByTestId("chat-row-1001")).toBeInTheDocument()
			expect(screen.getByTestId("file-changes")).toBeInTheDocument()
			expect(textArea()).toHaveAttribute("data-placeholder", "chat:typeMessage")
		})

		it("uses the task placeholder before a task exists", () => {
			renderChatView()

			expect(textArea()).toHaveAttribute("data-placeholder", "chat:typeTask")
		})

		it("hides everything when the view is hidden", () => {
			renderChatView({ clineMessages: [task()] }, { isHidden: true })

			expect(screen.getByTestId("chat-view").className).toBe("hidden")
		})
	})
})
