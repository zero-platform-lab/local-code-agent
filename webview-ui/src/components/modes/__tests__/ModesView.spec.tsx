// npx vitest src/components/modes/__tests__/ModesView.spec.tsx

import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import ModesView from "../ModesView"
import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

// Mock vscode API
vitest.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vitest.fn(),
	},
}))

const mockExtensionState = {
	customModePrompts: {},
	listApiConfigMeta: [
		{ id: "config1", name: "Config 1" },
		{ id: "config2", name: "Config 2" },
	],
	enhancementApiConfigId: "",
	setEnhancementApiConfigId: vitest.fn(),
	mode: "code",
	customSupportPrompts: [],
	currentApiConfigName: "",
	customInstructions: "Initial instructions",
	setCustomInstructions: vitest.fn(),
}

const renderPromptsView = (props = {}) => {
	return render(
		<ExtensionStateContext.Provider value={{ ...mockExtensionState, ...props } as any}>
			<ModesView />
		</ExtensionStateContext.Provider>,
	)
}

Element.prototype.scrollIntoView = vitest.fn()

describe("PromptsView", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("displays the current mode name in the select trigger", () => {
		renderPromptsView({ mode: "code" })
		const selectTrigger = screen.getByTestId("mode-select-trigger")
		expect(selectTrigger).toHaveTextContent("Code")
	})

	it("opens the mode selection popover when the trigger is clicked", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")
		fireEvent.click(selectTrigger)
		await waitFor(() => {
			expect(selectTrigger).toHaveAttribute("aria-expanded", "true")
		})
	})

	it("filters mode options based on search input", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")
		fireEvent.click(selectTrigger)

		const searchInput = screen.getByTestId("mode-search-input")
		fireEvent.change(searchInput, { target: { value: "research" } })

		await waitFor(() => {
			expect(screen.getByTestId("mode-option-research")).toBeInTheDocument()
			expect(screen.queryByTestId("mode-option-code")).not.toBeInTheDocument()
		})
	})

	it("selects a mode from the dropdown and sends update message", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")
		fireEvent.click(selectTrigger)

		const researchOption = await waitFor(() => screen.getByTestId("mode-option-research"))
		fireEvent.click(researchOption)

		expect(mockExtensionState.setEnhancementApiConfigId).not.toHaveBeenCalled() // Ensure this is not called by mode switch
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "mode",
			text: "research",
		})
		await waitFor(() => {
			expect(selectTrigger).toHaveAttribute("aria-expanded", "false")
		})
	})

	it("handles prompt changes correctly", async () => {
		renderPromptsView()

		// Get the textarea
		const textarea = await waitFor(() => screen.getByTestId("code-prompt-textarea"))

		// Simulate VSCode TextArea change event
		const changeEvent = new CustomEvent("change", {
			detail: {
				target: {
					value: "New prompt value",
				},
			},
		})

		fireEvent(textarea, changeEvent)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: { roleDefinition: "New prompt value" },
		})
	})

	it("resets the role definition to the built-in default", async () => {
		renderPromptsView({ mode: "code" })

		// Find and click the role definition reset button
		const resetButton = screen.getByTestId("role-definition-reset")
		expect(resetButton).toBeInTheDocument()
		await fireEvent.click(resetButton)

		// Verify it only resets role definition
		// When resetting a built-in mode's role definition, the field should be removed entirely
		// from the customPrompt object, not set to undefined.
		// This allows the default role definition from the built-in mode to be used instead.
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: {}, // Empty object because the role definition field is removed entirely
		})
	})

	it("offers a description reset and text field for every built-in mode", async () => {
		renderPromptsView({ mode: "research" })

		expect(screen.queryByTestId("description-reset")).toBeInTheDocument()
		expect(screen.getByTestId("research-description-textfield")).toBeInTheDocument()
	})

	it("handles clearing custom instructions correctly", async () => {
		const setCustomInstructions = vitest.fn()
		renderPromptsView({
			...mockExtensionState,
			customInstructions: "Initial instructions",
			setCustomInstructions,
		})

		const textarea = screen.getByTestId("global-custom-instructions-textarea")

		// Simulate VSCode TextArea change event with empty value
		// We need to simulate both the CustomEvent format and regular event format
		// since the component handles both
		Object.defineProperty(textarea, "value", {
			writable: true,
			value: "",
		})

		const changeEvent = new Event("change", { bubbles: true })
		fireEvent(textarea, changeEvent)

		// The component calls setCustomInstructions with value ?? undefined
		// With nullish coalescing, empty string is preserved (not treated as nullish)
		expect(setCustomInstructions).toHaveBeenCalledWith("")
		// The postMessage call will have multiple calls, we need to check the right one
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "customInstructions",
			text: "", // empty string is now preserved with ?? operator
		})
	})

	it("closes the mode selection popover when ESC key is pressed", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")

		// Open the popover
		fireEvent.click(selectTrigger)
		await waitFor(() => {
			expect(selectTrigger).toHaveAttribute("aria-expanded", "true")
		})

		// Press ESC key
		fireEvent.keyDown(window, { key: "Escape" })

		// Verify popover is closed
		await waitFor(() => {
			expect(selectTrigger).toHaveAttribute("aria-expanded", "false")
		})
	})

	it("does not close the popover when ESC is pressed while popover is closed", async () => {
		renderPromptsView()
		const selectTrigger = screen.getByTestId("mode-select-trigger")

		// Ensure popover is closed
		expect(selectTrigger).toHaveAttribute("aria-expanded", "false")

		// Press ESC key
		fireEvent.keyDown(window, { key: "Escape" })

		// Verify popover remains closed
		expect(selectTrigger).toHaveAttribute("aria-expanded", "false")
	})
})
