import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { AutoApproveSettings } from "../AutoApproveSettings"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ components }: any) => <span>{components?.SettingsLink}</span>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, checked, onChange, "aria-label": ariaLabel, "data-testid": dataTestId }: any) => (
		<label>
			<input
				type="checkbox"
				aria-label={ariaLabel}
				data-testid={dataTestId}
				checked={!!checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
			/>
			{children}
		</label>
	),
}))

vi.mock("@/components/ui", async () => {
	const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui")
	return {
		...actual,
		// min/max/step must be forwarded, otherwise the range input clamps to its 0-100 default
		// and the component's own bounds are never exercised.
		Slider: ({ value, onValueChange, min, max, step, "data-testid": dataTestId }: any) => (
			<input
				type="range"
				data-testid={dataTestId}
				min={min}
				max={max}
				step={step}
				value={value[0]}
				onChange={(e) => onValueChange([Number(e.target.value)])}
			/>
		),
	}
})

vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: any) => <div>{children}</div>,
}))

vi.mock("../SectionHeader", () => ({ SectionHeader: ({ children }: any) => <div>{children}</div> }))
vi.mock("../Section", () => ({ Section: ({ children }: any) => <div>{children}</div> }))

vi.mock("../AutoApproveToggle", () => ({
	AutoApproveToggle: ({ onToggle }: any) => (
		<button data-testid="auto-approve-toggle" onClick={() => onToggle("alwaysAllowWrite", true)} />
	),
	autoApproveSettingsConfig: {},
}))

vi.mock("../MaxLimitInputs", () => ({
	MaxLimitInputs: ({ onMaxRequestsChange, onMaxCostChange }: any) => (
		<div>
			<button data-testid="set-max-requests" onClick={() => onMaxRequestsChange(5)} />
			<button data-testid="set-max-cost" onClick={() => onMaxCostChange(1.5)} />
		</div>
	),
}))

const state = vi.hoisted(() => ({
	autoApprovalEnabled: true as boolean | undefined,
	setAutoApprovalEnabled: vi.fn(),
	alwaysAllowReadOnly: false,
	alwaysAllowWrite: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowSubtasks: false,
	alwaysAllowFollowupQuestions: false,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

const setCachedStateField = vi.fn()

const renderSettings = (props: Record<string, unknown> = {}) =>
	render(<AutoApproveSettings setCachedStateField={setCachedStateField} {...props} />)

describe("AutoApproveSettings — the master switch", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.autoApprovalEnabled = true
	})

	it("turns auto-approval off and remembers it", () => {
		renderSettings()

		fireEvent.click(screen.getByLabelText("settings:autoApprove.toggleAriaLabel"))

		expect(state.setAutoApprovalEnabled).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "autoApprovalEnabled", bool: false })
	})

	it("treats an unset switch as off", () => {
		state.autoApprovalEnabled = undefined
		renderSettings()

		fireEvent.click(screen.getByLabelText("settings:autoApprove.toggleAriaLabel"))

		expect(state.setAutoApprovalEnabled).toHaveBeenCalledWith(true)
	})

	it("opens the keyboard shortcuts for the toggle command", () => {
		const { container } = renderSettings()

		fireEvent.click(container.querySelector("a")!)

		expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "openKeyboardShortcuts" }))
	})

	it("saves the request and cost limits", () => {
		renderSettings()

		fireEvent.click(screen.getByTestId("set-max-requests"))
		fireEvent.click(screen.getByTestId("set-max-cost"))

		expect(setCachedStateField).toHaveBeenCalledWith("allowedMaxRequests", 5)
		expect(setCachedStateField).toHaveBeenCalledWith("allowedMaxCost", 1.5)
	})
})

describe("AutoApproveSettings — command lists", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.autoApprovalEnabled = true
	})

	it("shows the command lists only when command execution is auto-approved", () => {
		const { rerender } = renderSettings()
		expect(screen.queryByTestId("command-input")).not.toBeInTheDocument()

		rerender(<AutoApproveSettings setCachedStateField={setCachedStateField} alwaysAllowExecute />)

		expect(screen.getByTestId("command-input")).toBeInTheDocument()
	})

	it("adds an allowed command and clears the box", () => {
		renderSettings({ alwaysAllowExecute: true, allowedCommands: ["npm test"] })

		fireEvent.change(screen.getByTestId("command-input"), { target: { value: "git status" } })
		fireEvent.click(screen.getByTestId("add-command-button"))

		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["npm test", "git status"])
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { allowedCommands: ["npm test", "git status"] },
		})
		expect(screen.getByTestId("command-input")).toHaveValue("")
	})

	it("adds an allowed command with the Enter key", () => {
		renderSettings({ alwaysAllowExecute: true })

		fireEvent.change(screen.getByTestId("command-input"), { target: { value: "git status" } })
		fireEvent.keyDown(screen.getByTestId("command-input"), { key: "Enter" })

		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["git status"])
	})

	it("ignores an empty or duplicate allowed command", () => {
		renderSettings({ alwaysAllowExecute: true, allowedCommands: ["npm test"] })

		fireEvent.click(screen.getByTestId("add-command-button"))
		fireEvent.change(screen.getByTestId("command-input"), { target: { value: "npm test" } })
		fireEvent.click(screen.getByTestId("add-command-button"))

		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("removes exactly the allowed command that was clicked", () => {
		renderSettings({ alwaysAllowExecute: true, allowedCommands: ["a", "b", "c"] })

		fireEvent.click(screen.getByTestId("remove-command-1"))

		expect(setCachedStateField).toHaveBeenCalledWith("allowedCommands", ["a", "c"])
	})

	it("adds a denied command and clears the box", () => {
		renderSettings({ alwaysAllowExecute: true, deniedCommands: ["rm -rf"] })

		fireEvent.change(screen.getByTestId("denied-command-input"), { target: { value: "shutdown" } })
		fireEvent.click(screen.getByTestId("add-denied-command-button"))

		expect(setCachedStateField).toHaveBeenCalledWith("deniedCommands", ["rm -rf", "shutdown"])
		expect(screen.getByTestId("denied-command-input")).toHaveValue("")
	})

	it("adds a denied command with the Enter key", () => {
		renderSettings({ alwaysAllowExecute: true })

		fireEvent.change(screen.getByTestId("denied-command-input"), { target: { value: "shutdown" } })
		fireEvent.keyDown(screen.getByTestId("denied-command-input"), { key: "Enter" })

		expect(setCachedStateField).toHaveBeenCalledWith("deniedCommands", ["shutdown"])
	})

	it("ignores an empty or duplicate denied command", () => {
		renderSettings({ alwaysAllowExecute: true, deniedCommands: ["rm -rf"] })

		fireEvent.click(screen.getByTestId("add-denied-command-button"))
		fireEvent.change(screen.getByTestId("denied-command-input"), { target: { value: "rm -rf" } })
		fireEvent.click(screen.getByTestId("add-denied-command-button"))

		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("removes exactly the denied command that was clicked", () => {
		renderSettings({ alwaysAllowExecute: true, deniedCommands: ["a", "b", "c"] })

		fireEvent.click(screen.getByTestId("remove-denied-command-2"))

		expect(setCachedStateField).toHaveBeenCalledWith("deniedCommands", ["a", "b"])
	})

	it("ignores other keys in the command boxes", () => {
		renderSettings({ alwaysAllowExecute: true })

		fireEvent.change(screen.getByTestId("command-input"), { target: { value: "git status" } })
		fireEvent.keyDown(screen.getByTestId("command-input"), { key: "a" })

		expect(setCachedStateField).not.toHaveBeenCalled()
	})
})

describe("AutoApproveSettings — follow-up questions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.autoApprovalEnabled = true
	})

	it("shows the timeout only when follow-up questions are auto-approved", () => {
		const { rerender } = renderSettings()
		expect(screen.queryByTestId("followup-timeout-slider")).not.toBeInTheDocument()

		rerender(<AutoApproveSettings setCachedStateField={setCachedStateField} alwaysAllowFollowupQuestions />)

		expect(screen.getByTestId("followup-timeout-slider")).toBeInTheDocument()
	})

	it("shows the timeout in seconds and saves what the slider reports", () => {
		renderSettings({ alwaysAllowFollowupQuestions: true, followupAutoApproveTimeoutMs: 30000 })

		expect(screen.getByText("30s")).toBeInTheDocument()

		fireEvent.change(screen.getByTestId("followup-timeout-slider"), { target: { value: "45000" } })

		expect(setCachedStateField).toHaveBeenCalledWith("followupAutoApproveTimeoutMs", 45000)
	})
})

describe("AutoApproveSettings — the nested read and write options", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.autoApprovalEnabled = true
	})

	it("saves whether reading outside the workspace is allowed", () => {
		renderSettings({ alwaysAllowReadOnly: true })

		fireEvent.click(screen.getByTestId("always-allow-readonly-outside-workspace-checkbox")!)

		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowReadOnlyOutsideWorkspace", true)
	})

	it("saves whether writing outside the workspace is allowed", () => {
		renderSettings({ alwaysAllowWrite: true })

		fireEvent.click(screen.getByTestId("always-allow-write-outside-workspace-checkbox")!)

		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowWriteOutsideWorkspace", true)
	})

	it("saves whether protected files may be written", () => {
		renderSettings({ alwaysAllowWrite: true })

		fireEvent.click(screen.getByTestId("always-allow-write-protected-checkbox")!)

		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowWriteProtected", true)
	})

	it("keeps the nested options hidden until their parent is on", () => {
		renderSettings()

		expect(screen.queryByTestId("always-allow-readonly-outside-workspace-checkbox")).not.toBeInTheDocument()
		expect(screen.queryByTestId("always-allow-write-protected-checkbox")).not.toBeInTheDocument()
	})
	it("saves a permission toggled in the grid", () => {
		renderSettings()

		fireEvent.click(screen.getByTestId("auto-approve-toggle"))

		expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowWrite", true)
	})
})
