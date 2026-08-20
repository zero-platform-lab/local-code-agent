// npx vitest src/components/chat/__tests__/TaskHeader.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ProviderSettings } from "@openai-agent/types"

import TaskHeader, { TaskHeaderProps } from "../TaskHeader"

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key, // Simple mock that returns the key
	}),
	// Mock initReactI18next to prevent initialization errors in tests
	initReactI18next: {
		type: "3rdParty",
		init: vi.fn(),
	},
}))

// Mock the vscode API - use vi.hoisted to ensure the mock is available when vi.mock is hoisted
const { mockPostMessage } = vi.hoisted(() => ({
	mockPostMessage: vi.fn(),
}))
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

// Mock the VSCodeBadge component
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeBadge: ({ children }: { children: React.ReactNode }) => <div data-testid="vscode-badge">{children}</div>,
}))

// Create a variable to hold the mock state
const mockExtensionState: {
	apiConfiguration: ProviderSettings
	currentTaskItem: { id: string } | null
	clineMessages: any[]
} = {
	apiConfiguration: {
		apiProvider: "openai",
		openAiApiKey: "test-api-key",
		openAiModelId: "gpt-4",
	} as ProviderSettings,
	currentTaskItem: { id: "test-task-id" },
	clineMessages: [],
}

// Mock the ExtensionStateContext
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockExtensionState,
}))

// Mock findLastIndex from @agent/array
vi.mock("@agent/array", () => ({
	findLastIndex: (array: any[], predicate: (item: any) => boolean) => {
		for (let i = array.length - 1; i >= 0; i--) {
			if (predicate(array[i])) {
				return i
			}
		}
		return -1
	},
}))

// Create a variable to hold the mock model info for useSelectedModel
let mockModelInfo: { contextWindow: number; maxTokens: number } | undefined = undefined

// Mock useSelectedModel hook
vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({
		provider: "anthropic",
		id: "test-model",
		info: mockModelInfo,
		isLoading: false,
		isError: false,
	}),
}))

// Mock getModelMaxOutputTokens from @agent/api
let mockMaxOutputTokens = 0
vi.mock("@agent/api", () => ({
	getModelMaxOutputTokens: () => mockMaxOutputTokens,
}))

describe("TaskHeader", () => {
	const defaultProps: TaskHeaderProps = {
		task: { type: "say", ts: Date.now(), text: "Test task", images: [] },
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.05,
		contextTokens: 200,
		buttonsDisabled: false,
		handleCondenseContext: vi.fn(),
	}

	const queryClient = new QueryClient()

	const renderTaskHeader = (props: Partial<TaskHeaderProps> = {}) => {
		return render(
			<QueryClientProvider client={queryClient}>
				<TaskHeader {...defaultProps} {...props} />
			</QueryClientProvider>,
		)
	}

	it("should display cost when totalCost is greater than 0", () => {
		renderTaskHeader()
		expect(screen.getByText("$0.05")).toBeInTheDocument()
	})

	it("should not display cost when totalCost is 0", () => {
		renderTaskHeader({ totalCost: 0 })
		expect(screen.queryByText("$0.0000")).not.toBeInTheDocument()
	})

	it("should not display cost when totalCost is null", () => {
		renderTaskHeader({ totalCost: null as any })
		expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
	})

	it("should not display cost when totalCost is undefined", () => {
		renderTaskHeader({ totalCost: undefined as any })
		expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
	})

	it("should not display cost when totalCost is NaN", () => {
		renderTaskHeader({ totalCost: NaN })
		expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
	})

	it("should render the condense context button when expanded", () => {
		renderTaskHeader()
		// First click to expand the task header
		const taskHeader = screen.getByText("Test task")
		fireEvent.click(taskHeader)

		// Now find the condense button in the expanded state
		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(condenseButton).toBeDefined()
		expect(condenseButton?.querySelector("svg")).toBeInTheDocument()
	})

	it("should call handleCondenseContext when condense context button is clicked", () => {
		const handleCondenseContext = vi.fn()
		renderTaskHeader({ handleCondenseContext })

		// First click to expand the task header
		const taskHeader = screen.getByText("Test task")
		fireEvent.click(taskHeader)

		// Find the button that contains the FoldVertical icon
		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(condenseButton).toBeDefined()
		fireEvent.click(condenseButton!)
		expect(handleCondenseContext).toHaveBeenCalledWith("test-task-id")
	})

	it("should disable the condense context button when buttonsDisabled is true", () => {
		const handleCondenseContext = vi.fn()
		renderTaskHeader({ buttonsDisabled: true, handleCondenseContext })

		// First click to expand the task header
		const taskHeader = screen.getByText("Test task")
		fireEvent.click(taskHeader)

		// Find the button that contains the FoldVertical icon
		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(condenseButton).toBeDefined()
		expect(condenseButton).toBeDisabled()
		fireEvent.click(condenseButton!)
		expect(handleCondenseContext).not.toHaveBeenCalled()
	})

	describe("Back to parent task button", () => {
		beforeEach(() => {
			mockPostMessage.mockClear()
		})

		it("should not show back button when parentTaskId is not provided", () => {
			renderTaskHeader()
			expect(screen.queryByText("chat:task.backToParentTask")).not.toBeInTheDocument()
		})

		it("should not show back button when parentTaskId is undefined", () => {
			renderTaskHeader({ parentTaskId: undefined })
			expect(screen.queryByText("chat:task.backToParentTask")).not.toBeInTheDocument()
		})

		it("should show back button when parentTaskId is provided", () => {
			renderTaskHeader({ parentTaskId: "parent-task-123" })
			expect(screen.getByText("chat:task.backToParentTask")).toBeInTheDocument()
		})

		it("should call vscode.postMessage with showTaskWithId when back button is clicked", () => {
			renderTaskHeader({ parentTaskId: "parent-task-123" })

			const backButton = screen.getByText("chat:task.backToParentTask")
			fireEvent.click(backButton)

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showTaskWithId",
				text: "parent-task-123",
			})
		})

		it("should show back button with ArrowLeft icon", () => {
			renderTaskHeader({ parentTaskId: "parent-task-123" })

			// Find the button containing the back text and verify it has the ArrowLeft icon
			const backButton = screen.getByText("chat:task.backToParentTask").closest("button")
			expect(backButton).toBeInTheDocument()
			expect(backButton?.querySelector("svg.lucide-arrow-left")).toBeInTheDocument()
		})
	})

	describe("Context window percentage calculation", () => {
		// The percentage should be calculated as:
		// contextTokens / (contextWindow - reservedForOutput) * 100
		// This represents the percentage of AVAILABLE input space used,
		// not the percentage of the total context window.

		beforeEach(() => {
			// Set up mock model with known contextWindow
			mockModelInfo = { contextWindow: 1000, maxTokens: 200 }
			// Set up mock for getModelMaxOutputTokens to return reservedForOutput
			mockMaxOutputTokens = 200
		})

		afterEach(() => {
			// Reset mocks
			mockModelInfo = undefined
			mockMaxOutputTokens = 0
		})

		it("should calculate percentage based on available input space, not total context window", () => {
			// With the formula: contextTokens / (contextWindow - reservedForOutput) * 100
			// If contextTokens = 200, contextWindow = 1000, reservedForOutput = 200
			// Then available input space = 1000 - 200 = 800
			// Percentage = 200 / 800 * 100 = 25%
			//
			// Old (incorrect) formula would have been: (200 + 200) / 1000 * 100 = 40%

			renderTaskHeader({ contextTokens: 200 })

			// The percentage should be rendered in the collapsed header state
			// Verify that 25% is displayed (correct formula) and NOT 40% (old incorrect formula)
			expect(screen.getByText("25%")).toBeInTheDocument()
			expect(screen.queryByText("40%")).not.toBeInTheDocument()
		})

		it("should handle edge case when available input space is zero", () => {
			// When contextWindow equals reservedForOutput, available space is 0
			// The percentage should be 0 to avoid division by zero
			mockModelInfo = { contextWindow: 200, maxTokens: 200 }
			mockMaxOutputTokens = 200

			renderTaskHeader({ contextTokens: 100 })

			// Should show 0% when available input space is 0
			expect(screen.getByText("0%")).toBeInTheDocument()
		})
	})
	describe("expanding and collapsing", () => {
		it("expands when the header itself is clicked and collapses again", () => {
			renderTaskHeader()
			const header = screen.getByText("Test task").closest("div.cursor-pointer")!

			fireEvent.click(header)
			expect(screen.getByText("chat:task.title")).toBeInTheDocument()

			fireEvent.click(header)
			expect(screen.queryByText("chat:task.title")).not.toBeInTheDocument()
		})

		it("does not expand when a button inside the header is used", () => {
			renderTaskHeader()

			fireEvent.click(document.querySelector(".lucide-chevron-down")!.closest("button")!)
			expect(screen.getByText("chat:task.title")).toBeInTheDocument()

			// Collapsing through the same button must not toggle twice via the header handler.
			fireEvent.click(document.querySelector(".lucide-chevron-up")!.closest("button")!)
			expect(screen.queryByText("chat:task.title")).not.toBeInTheDocument()
		})

		it("does not expand while the user is selecting text", () => {
			renderTaskHeader()
			const header = screen.getByText("Test task").closest("div.cursor-pointer")!
			const selection = vi.spyOn(window, "getSelection").mockReturnValue({
				toString: () => "some selected text",
			} as Selection)

			fireEvent.click(header)

			expect(screen.queryByText("chat:task.title")).not.toBeInTheDocument()
			selection.mockRestore()
		})

		it("does not expand when the todo list is clicked", () => {
			renderTaskHeader({ todos: [{ id: "1", content: "Do the thing", status: "pending" }] as never })
			const todo = document.querySelector("[data-todo-list]")

			if (todo) {
				fireEvent.click(todo)
				expect(screen.queryByText("chat:task.title")).not.toBeInTheDocument()
			}
		})

		it("shows the images attached to the task once expanded", () => {
			renderTaskHeader({
				task: { type: "say", ts: Date.now(), text: "Test task", images: ["data:image/png;base64,AA"] },
			})

			fireEvent.click(document.querySelector(".lucide-chevron-down")!.closest("button")!)

			expect(screen.getByAltText("Thumbnail 1")).toBeInTheDocument()
		})
	})
	describe("cost of a task with subtasks", () => {
		it("shows the total including subtasks, with the breakdown, while collapsed", () => {
			renderTaskHeader({
				hasSubtasks: true,
				aggregatedCost: 0.42,
				costBreakdown: "parent 0.20 / children 0.22",
			})

			expect(document.body.textContent).toContain("$0.42")
		})

		it("falls back to this task's own cost when no aggregate was supplied", () => {
			renderTaskHeader({ hasSubtasks: true })

			fireEvent.click(screen.getByText("Test task").closest("div.cursor-pointer")!)

			expect(document.body.textContent).toContain("$0.05")
		})

		it("shows the breakdown in the expanded cost row as well", () => {
			renderTaskHeader({
				hasSubtasks: true,
				aggregatedCost: 0.42,
				costBreakdown: "parent 0.20 / children 0.22",
			})

			fireEvent.click(document.querySelector(".lucide-chevron-down")!.closest("button")!)

			expect(document.body.textContent).toContain("$0.42")
		})
	})
	describe("details it shows", () => {
		it("keeps a click on the task actions from collapsing the task", () => {
			renderTaskHeader()
			fireEvent.click(screen.getByText("Test task").closest("div.cursor-pointer")!)
			expect(screen.getByText("chat:task.title")).toBeInTheDocument()

			fireEvent.click(screen.getByLabelText("chat:task.export"))

			expect(screen.getByText("chat:task.title")).toBeInTheDocument()
		})

		it("keeps a click on the collapsed metrics row from expanding the task", () => {
			const { container } = renderTaskHeader({ contextTokens: 200 })

			fireEvent.click(container.querySelector(".text-muted-foreground\\/70")!)

			expect(screen.queryByText("chat:task.title")).not.toBeInTheDocument()
		})

		it("counts an unknown number of context tokens as none", () => {
			mockModelInfo = { contextWindow: 100000, maxTokens: 4096 }
			renderTaskHeader({ contextTokens: undefined as unknown as number })

			fireEvent.click(screen.getByText("Test task").closest("div.cursor-pointer")!)

			expect(screen.getByText("chat:task.contextWindow")).toBeInTheDocument()
			mockModelInfo = undefined
		})

		it("shows the cache row when the cache was read from", () => {
			renderTaskHeader({ cacheReads: 5 })

			fireEvent.click(screen.getByText("Test task").closest("div.cursor-pointer")!)

			expect(screen.getByText("chat:task.cache")).toBeInTheDocument()
		})

		it("shows the cache row when the cache was written to", () => {
			renderTaskHeader({ cacheWrites: 7 })

			fireEvent.click(screen.getByText("Test task").closest("div.cursor-pointer")!)

			expect(screen.getByText("chat:task.cache")).toBeInTheDocument()
		})

		it("hides the cache row when there was no cache activity", () => {
			renderTaskHeader({ cacheReads: 0, cacheWrites: 0 })

			fireEvent.click(screen.getByText("Test task").closest("div.cursor-pointer")!)

			expect(screen.queryByText("chat:task.cache")).not.toBeInTheDocument()
		})

		it("shows the stored size of the task when there is one", () => {
			mockExtensionState.currentTaskItem = { id: "test-task-id", size: 2048 } as never
			renderTaskHeader()

			fireEvent.click(screen.getByText("Test task").closest("div.cursor-pointer")!)

			expect(screen.getByText("chat:task.size")).toBeInTheDocument()
			mockExtensionState.currentTaskItem = { id: "test-task-id" }
		})

		it("shows the todo list under the header when there is one", () => {
			renderTaskHeader({ todos: [{ id: "1", content: "Do the thing", status: "pending" }] as never })

			expect(document.querySelector("[data-todo-list]")).toBeInTheDocument()
		})
	})
	describe("more details", () => {
		it("passes the model's output reservation to the progress bar when there is one", () => {
			mockMaxOutputTokens = 4096
			mockModelInfo = { contextWindow: 100000, maxTokens: 4096 }
			renderTaskHeader()

			fireEvent.click(screen.getByText("Test task").closest("div.cursor-pointer")!)

			expect(screen.getByText("chat:task.contextWindow")).toBeInTheDocument()
			mockMaxOutputTokens = 0
			mockModelInfo = undefined
		})

		it("omits the breakdown line when there is nothing to break down", () => {
			renderTaskHeader({ hasSubtasks: true, aggregatedCost: 0.42 })

			fireEvent.click(screen.getByText("Test task").closest("div.cursor-pointer")!)

			expect(document.body.textContent).toContain("$0.42")
		})
	})
})
