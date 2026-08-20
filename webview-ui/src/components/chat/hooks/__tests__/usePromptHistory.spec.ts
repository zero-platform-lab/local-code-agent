import { act, renderHook } from "@testing-library/react"

import type { ClineMessage, HistoryItem } from "@openai-agent/types"

import { usePromptHistory } from "../usePromptHistory"

const feedback = (text: string): ClineMessage => ({ ts: 1, type: "say", say: "user_feedback", text }) as ClineMessage

const task = (text: string, workspace?: string): HistoryItem =>
	({ id: text, number: 1, ts: 1, task: text, tokensIn: 0, tokensOut: 0, totalCost: 0, workspace }) as HistoryItem

const setup = (overrides: Partial<Parameters<typeof usePromptHistory>[0]> = {}) => {
	const setInputValue = vi.fn()
	const view = renderHook((props: Parameters<typeof usePromptHistory>[0]) => usePromptHistory(props), {
		initialProps: {
			clineMessages: undefined,
			taskHistory: undefined,
			cwd: "/work",
			inputValue: "",
			setInputValue,
			...overrides,
		},
	})

	return { ...view, setInputValue }
}

const textareaWith = (value: string, selectionStart = 0, selectionEnd = selectionStart) => {
	const textarea = document.createElement("textarea")
	textarea.value = value
	textarea.setSelectionRange(selectionStart, selectionEnd)
	return textarea
}

const keyEvent = (key: string, textarea: HTMLTextAreaElement) =>
	({ key, currentTarget: textarea, preventDefault: vi.fn() }) as unknown as React.KeyboardEvent<HTMLTextAreaElement>

describe("usePromptHistory — which prompts are offered", () => {
	it("offers what the user said in this conversation, newest first", () => {
		const { result } = setup({ clineMessages: [feedback("first"), feedback("second")] })

		expect(result.current.promptHistory).toEqual(["second", "first"])
	})

	it("ignores blank feedback and other message kinds", () => {
		const { result } = setup({
			clineMessages: [
				feedback("   "),
				{ ts: 1, type: "say", say: "text", text: "assistant" } as ClineMessage,
				feedback("real"),
			],
		})

		expect(result.current.promptHistory).toEqual(["real"])
	})

	it("keeps only the most recent 100 prompts of a conversation", () => {
		const messages = Array.from({ length: 105 }, (_, index) => feedback(`prompt-${index}`))

		const { result } = setup({ clineMessages: messages })

		expect(result.current.promptHistory).toHaveLength(100)
		expect(result.current.promptHistory[0]).toBe("prompt-104")
		expect(result.current.promptHistory.at(-1)).toBe("prompt-5")
	})

	it("offers nothing from earlier tasks while a conversation is running", () => {
		const { result } = setup({
			clineMessages: [{ ts: 1, type: "say", say: "text", text: "assistant" } as ClineMessage],
			taskHistory: [task("older task")],
		})

		expect(result.current.promptHistory).toEqual([])
	})

	it("falls back to this workspace's task history when starting fresh", () => {
		const { result } = setup({
			taskHistory: [task("in workspace", "/work"), task("elsewhere", "/other"), task("no workspace")],
		})

		expect(result.current.promptHistory).toEqual(["in workspace", "no workspace"])
	})

	it("keeps only the first 100 tasks", () => {
		const history = Array.from({ length: 105 }, (_, index) => task(`task-${index}`, "/work"))

		const { result } = setup({ taskHistory: history })

		expect(result.current.promptHistory).toHaveLength(100)
		expect(result.current.promptHistory[0]).toBe("task-0")
	})

	it("offers nothing without a task history or without a workspace", () => {
		expect(setup({ taskHistory: [] }).result.current.promptHistory).toEqual([])
		expect(setup({ taskHistory: [task("t", "/work")], cwd: undefined }).result.current.promptHistory).toEqual([])
	})

	it("drops navigation state when the history source changes", () => {
		const { result, rerender, setInputValue } = setup({ clineMessages: [feedback("first")] })
		const textarea = textareaWith("")

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})
		expect(result.current.historyIndex).toBe(0)

		rerender({
			clineMessages: [feedback("first"), feedback("second")],
			taskHistory: undefined,
			cwd: "/work",
			inputValue: "",
			setInputValue,
		})

		expect(result.current.historyIndex).toBe(-1)
		expect(result.current.tempInput).toBe("")
	})
})

describe("usePromptHistory — navigating", () => {
	const history = ["newest", "middle", "oldest"]
	const messages = [feedback("oldest"), feedback("middle"), feedback("newest")]

	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("does nothing while the context menu is open, while composing, or with no history", () => {
		const { result } = setup({ clineMessages: messages })
		const textarea = textareaWith("")

		expect(result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), true, false)).toBe(false)
		expect(result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, true)).toBe(false)
		expect(setup().result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)).toBe(false)
	})

	it("walks back through the history with the up arrow", () => {
		const { result, setInputValue } = setup({ clineMessages: messages })
		const textarea = textareaWith("")

		act(() => {
			expect(result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)).toBe(true)
		})
		expect(setInputValue).toHaveBeenLastCalledWith(history[0])

		act(() => {
			expect(result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)).toBe(true)
		})
		expect(setInputValue).toHaveBeenLastCalledWith(history[1])
		expect(result.current.historyIndex).toBe(1)
	})

	it("stops at the oldest prompt", () => {
		const { result } = setup({ clineMessages: [feedback("only")] })
		const textarea = textareaWith("")

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})

		expect(result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)).toBe(false)
		expect(result.current.historyIndex).toBe(0)
	})

	it("leaves the up arrow alone when the cursor is not at the very beginning", () => {
		const { result, setInputValue } = setup({ clineMessages: messages })
		const textarea = textareaWith("draft", 3)

		expect(result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)).toBe(false)
		expect(setInputValue).not.toHaveBeenCalled()
	})

	it("leaves both arrows alone while text is selected", () => {
		const { result } = setup({ clineMessages: messages })
		const textarea = textareaWith("draft", 0, 3)

		expect(result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)).toBe(false)
		expect(result.current.handleHistoryNavigation(keyEvent("ArrowDown", textarea), false, false)).toBe(false)
	})

	it("ignores the down arrow before any history navigation started", () => {
		const { result } = setup({ clineMessages: messages })
		const textarea = textareaWith("")

		expect(result.current.handleHistoryNavigation(keyEvent("ArrowDown", textarea), false, false)).toBe(false)
	})

	it("walks forward again with the down arrow", () => {
		const { result, setInputValue } = setup({ clineMessages: messages })
		const textarea = textareaWith("")

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})
		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})
		act(() => {
			expect(result.current.handleHistoryNavigation(keyEvent("ArrowDown", textarea), false, false)).toBe(true)
		})

		expect(setInputValue).toHaveBeenLastCalledWith(history[0])
		expect(result.current.historyIndex).toBe(0)
	})

	it("restores the draft the user was writing when leaving the history", () => {
		const { result, setInputValue } = setup({ clineMessages: messages, inputValue: "my draft" })
		const textarea = textareaWith("")

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})
		expect(result.current.tempInput).toBe("my draft")

		act(() => {
			expect(result.current.handleHistoryNavigation(keyEvent("ArrowDown", textarea), false, false)).toBe(true)
		})

		expect(setInputValue).toHaveBeenLastCalledWith("my draft")
		expect(result.current.historyIndex).toBe(-1)
	})

	it("returns to the draft with the cursor at the end when that is where it was", () => {
		const { result, setInputValue } = setup({ clineMessages: [feedback("only")], inputValue: "my draft" })
		const textarea = textareaWith("")

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})

		textarea.value = "only"
		textarea.setSelectionRange(4, 4)

		act(() => {
			expect(result.current.handleHistoryNavigation(keyEvent("ArrowDown", textarea), false, false)).toBe(true)
			textarea.value = "my draft"
			vi.runAllTimers()
		})

		expect(setInputValue).toHaveBeenLastCalledWith("my draft")
		expect(textarea.selectionStart).toBe("my draft".length)
	})

	it("keeps the cursor where the user had it when stepping forward from the end", () => {
		const { result } = setup({ clineMessages: messages })
		const textarea = textareaWith("")

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})
		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})

		textarea.value = history[1]
		textarea.setSelectionRange(history[1].length, history[1].length)

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowDown", textarea), false, false)
			vi.runAllTimers()
		})

		expect(textarea.selectionStart).toBe(textarea.value.length)
	})

	it("puts the cursor at the start of a prompt it navigated to", () => {
		const { result } = setup({ clineMessages: messages })
		const textarea = textareaWith("")

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
			textarea.value = history[0]
			vi.runAllTimers()
		})

		expect(textarea.selectionStart).toBe(0)
	})

	it("ignores keys other than the arrows", () => {
		const { result } = setup({ clineMessages: messages })
		const textarea = textareaWith("")

		expect(result.current.handleHistoryNavigation(keyEvent("Enter", textarea), false, false)).toBe(false)
	})
})

describe("usePromptHistory — resetting", () => {
	it("forgets the navigation position once the user types again", () => {
		const { result } = setup({ clineMessages: [feedback("first")] })
		const textarea = textareaWith("")

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})
		expect(result.current.historyIndex).toBe(0)

		act(() => {
			result.current.resetOnInputChange()
		})

		expect(result.current.historyIndex).toBe(-1)
		expect(result.current.tempInput).toBe("")
	})

	it("does nothing on typing when the user was not navigating", () => {
		const { result } = setup({ clineMessages: [feedback("first")] })

		act(() => {
			result.current.resetOnInputChange()
		})

		expect(result.current.historyIndex).toBe(-1)
	})

	it("can be reset explicitly", () => {
		const { result } = setup({ clineMessages: [feedback("first")] })
		const textarea = textareaWith("")

		act(() => {
			result.current.handleHistoryNavigation(keyEvent("ArrowUp", textarea), false, false)
		})
		act(() => {
			result.current.resetHistoryNavigation()
		})

		expect(result.current.historyIndex).toBe(-1)
		expect(result.current.tempInput).toBe("")
	})
})
