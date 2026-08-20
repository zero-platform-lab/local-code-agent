import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import PromptsSettings from "../PromptsSettings"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("../SectionHeader", () => ({ SectionHeader: ({ children }: any) => <div>{children}</div> }))
vi.mock("../Section", () => ({ Section: ({ children }: any) => <div>{children}</div> }))
vi.mock("../SearchableSetting", () => ({ SearchableSetting: ({ children }: any) => <div>{children}</div> }))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, disabled, variant }: any) => (
		<button onClick={onClick} disabled={disabled} data-variant={variant}>
			{children}
		</button>
	),
	Select: ({ children, value, onValueChange }: any) => (
		<div data-value={value}>
			<button data-testid="pick-none" onClick={() => onValueChange("-")} />
			<button data-testid="pick-config" onClick={() => onValueChange("config-1")} />
			<button data-testid="pick-condense" onClick={() => onValueChange("CONDENSE")} />
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value, "data-testid": dataTestId }: any) => (
		<div data-testid={dataTestId ?? `option-${value}`}>{children}</div>
	),
	SelectTrigger: ({ children, "data-testid": dataTestId }: any) => <div data-testid={dataTestId}>{children}</div>,
	SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
	StandardTooltip: ({ children }: any) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextArea: ({ value, onChange, onInput, "data-testid": dataTestId, ...props }: any) => (
		<>
			<textarea
				value={value}
				onChange={onChange}
				onInput={onInput}
				data-testid={dataTestId ?? "support-prompt-textarea"}
				{...props}
			/>
			<button
				data-testid={`${dataTestId ?? "support-prompt-textarea"}-detail-input`}
				onClick={() => onInput?.({ detail: { target: { value: "from detail" } } })}
			/>
		</>
	),
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			<input
				type="checkbox"
				data-testid="include-history-checkbox"
				checked={!!checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
			/>
			{/* The toolkit can emit an event without a target; the component has to survive it. */}
			<button data-testid="include-history-no-target" onClick={() => onChange({})} />
			{children}
		</label>
	),
}))

const state = vi.hoisted(() => ({
	listApiConfigMeta: [{ id: "config-1", name: "Config One" }],
	enhancementApiConfigId: "",
	setEnhancementApiConfigId: vi.fn(),
	includeTaskHistoryInEnhance: undefined as boolean | undefined,
	setIncludeTaskHistoryInEnhance: vi.fn(),
}))

vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

const renderSettings = (props: Partial<React.ComponentProps<typeof PromptsSettings>> = {}) =>
	render(<PromptsSettings customSupportPrompts={{}} setCustomSupportPrompts={vi.fn()} {...props} />)

describe("PromptsSettings — editing a support prompt", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.enhancementApiConfigId = ""
		state.includeTaskHistoryInEnhance = undefined
	})

	it("stores what was typed for the selected prompt", () => {
		const setCustomSupportPrompts = vi.fn()
		renderSettings({ setCustomSupportPrompts })

		fireEvent.input(screen.getByTestId("support-prompt-textarea"), { target: { value: "my enhance prompt" } })

		expect(setCustomSupportPrompts).toHaveBeenCalledWith({ ENHANCE: "my enhance prompt" })
	})

	it("takes the value from the toolkit's own event shape too", () => {
		const setCustomSupportPrompts = vi.fn()
		renderSettings({ setCustomSupportPrompts })

		fireEvent.click(screen.getByTestId("support-prompt-textarea-detail-input"))

		expect(setCustomSupportPrompts).toHaveBeenCalledWith({ ENHANCE: "from detail" })
	})

	it("keeps an empty prompt rather than deleting it", () => {
		const setCustomSupportPrompts = vi.fn()
		renderSettings({ customSupportPrompts: { ENHANCE: "old" }, setCustomSupportPrompts })

		fireEvent.input(screen.getByTestId("support-prompt-textarea"), { target: { value: "" } })

		expect(setCustomSupportPrompts).toHaveBeenCalledWith({ ENHANCE: "" })
	})

	it("forgets the custom prompt when it is reset", () => {
		const setCustomSupportPrompts = vi.fn()
		renderSettings({ customSupportPrompts: { ENHANCE: "mine" }, setCustomSupportPrompts })

		fireEvent.click(document.querySelector(".codicon-discard")!.closest("button")!)

		expect(setCustomSupportPrompts).toHaveBeenCalledWith({})
	})

	it("switches to another support prompt", () => {
		renderSettings()

		fireEvent.click(screen.getAllByTestId("pick-condense")[0])

		// The enhance-only section disappears once another prompt is selected.
		expect(screen.queryByTestId("api-config-select")).not.toBeInTheDocument()
	})
})

describe("PromptsSettings — the enhance preview", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.enhancementApiConfigId = ""
		state.includeTaskHistoryInEnhance = undefined
	})

	const previewButton = () => screen.getByText("prompts:supportPrompts.enhance.previewButton").closest("button")!

	it("does nothing for an empty test prompt", () => {
		renderSettings()

		fireEvent.click(previewButton())

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("asks the extension to enhance the prompt and waits for the answer", () => {
		renderSettings()
		fireEvent.change(screen.getByTestId("test-prompt-textarea"), { target: { value: "please enhance" } })

		fireEvent.click(previewButton())

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "enhancePrompt", text: "please enhance" })
		expect(previewButton()).toBeDisabled()
	})

	it("shows the enhanced prompt when it arrives", () => {
		renderSettings()
		fireEvent.change(screen.getByTestId("test-prompt-textarea"), { target: { value: "please enhance" } })
		fireEvent.click(previewButton())

		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "enhancedPrompt", text: "much better" } }))
		})

		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("much better")
		expect(previewButton()).toBeEnabled()
	})

	it("stops waiting even when the answer carries no text", () => {
		renderSettings()
		fireEvent.change(screen.getByTestId("test-prompt-textarea"), { target: { value: "please enhance" } })
		fireEvent.click(previewButton())

		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "enhancedPrompt" } }))
		})

		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("please enhance")
		expect(previewButton()).toBeEnabled()
	})

	it("ignores messages meant for something else", () => {
		renderSettings()
		fireEvent.change(screen.getByTestId("test-prompt-textarea"), { target: { value: "please enhance" } })

		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "somethingElse", text: "nope" } }))
		})

		expect(screen.getByTestId("test-prompt-textarea")).toHaveValue("please enhance")
	})
})

describe("PromptsSettings — which configuration enhances", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.enhancementApiConfigId = ""
		state.includeTaskHistoryInEnhance = undefined
	})

	it("lists the available configurations", () => {
		renderSettings()

		expect(screen.getByTestId("config-1-option")).toHaveTextContent("Config One")
	})

	it("copes with no configurations at all", () => {
		const previous = state.listApiConfigMeta
		state.listApiConfigMeta = undefined as never

		renderSettings()

		expect(screen.getByTestId("api-config-select")).toBeInTheDocument()
		state.listApiConfigMeta = previous
	})

	it("remembers the chosen configuration", () => {
		renderSettings()

		fireEvent.click(screen.getAllByTestId("pick-config")[1])

		expect(state.setEnhancementApiConfigId).toHaveBeenCalledWith("config-1")
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "enhancementApiConfigId", text: "config-1" })
	})

	it("falls back to the current configuration", () => {
		state.enhancementApiConfigId = "config-1"
		renderSettings()

		fireEvent.click(screen.getAllByTestId("pick-none")[1])

		expect(state.setEnhancementApiConfigId).toHaveBeenCalledWith("")
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "enhancementApiConfigId", text: "-" })
	})

	it("includes the task history by default and saves a change", () => {
		renderSettings()
		const checkbox = screen.getByTestId("include-history-checkbox")

		expect(checkbox).toBeChecked()

		fireEvent.click(checkbox)

		expect(state.setIncludeTaskHistoryInEnhance).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { includeTaskHistoryInEnhance: false },
		})
	})

	it("prefers the value it was handed over the stored one", () => {
		state.includeTaskHistoryInEnhance = true
		const setIncludeTaskHistoryInEnhance = vi.fn()
		renderSettings({ includeTaskHistoryInEnhance: false, setIncludeTaskHistoryInEnhance })

		expect(screen.getByTestId("include-history-checkbox")).not.toBeChecked()

		fireEvent.click(screen.getByTestId("include-history-checkbox"))

		expect(setIncludeTaskHistoryInEnhance).toHaveBeenCalledWith(true)
		expect(state.setIncludeTaskHistoryInEnhance).not.toHaveBeenCalled()
	})

	it("uses the stored value when nothing was handed in", () => {
		state.includeTaskHistoryInEnhance = false
		renderSettings()

		expect(screen.getByTestId("include-history-checkbox")).not.toBeChecked()
	})
	it("ignores a change event that carries no target", () => {
		renderSettings()

		fireEvent.click(screen.getByTestId("include-history-no-target"))

		expect(state.setIncludeTaskHistoryInEnhance).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
