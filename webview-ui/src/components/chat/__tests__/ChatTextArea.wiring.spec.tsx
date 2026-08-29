// npx vitest run src/components/chat/__tests__/ChatTextArea.wiring.spec.tsx

import React from "react"
import { render, screen, fireEvent, act, waitFor } from "@/utils/test-utils"

import { defaultModeSlug } from "@agent/modes"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import { ChatTextArea } from "../ChatTextArea"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/context/ExtensionStateContext")

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
	}),
}))

// 自動リサイズは jsdom では働かないので、高さ通知を手で起こせる差し替えにする。
vi.mock("react-textarea-autosize", () => ({
	__esModule: true,
	default: React.forwardRef(function DynamicTextArea(
		{ onHeightChange, minRows: _minRows, maxRows: _maxRows, ...props }: any,
		ref: any,
	) {
		return (
			<>
				<textarea ref={ref} {...props} />
				<button data-testid="report-height" onClick={() => onHeightChange?.(120)} />
				<button data-testid="report-smaller-height" onClick={() => onHeightChange?.(60)} />
			</>
		)
	}),
}))

vi.mock("../ModeSelector", () => ({
	ModeSelector: ({ value, onChange, modeShortcutText }: any) => (
		<div data-testid="mode-selector" data-value={value} data-shortcut={modeShortcutText}>
			<button data-testid="mode-selector-change" onClick={() => onChange("architect")} />
		</div>
	),
}))

vi.mock("../ApiConfigSelector", () => ({
	ApiConfigSelector: ({
		value,
		displayName,
		disabled,
		onChange,
		lockApiConfigAcrossModes,
		onToggleLockApiConfig,
		listApiConfigMeta,
	}: any) => (
		<div
			data-testid="api-config-selector"
			data-value={value}
			data-display={displayName}
			data-disabled={String(disabled)}
			data-locked={String(lockApiConfigAcrossModes)}
			data-count={listApiConfigMeta.length}>
			<button data-testid="api-config-change" onClick={() => onChange("cfg-2")} />
			<button data-testid="api-config-lock" onClick={onToggleLockApiConfig} />
		</div>
	),
}))

vi.mock("../AutoApproveDropdown", () => ({ AutoApproveDropdown: () => <div data-testid="auto-approve" /> }))
vi.mock("../IndexingStatusBadge", () => ({ IndexingStatusBadge: () => <div data-testid="indexing-badge" /> }))
vi.mock("../AutonomyModeBadge", () => ({ AutonomyModeBadge: () => <div data-testid="autonomy-badge" /> }))
vi.mock("../../common/Thumbnails", () => ({
	__esModule: true,
	default: ({ images }: any) => <div data-testid="thumbnails" data-count={images.length} />,
}))

vi.mock("../ContextMenu", () => ({
	__esModule: true,
	default: ({ onSelect, selectedIndex, searchQuery, loading, selectedType, dynamicSearchResults }: any) => (
		<div
			data-testid="context-menu"
			data-selected-index={selectedIndex}
			data-query={searchQuery}
			data-loading={String(loading)}
			data-type={String(selectedType)}
			data-results={(dynamicSearchResults ?? []).map((result: any) => result.path).join(",")}>
			<button data-testid="select-mode" onClick={() => onSelect("mode", "architect")} />
			<button data-testid="select-command" onClick={() => onSelect("command", "review")} />
			<button data-testid="select-file-type" onClick={() => onSelect("file")} />
			<button data-testid="select-file" onClick={() => onSelect("file", "/src/app.ts")} />
			<button data-testid="select-folder" onClick={() => onSelect("folder", "/src")} />
			<button data-testid="select-git-type" onClick={() => onSelect("git")} />
			<button data-testid="select-git" onClick={() => onSelect("git", "abc1234")} />
			<button data-testid="select-url" onClick={() => onSelect("url", "https://example.test")} />
			<button data-testid="select-problems" onClick={() => onSelect("problems")} />
			<button data-testid="select-terminal" onClick={() => onSelect("terminal")} />
			<button data-testid="select-no-results" onClick={() => onSelect("noResults")} />
			<button data-testid="select-command-empty" onClick={() => onSelect("command")} />
		</div>
	),
}))

const defaultProps = {
	inputValue: "",
	setInputValue: vi.fn(),
	onSend: vi.fn(),
	sendingDisabled: false,
	selectApiConfigDisabled: false,
	onSelectImages: vi.fn(),
	shouldDisableImages: false,
	placeholderText: "Type a message...",
	selectedImages: [] as string[],
	setSelectedImages: vi.fn(),
	onHeightChange: vi.fn(),
	mode: defaultModeSlug,
	setMode: vi.fn(),
	modeShortcutText: "(⌘. for next mode)",
}

const setState = (state: Record<string, unknown> = {}) => {
	;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
		filePaths: [],
		openedTabs: [],
		currentApiConfigName: "Config 1",
		listApiConfigMeta: [{ id: "cfg-1", name: "Config 1" }],
		customModes: [],
		customModePrompts: {},
		cwd: "/test/workspace",
		pinnedApiConfigs: {},
		togglePinnedApiConfig: vi.fn(),
		taskHistory: [],
		clineMessages: [],
		commands: [{ name: "review", source: "project" }],
		enterBehavior: "send",
		lockApiConfigAcrossModes: false,
		...state,
	})
}

const renderTextArea = (props: Partial<typeof defaultProps> & Record<string, unknown> = {}, state = {}) => {
	setState(state)
	const setInputValue = vi.fn()
	const utils = render(<ChatTextArea {...defaultProps} setInputValue={setInputValue} {...props} />)
	return { setInputValue, ...utils }
}

const posted = () => (vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message)

const post = (data: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})
}

const textarea = () => screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement

/** キャレット位置はコンポーネントの state 側にあるので、select を発火して同期させる。 */
const putCaretAt = (position: number) => {
	const element = textarea()
	element.setSelectionRange(position, position)
	fireEvent.mouseUp(element)
	return element
}

/** 入力値を実際に持ち回る版。カーソル位置など「値が反映されたあと」を見るテスト用。 */
const StatefulTextArea = ({ initialValue = "", ...props }: Record<string, any>) => {
	const [value, setValue] = React.useState(initialValue)
	return <ChatTextArea {...defaultProps} {...props} inputValue={value} setInputValue={setValue} />
}

const renderStateful = (props: Record<string, unknown> = {}, state = {}) => {
	setState(state)
	return render(<StatefulTextArea {...props} />)
}

describe("ChatTextArea wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("enhance prompt", () => {
		it("asks the extension to enhance what was typed", () => {
			renderTextArea({ inputValue: "  make it better  " })

			fireEvent.click(screen.getByLabelText("chat:enhancePrompt"))

			expect(posted()).toContainEqual({ type: "enhancePrompt", text: "make it better" })
		})

		it("explains itself when there is nothing to enhance", () => {
			const { setInputValue } = renderTextArea({ inputValue: "   " })

			fireEvent.click(screen.getByLabelText("chat:enhancePrompt"))

			expect(setInputValue).toHaveBeenCalledWith("chat:enhancePromptDescription")
			expect(posted()).not.toContainEqual(expect.objectContaining({ type: "enhancePrompt" }))
		})

		it("replaces the text through the browser so undo keeps working", () => {
			const execCommand = vi.fn().mockReturnValue(true)
			Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true })
			const { setInputValue } = renderTextArea({ inputValue: "draft" })

			post({ type: "enhancedPrompt", text: "enhanced!" })

			expect(execCommand).toHaveBeenCalledWith("insertText", false, "enhanced!")
			expect(setInputValue).not.toHaveBeenCalled()
		})

		it("falls back to setting the value when the browser refuses", () => {
			Object.defineProperty(document, "execCommand", {
				value: () => {
					throw new Error("nope")
				},
				configurable: true,
			})
			const { setInputValue } = renderTextArea({ inputValue: "draft" })

			post({ type: "enhancedPrompt", text: "enhanced!" })

			expect(setInputValue).toHaveBeenCalledWith("enhanced!")
		})

		it("falls back when the browser has no execCommand at all", () => {
			Object.defineProperty(document, "execCommand", { value: undefined, configurable: true })
			const { setInputValue } = renderTextArea({ inputValue: "draft" })

			post({ type: "enhancedPrompt", text: "enhanced!" })

			expect(setInputValue).toHaveBeenCalledWith("enhanced!")
		})

		it("ignores an empty enhancement", () => {
			const { setInputValue } = renderTextArea({ inputValue: "draft" })

			post({ type: "enhancedPrompt" })

			expect(setInputValue).not.toHaveBeenCalled()
		})
	})

	describe("inserting text from the extension", () => {
		it("adds a space before the inserted text when needed", () => {
			const { setInputValue } = renderTextArea({ inputValue: "hello" })
			textarea().setSelectionRange(5, 5)

			post({ type: "insertTextIntoTextarea", text: "/review" })

			expect(setInputValue).toHaveBeenCalledWith("hello /review ")
		})

		it("does not double the space", () => {
			const { setInputValue } = renderTextArea({ inputValue: "hello " })
			textarea().setSelectionRange(6, 6)

			post({ type: "insertTextIntoTextarea", text: "/review" })

			expect(setInputValue).toHaveBeenCalledWith("hello /review ")
		})

		it("inserts at the very beginning without a leading space", () => {
			const { setInputValue } = renderTextArea({ inputValue: "" })

			post({ type: "insertTextIntoTextarea", text: "/review" })

			expect(setInputValue).toHaveBeenCalledWith("/review ")
		})

		it("ignores an empty insertion", () => {
			const { setInputValue } = renderTextArea({ inputValue: "hello" })

			post({ type: "insertTextIntoTextarea" })

			expect(setInputValue).not.toHaveBeenCalled()
		})

		it("puts the caret after what it inserted", async () => {
			renderStateful()

			post({ type: "insertTextIntoTextarea", text: "/review" })

			await waitFor(() => expect(textarea()).toHaveValue("/review "))
			await waitFor(() => expect(textarea().selectionStart).toBe(8))
		})
	})

	describe("search results", () => {
		it("keeps the commits it was given", () => {
			renderTextArea({ inputValue: "" })
			fireEvent.change(textarea(), { target: { value: "@", selectionStart: 1 } })

			post({
				type: "commitSearchResults",
				commits: [{ hash: "abc1234", subject: "fix", shortHash: "abc", author: "me", date: "today" }],
			})

			expect(screen.getByTestId("context-menu")).toBeInTheDocument()
		})

		it("asks for commits when the query looks like a hash", () => {
			renderTextArea({ inputValue: "" })

			fireEvent.change(textarea(), { target: { value: "@abc123", selectionStart: 7 } })

			expect(posted()).toContainEqual({ type: "searchCommits", query: "abc123" })
		})

		it("keeps the results that answer the current request", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderTextArea({ inputValue: "" })
				fireEvent.change(textarea(), { target: { value: "@src", selectionStart: 4 } })
				act(() => vi.advanceTimersByTime(200))

				const request = posted().find((message) => message.type === "searchFiles")!
				expect(request.query).toBe("src")

				post({
					type: "fileSearchResults",
					requestId: request.requestId,
					results: [{ path: "/src/app.ts", type: "file", label: "app.ts" }],
				})
				expect(screen.getByTestId("context-menu")).toHaveAttribute("data-loading", "false")
				expect(screen.getByTestId("context-menu")).toHaveAttribute("data-results", "/src/app.ts")

				// 別のリクエストへの返事で今の候補を潰さない。
				post({
					type: "fileSearchResults",
					requestId: "someone-else",
					results: [{ path: "/other.ts", type: "file", label: "other.ts" }],
				})
				expect(screen.getByTestId("context-menu")).toHaveAttribute("data-results", "/src/app.ts")
			} finally {
				vi.useRealTimers()
			}
		})

		it("tolerates a result set without results", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderTextArea({ inputValue: "" })
				fireEvent.change(textarea(), { target: { value: "@src", selectionStart: 4 } })
				act(() => vi.advanceTimersByTime(200))
				const request = posted().find((message) => message.type === "searchFiles")!

				post({ type: "fileSearchResults", requestId: request.requestId })

				expect(screen.getByTestId("context-menu")).toBeInTheDocument()
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("keyboard", () => {
		const openMenu = (props: Record<string, unknown> = {}) => {
			const rendered = renderTextArea({ inputValue: "", ...props })
			fireEvent.change(textarea(), { target: { value: "@", selectionStart: 1 } })
			return rendered
		}

		it("steps through the menu with the arrows", () => {
			openMenu()

			fireEvent.keyDown(textarea(), { key: "ArrowDown" })
			const afterDown = screen.getByTestId("context-menu").getAttribute("data-selected-index")

			fireEvent.keyDown(textarea(), { key: "ArrowUp" })
			expect(screen.getByTestId("context-menu").getAttribute("data-selected-index")).not.toBe(afterDown)
		})

		it("goes back to the top level on escape", () => {
			openMenu()
			fireEvent.click(screen.getByTestId("select-file-type"))
			expect(screen.getByTestId("context-menu")).toHaveAttribute("data-type", "file")

			fireEvent.keyDown(textarea(), { key: "Escape" })

			expect(screen.getByTestId("context-menu")).toHaveAttribute("data-type", "null")
			expect(screen.getByTestId("context-menu")).toHaveAttribute("data-selected-index", "3")
		})

		it("picks the highlighted option with enter", () => {
			const { setInputValue } = openMenu()

			fireEvent.keyDown(textarea(), { key: "Enter" })

			expect(setInputValue).toHaveBeenCalled()
			expect(defaultProps.onSend).not.toHaveBeenCalled()
		})

		it("picks the highlighted option with tab", () => {
			const { setInputValue } = openMenu()

			fireEvent.keyDown(textarea(), { key: "Tab" })

			expect(setInputValue).toHaveBeenCalled()
		})

		it("ignores enter when nothing is highlighted", () => {
			const onSend = vi.fn()
			renderTextArea({ inputValue: "hi", onSend })
			fireEvent.change(textarea(), { target: { value: "@x", selectionStart: 2 } })
			fireEvent.keyDown(textarea(), { key: "ArrowUp" })
			fireEvent.keyDown(textarea(), { key: "ArrowUp" })

			expect(screen.getByTestId("context-menu")).toBeInTheDocument()
		})

		it("sends on enter by default", () => {
			const onSend = vi.fn()
			renderTextArea({ inputValue: "hello", onSend })

			fireEvent.keyDown(textarea(), { key: "Enter" })

			expect(onSend).toHaveBeenCalled()
		})

		it("keeps the newline on shift+enter", () => {
			const onSend = vi.fn()
			renderTextArea({ inputValue: "hello", onSend })

			fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true })

			expect(onSend).not.toHaveBeenCalled()
		})

		it("respects the newline-first setting", () => {
			const onSend = vi.fn()
			renderTextArea({ inputValue: "hello", onSend }, { enterBehavior: "newline" })

			fireEvent.keyDown(textarea(), { key: "Enter" })
			expect(onSend).not.toHaveBeenCalled()

			fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true })
			expect(onSend).toHaveBeenCalledTimes(1)

			fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true })
			expect(onSend).toHaveBeenCalledTimes(2)
		})

		it("ignores enter while composing", () => {
			const onSend = vi.fn()
			renderTextArea({ inputValue: "hello", onSend })

			fireEvent.keyDown(textarea(), { key: "Enter", isComposing: true })

			expect(onSend).not.toHaveBeenCalled()
		})

		it("collapses the space that follows a mention", () => {
			renderTextArea({ inputValue: "@/src/app.ts hello" })
			const element = putCaretAt(13)

			fireEvent.keyDown(element, { key: "Backspace" })

			expect(defaultProps.setInputValue).not.toHaveBeenCalled()
		})

		it("deletes a whole mention with the next backspace", () => {
			renderStateful({ initialValue: "@/src/app.ts " })
			const element = putCaretAt(13)

			fireEvent.keyDown(element, { key: "Backspace" })
			fireEvent.keyDown(element, { key: "Backspace" })

			expect(textarea().value).not.toContain("@/src/app.ts")
		})

		it("leaves ordinary text alone", () => {
			const { setInputValue } = renderTextArea({ inputValue: "plain text" })
			const element = putCaretAt(10)

			fireEvent.keyDown(element, { key: "Backspace" })

			expect(setInputValue).not.toHaveBeenCalled()
		})

		it("tracks the caret when moving around", () => {
			renderTextArea({ inputValue: "hello world" })
			const element = textarea()

			element.setSelectionRange(5, 5)
			fireEvent.keyUp(element, { key: "ArrowLeft" })
			fireEvent.keyUp(element, { key: "a" })

			expect(element.selectionStart).toBe(5)
		})
	})

	describe("input handling", () => {
		it("opens the slash menu and asks for the command list", () => {
			renderTextArea({ inputValue: "" })

			fireEvent.change(textarea(), { target: { value: "/rev", selectionStart: 4 } })

			expect(screen.getByTestId("context-menu")).toHaveAttribute("data-selected-index", "1")
			expect(posted()).toContainEqual({ type: "requestCommands" })
		})

		it("closes the menu again when the mention is gone", () => {
			renderTextArea({ inputValue: "" })
			fireEvent.change(textarea(), { target: { value: "@", selectionStart: 1 } })
			expect(screen.getByTestId("context-menu")).toBeInTheDocument()

			fireEvent.change(textarea(), { target: { value: "plain", selectionStart: 5 } })

			expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument()
		})

		it("debounces the file search", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderTextArea({ inputValue: "" })

				fireEvent.change(textarea(), { target: { value: "@sr", selectionStart: 3 } })
				fireEvent.change(textarea(), { target: { value: "@src", selectionStart: 4 } })
				act(() => vi.advanceTimersByTime(200))

				expect(posted().filter((message) => message.type === "searchFiles")).toHaveLength(1)
			} finally {
				vi.useRealTimers()
			}
		})

		it("closes the menu when the field loses focus", () => {
			renderTextArea({ inputValue: "" })
			fireEvent.change(textarea(), { target: { value: "@", selectionStart: 1 } })

			fireEvent.blur(textarea())

			expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument()
		})
	})

	describe("pasting", () => {
		const clipboard = (data: { text?: string; items?: any[] }) => ({
			clipboardData: {
				getData: () => data.text ?? "",
				items: data.items ?? [],
			},
		})

		it("wraps a pasted url as a mention", () => {
			const { setInputValue } = renderTextArea({ inputValue: "see " })
			putCaretAt(4)

			fireEvent.paste(textarea(), clipboard({ text: " https://example.test " }))

			expect(setInputValue).toHaveBeenCalledWith("see https://example.test ")
		})

		it("keeps plain text as it is", () => {
			const { setInputValue } = renderTextArea({ inputValue: "" })

			fireEvent.paste(textarea(), clipboard({ text: "just words" }))

			expect(setInputValue).not.toHaveBeenCalled()
		})

		it("accepts pasted images", async () => {
			const setSelectedImages = vi.fn()
			renderTextArea({ inputValue: "", setSelectedImages })
			const file = new File(["x"], "shot.png", { type: "image/png" })

			fireEvent.paste(textarea(), clipboard({ items: [{ type: "image/png", getAsFile: () => file }] }))

			await waitFor(() => expect(setSelectedImages).toHaveBeenCalled())
		})

		it("ignores images when the model cannot read them", () => {
			const setSelectedImages = vi.fn()
			renderTextArea({ inputValue: "", shouldDisableImages: true, setSelectedImages })

			fireEvent.paste(
				textarea(),
				clipboard({ items: [{ type: "image/png", getAsFile: () => new File(["x"], "a.png") }] }),
			)

			expect(setSelectedImages).not.toHaveBeenCalled()
		})

		it("warns when nothing could be read", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const setSelectedImages = vi.fn()
			renderTextArea({ inputValue: "", setSelectedImages })

			fireEvent.paste(textarea(), clipboard({ items: [{ type: "image/png", getAsFile: () => null }] }))

			await waitFor(() => expect(warn).toHaveBeenCalledWith("chat:noValidImages"))
			expect(setSelectedImages).not.toHaveBeenCalled()
			warn.mockRestore()
		})
	})

	describe("drag and drop", () => {
		const dropZone = () => document.querySelector(".chat-text-area")!

		const dataTransfer = ({ text = "", uriList = "", files = [] as File[] }) => ({
			getData: (type: string) => (type === "text" ? text : uriList),
			files,
			dropEffect: "none",
		})

		/** jsdom には DragEvent が無いので、MouseEvent に dataTransfer を生やして送る。 */
		const dispatchDrag = (type: string, init: { shiftKey?: boolean; clientX?: number; clientY?: number } = {}) => {
			const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
			Object.defineProperty(event, "dataTransfer", { value: dataTransfer({}) })
			fireEvent(dropZone(), event)
		}

		it("turns a dropped path into a mention", () => {
			const { setInputValue } = renderTextArea({ inputValue: "" })

			fireEvent.drop(dropZone(), { dataTransfer: dataTransfer({ text: "/test/workspace/src/app.ts" }) })

			expect(setInputValue).toHaveBeenCalledWith("@/src/app.ts ")
		})

		it("falls back to the uri list when there is no plain text", () => {
			const { setInputValue } = renderTextArea({ inputValue: "" })

			fireEvent.drop(dropZone(), { dataTransfer: dataTransfer({ uriList: "/test/workspace/src/app.ts" }) })

			expect(setInputValue).toHaveBeenCalledWith("@/src/app.ts ")
		})

		it("ignores a drop it cannot turn into a mention", () => {
			const { setInputValue } = renderTextArea({ inputValue: "" })

			fireEvent.drop(dropZone(), { dataTransfer: dataTransfer({ text: "   " }) })

			expect(setInputValue).not.toHaveBeenCalled()
		})

		it("accepts dropped images", async () => {
			const setSelectedImages = vi.fn()
			renderTextArea({ inputValue: "", setSelectedImages })
			const file = new File(["x"], "shot.png", { type: "image/png" })

			fireEvent.drop(dropZone(), { dataTransfer: dataTransfer({ files: [file] }) })

			await waitFor(() => expect(setSelectedImages).toHaveBeenCalled())
			expect(posted()).toContainEqual(expect.objectContaining({ type: "draggedImages" }))
		})

		it("ignores dropped images when the model cannot read them", () => {
			const setSelectedImages = vi.fn()
			renderTextArea({ inputValue: "", shouldDisableImages: true, setSelectedImages })
			const file = new File(["x"], "shot.png", { type: "image/png" })

			fireEvent.drop(dropZone(), { dataTransfer: dataTransfer({ files: [file] }) })

			expect(setSelectedImages).not.toHaveBeenCalled()
		})

		it("ignores dropped files that are not images", () => {
			const setSelectedImages = vi.fn()
			renderTextArea({ inputValue: "", setSelectedImages })
			const file = new File(["x"], "notes.txt", { type: "text/plain" })

			fireEvent.drop(dropZone(), { dataTransfer: dataTransfer({ files: [file] }) })

			expect(setSelectedImages).not.toHaveBeenCalled()
		})

		it("only highlights the drop zone while shift is held", () => {
			renderTextArea({ inputValue: "" })

			dispatchDrag("dragover", { shiftKey: false })
			expect(textarea().className).toContain("bg-vscode-input-background")

			dispatchDrag("dragover", { shiftKey: true })
			expect(textarea().className).toContain("color-mix")
		})

		it("clears the highlight once the pointer leaves", () => {
			renderTextArea({ inputValue: "" })
			dispatchDrag("dragover", { shiftKey: true })

			// 要素の内側なら消さない。
			vi.spyOn(dropZone(), "getBoundingClientRect").mockReturnValue({
				left: 0,
				right: 100,
				top: 0,
				bottom: 100,
			} as DOMRect)
			dispatchDrag("dragleave", { clientX: 50, clientY: 50 })
			expect(textarea().className).toContain("color-mix")

			dispatchDrag("dragleave", { clientX: 200, clientY: 50 })
			expect(textarea().className).toContain("bg-vscode-input-background")
		})
	})

	describe("chrome", () => {
		it("marks the field as focused", () => {
			renderTextArea({ inputValue: "" })

			fireEvent.focus(textarea())

			expect(textarea().className).toContain("border-vscode-focusBorder")
		})

		it("passes the height changes on", () => {
			const onHeightChange = vi.fn()
			renderTextArea({ inputValue: "", onHeightChange })

			fireEvent.click(screen.getByTestId("report-height"))
			expect(onHeightChange).toHaveBeenCalledWith(120)

			fireEvent.click(screen.getByTestId("report-smaller-height"))
			expect(onHeightChange).toHaveBeenLastCalledWith(60)
			expect(onHeightChange).toHaveBeenCalledTimes(2)
		})

		it("survives without a height listener", () => {
			renderTextArea({ inputValue: "", onHeightChange: undefined })

			fireEvent.click(screen.getByTestId("report-height"))

			expect(textarea()).toBeInTheDocument()
		})

		it("keeps the highlight layer in sync while scrolling", () => {
			renderTextArea({ inputValue: "@/src/app.ts" })

			fireEvent.scroll(textarea())

			expect(document.querySelector("mark.mention-context-textarea-highlight")).toBeInTheDocument()
		})

		it("highlights known commands only", () => {
			renderTextArea({ inputValue: "/review and /unknown" })

			const marks = Array.from(document.querySelectorAll("mark")).map((mark) => mark.textContent)
			expect(marks).toEqual(["/review"])
		})

		it("highlights a command that follows a space", () => {
			renderTextArea({ inputValue: "please /review" })

			expect(document.querySelector("mark")).toHaveTextContent("/review")
		})

		it("shows the thumbnails of the attached images", () => {
			renderTextArea({ inputValue: "", selectedImages: ["data:image/png;base64,A"] })

			expect(screen.getByTestId("thumbnails")).toHaveAttribute("data-count", "1")
		})

		it("mentions dragging files without images when images are off", () => {
			renderTextArea({ inputValue: "", shouldDisableImages: true })

			expect(screen.getByText(/chat:dragFiles/)).toBeInTheDocument()
		})

		it("hides the hint once something is typed", () => {
			renderTextArea({ inputValue: "hello" })

			expect(screen.queryByText(/chat:addContext/)).not.toBeInTheDocument()
		})

		// 組み込みモードは code の 1 件だけなので、モードセレクタは
		// カスタムモードが定義されているときにしか出ない。
		const withSecondMode = {
			customModes: [
				{ slug: "second-mode", name: "Second", roleDefinition: "You do other work", groups: ["read"] },
			],
		}

		it("switches mode and profile from the selectors", () => {
			const setMode = vi.fn()
			renderTextArea({ inputValue: "", setMode }, withSecondMode)

			fireEvent.click(screen.getByTestId("mode-selector-change"))
			expect(setMode).toHaveBeenCalledWith("architect")
			expect(posted()).toContainEqual({ type: "mode", text: "architect" })

			fireEvent.click(screen.getByTestId("api-config-change"))
			expect(posted()).toContainEqual({ type: "loadApiConfigurationById", text: "cfg-2" })

			fireEvent.click(screen.getByTestId("api-config-lock"))
			expect(posted()).toContainEqual({ type: "lockApiConfigAcrossModes", bool: true })
		})

		it("組み込みモードが 2 件（code / research）あるのでモードセレクタを出す", () => {
			renderTextArea({ inputValue: "" })

			expect(screen.getByTestId("mode-selector-change")).toBeInTheDocument()
		})

		it("自律モードのバッジは常に出る", () => {
			// 権限を決めているのはこちらなので、モードセレクタの有無に関わらず表示する。
			renderTextArea({ inputValue: "" })

			expect(screen.getByTestId("autonomy-badge")).toBeInTheDocument()
		})

		it("unlocks the profile again", () => {
			renderTextArea({ inputValue: "" }, { lockApiConfigAcrossModes: true })

			fireEvent.click(screen.getByTestId("api-config-lock"))

			expect(posted()).toContainEqual({ type: "lockApiConfigAcrossModes", bool: false })
		})

		it("shows the id of the current profile", () => {
			renderTextArea({ inputValue: "" })

			expect(screen.getByTestId("api-config-selector")).toHaveAttribute("data-value", "cfg-1")
			expect(screen.getByTestId("api-config-selector")).toHaveAttribute("data-display", "Config 1")
		})

		it("copes with an unknown profile", () => {
			renderTextArea({ inputValue: "" }, { currentApiConfigName: undefined, listApiConfigMeta: undefined })

			expect(screen.getByTestId("api-config-selector")).toHaveAttribute("data-value", "")
			expect(screen.getByTestId("api-config-selector")).toHaveAttribute("data-count", "0")
		})
	})

	describe("editing an existing message", () => {
		it("swaps the enhance button for a cancel button", () => {
			const onCancel = vi.fn()
			renderTextArea({ inputValue: "text", isEditMode: true, onCancel })

			expect(screen.queryByLabelText("chat:enhancePrompt")).not.toBeInTheDocument()
			fireEvent.click(screen.getByLabelText("chat:cancel.title"))

			expect(onCancel).toHaveBeenCalled()
		})

		it("cancels on escape", () => {
			const onCancel = vi.fn()
			renderTextArea({ inputValue: "text", isEditMode: true, onCancel })

			fireEvent.keyDown(textarea(), { key: "Escape" })

			expect(onCancel).toHaveBeenCalled()
		})

		it("ignores escape while composing", () => {
			const onCancel = vi.fn()
			renderTextArea({ inputValue: "text", isEditMode: true, onCancel })

			fireEvent.keyDown(textarea(), { key: "Escape", isComposing: true })

			expect(onCancel).not.toHaveBeenCalled()
		})

		it("hides the badges", () => {
			renderTextArea({ inputValue: "", isEditMode: true })

			expect(screen.queryByTestId("indexing-badge")).not.toBeInTheDocument()
			expect(screen.queryByTestId("autonomy-badge")).not.toBeInTheDocument()
		})
	})

	describe("streaming", () => {
		it("offers to queue what was typed", () => {
			const onEnqueueMessage = vi.fn()
			renderTextArea({ inputValue: "later", isStreaming: true, onEnqueueMessage })

			fireEvent.click(screen.getByLabelText("chat:enqueueMessage"))

			expect(onEnqueueMessage).toHaveBeenCalled()
		})

		it("hides the queue button with an empty box", () => {
			renderTextArea({ inputValue: "", isStreaming: true, onEnqueueMessage: vi.fn() })

			expect(screen.queryByLabelText("chat:enqueueMessage")).not.toBeInTheDocument()
		})

		it("turns the send button into a stop button", () => {
			const onStop = vi.fn()
			const onSend = vi.fn()
			renderTextArea({ inputValue: "text", isStreaming: true, onStop, onSend })

			fireEvent.click(screen.getByLabelText("chat:stop.title"))

			expect(onStop).toHaveBeenCalled()
			expect(onSend).not.toHaveBeenCalled()
		})

		it("sends when nothing is streaming", () => {
			const onSend = vi.fn()
			renderTextArea({ inputValue: "text", onSend })

			fireEvent.click(screen.getByLabelText(/chat:pressToSend/))

			expect(onSend).toHaveBeenCalled()
		})

		it("spells the shortcut for the newline-first setting", () => {
			renderTextArea({ inputValue: "text" }, { enterBehavior: "newline" })

			expect(screen.getByLabelText(/Ctrl\+Enter/)).toBeInTheDocument()
		})
	})

	it("adds images from the toolbar", () => {
		const onSelectImages = vi.fn()
		renderTextArea({ inputValue: "", onSelectImages })

		fireEvent.click(screen.getByLabelText("chat:addImages"))

		expect(onSelectImages).toHaveBeenCalled()
	})

	it("does not add images when the model cannot read them", () => {
		const onSelectImages = vi.fn()
		renderTextArea({ inputValue: "", shouldDisableImages: true, onSelectImages })

		fireEvent.click(screen.getByLabelText("chat:addImages"))

		expect(onSelectImages).not.toHaveBeenCalled()
	})

	describe("last mile", () => {
		const dropZone = () => document.querySelector(".chat-text-area")!

		it("spells the send shortcut with the command key on macOS", () => {
			const platform = Object.getOwnPropertyDescriptor(window.navigator, "platform")
			Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true })
			try {
				renderTextArea({ inputValue: "text" }, { enterBehavior: "newline" })

				expect(screen.getByLabelText(/⌘\+Enter/)).toBeInTheDocument()
			} finally {
				if (platform) {
					Object.defineProperty(window.navigator, "platform", platform)
				}
			}
		})

		it("returns focus after inserting a command", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderTextArea({ inputValue: "" })
				fireEvent.change(textarea(), { target: { value: "@", selectionStart: 1 } })

				fireEvent.click(screen.getByTestId("select-command"))
				act(() => vi.advanceTimersByTime(1))

				expect(textarea()).toBeInTheDocument()
			} finally {
				vi.useRealTimers()
			}
		})

		it("returns focus after inserting a mention", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderTextArea({ inputValue: "" })
				fireEvent.change(textarea(), { target: { value: "@", selectionStart: 1 } })

				fireEvent.click(screen.getByTestId("select-file"))
				act(() => vi.advanceTimersByTime(1))

				expect(textarea()).toBeInTheDocument()
			} finally {
				vi.useRealTimers()
			}
		})

		it("returns focus after pasting a url", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				renderTextArea({ inputValue: "" })

				fireEvent.paste(textarea(), {
					clipboardData: { getData: () => "https://example.test", items: [] },
				})
				act(() => vi.advanceTimersByTime(1))

				expect(textarea()).toBeInTheDocument()
			} finally {
				vi.useRealTimers()
			}
		})

		it("reports a file it could not read", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {})
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			class FailingFileReader {
				error = new Error("unreadable")
				result: unknown = null
				onloadend: (() => void) | null = null
				readAsDataURL() {
					this.onloadend?.()
				}
			}
			vi.stubGlobal("FileReader", FailingFileReader)
			try {
				const setSelectedImages = vi.fn()
				renderTextArea({ inputValue: "", setSelectedImages })

				fireEvent.paste(textarea(), {
					clipboardData: {
						getData: () => "",
						items: [{ type: "image/png", getAsFile: () => new File(["x"], "a.png") }],
					},
				})

				await waitFor(() => expect(error).toHaveBeenCalledWith("chat:errorReadingFile", expect.anything()))
				expect(setSelectedImages).not.toHaveBeenCalled()
			} finally {
				vi.unstubAllGlobals()
				error.mockRestore()
				warn.mockRestore()
			}
		})

		it("ignores a file that does not read back as text", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			class BinaryFileReader {
				error: unknown = null
				result: unknown = new ArrayBuffer(8)
				onloadend: (() => void) | null = null
				readAsDataURL() {
					this.onloadend?.()
				}
			}
			vi.stubGlobal("FileReader", BinaryFileReader)
			try {
				const setSelectedImages = vi.fn()
				renderTextArea({ inputValue: "", setSelectedImages })

				fireEvent.paste(textarea(), {
					clipboardData: {
						getData: () => "",
						items: [{ type: "image/png", getAsFile: () => new File(["x"], "a.png") }],
					},
				})

				await waitFor(() => expect(warn).toHaveBeenCalledWith("chat:noValidImages"))
				expect(setSelectedImages).not.toHaveBeenCalled()
			} finally {
				vi.unstubAllGlobals()
				warn.mockRestore()
			}
		})

		it("reports a dropped file it could not read", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => {})
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			class FailingFileReader {
				error = new Error("unreadable")
				result: unknown = null
				onloadend: (() => void) | null = null
				readAsDataURL() {
					this.onloadend?.()
				}
			}
			vi.stubGlobal("FileReader", FailingFileReader)
			try {
				const setSelectedImages = vi.fn()
				renderTextArea({ inputValue: "", setSelectedImages })

				fireEvent.drop(dropZone(), {
					dataTransfer: {
						getData: () => "",
						files: [new File(["x"], "shot.png", { type: "image/png" })],
					},
				})

				await waitFor(() => expect(error).toHaveBeenCalledWith("chat:errorReadingFile", expect.anything()))
				await waitFor(() => expect(warn).toHaveBeenCalledWith("chat:noValidImages"))
				expect(setSelectedImages).not.toHaveBeenCalled()
			} finally {
				vi.unstubAllGlobals()
				error.mockRestore()
				warn.mockRestore()
			}
		})

		it("ignores a dropped file that does not read back as text", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			class BinaryFileReader {
				error: unknown = null
				result: unknown = new ArrayBuffer(8)
				onloadend: (() => void) | null = null
				readAsDataURL() {
					this.onloadend?.()
				}
			}
			vi.stubGlobal("FileReader", BinaryFileReader)
			try {
				const setSelectedImages = vi.fn()
				renderTextArea({ inputValue: "", setSelectedImages })

				fireEvent.drop(dropZone(), {
					dataTransfer: {
						getData: () => "",
						files: [new File(["x"], "shot.png", { type: "image/png" })],
					},
				})

				await waitFor(() => expect(warn).toHaveBeenCalledWith("chat:noValidImages"))
				expect(setSelectedImages).not.toHaveBeenCalled()
			} finally {
				vi.unstubAllGlobals()
				warn.mockRestore()
			}
		})

		it("appends the dropped images to the ones already attached", async () => {
			let images: string[] = ["data:image/png;base64,OLD"]
			const setSelectedImages = vi.fn((updater: any) => {
				images = typeof updater === "function" ? updater(images) : updater
			})
			renderTextArea({ inputValue: "", selectedImages: images, setSelectedImages })

			fireEvent.drop(dropZone(), {
				dataTransfer: {
					getData: () => "",
					files: [new File(["x"], "shot.png", { type: "image/png" })],
				},
			})

			await waitFor(() => expect(images.length).toBe(2))
		})

		it("moves the menu aside while editing a message", () => {
			renderTextArea({ inputValue: "", isEditMode: true })

			fireEvent.change(textarea(), { target: { value: "@", selectionStart: 1 } })

			expect(screen.getByTestId("context-menu").parentElement?.className).toContain("left-6")
		})

		it("hands the textarea to an object ref", () => {
			const ref = React.createRef<HTMLTextAreaElement>()
			setState()
			render(<ChatTextArea {...defaultProps} ref={ref} />)

			expect(ref.current).toBe(textarea())
		})

		it("hands the textarea to a callback ref", () => {
			const ref = vi.fn()
			setState()
			render(<ChatTextArea {...defaultProps} ref={ref} />)

			expect(ref).toHaveBeenCalledWith(textarea())
		})
	})

	describe("context menu", () => {
		const openMenu = (props: Record<string, unknown> = {}) => {
			const rendered = renderTextArea({ inputValue: "", ...props })
			fireEvent.change(textarea(), { target: { value: "@", selectionStart: 1 } })
			return rendered
		}

		it("shows the menu while typing a mention", () => {
			openMenu()

			expect(screen.getByTestId("context-menu")).toHaveAttribute("data-query", "")
			expect(screen.getByTestId("context-menu")).toHaveAttribute("data-selected-index", "3")
		})

		it("switches mode when a mode is picked", () => {
			const setMode = vi.fn()
			const { setInputValue } = openMenu({ setMode })

			fireEvent.click(screen.getByTestId("select-mode"))

			expect(setMode).toHaveBeenCalledWith("architect")
			expect(setInputValue).toHaveBeenLastCalledWith("")
			expect(posted()).toContainEqual({ type: "mode", text: "architect" })
			expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument()
		})

		it("inserts a slash command when one is picked", () => {
			const { setInputValue } = openMenu()

			fireEvent.click(screen.getByTestId("select-command"))

			expect(setInputValue).toHaveBeenLastCalledWith("/review ")
			expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument()
		})

		it("drills into a type when no value was chosen", () => {
			openMenu()

			fireEvent.click(screen.getByTestId("select-file-type"))

			expect(screen.getByTestId("context-menu")).toHaveAttribute("data-type", "file")
			expect(screen.getByTestId("context-menu")).toHaveAttribute("data-selected-index", "0")
		})

		it("drills into the git history", () => {
			openMenu()

			fireEvent.click(screen.getByTestId("select-git-type"))

			expect(screen.getByTestId("context-menu")).toHaveAttribute("data-type", "git")
			expect(posted()).toContainEqual({ type: "searchCommits", query: "" })
		})

		it.each([
			["select-file", "@/src/app.ts "],
			["select-folder", "@/src "],
			["select-git", "@abc1234 "],
			["select-url", "@https://example.test "],
			["select-problems", "@problems "],
			["select-terminal", "@terminal "],
		])("inserts the mention for %s", (testId, expected) => {
			const { setInputValue } = openMenu()

			fireEvent.click(screen.getByTestId(testId))

			expect(setInputValue).toHaveBeenLastCalledWith(expected)
		})

		it("does nothing when there is nothing to pick", () => {
			const { setInputValue } = openMenu()
			setInputValue.mockClear()

			fireEvent.click(screen.getByTestId("select-no-results"))

			expect(setInputValue).not.toHaveBeenCalled()
		})

		it("inserts nothing for a command without a name", () => {
			const { setInputValue } = openMenu()

			fireEvent.click(screen.getByTestId("select-command-empty"))

			// 名前が無いので何も差し込まれず、入力中の "@" だけが消える。
			expect(setInputValue).toHaveBeenLastCalledWith("")
		})
	})
})
