import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { AutoApproveDropdown } from "../AutoApproveDropdown"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "count" in options ? `${key}:${options.count}` : key,
	}),
}))

vi.mock("@/components/ui/hooks/useAgentPortal", () => ({ useAgentPortal: () => document.body }))

const state = vi.hoisted(() => ({
	autoApprovalEnabled: true as boolean | undefined,
	alwaysAllowReadOnly: false,
	alwaysAllowWrite: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowSubtasks: false,
	alwaysAllowFollowupQuestions: false,
	setAutoApprovalEnabled: vi.fn(),
	setAlwaysAllowReadOnly: vi.fn(),
	setAlwaysAllowWrite: vi.fn(),
	setAlwaysAllowExecute: vi.fn(),
	setAlwaysAllowMcp: vi.fn(),
	setAlwaysAllowSubtasks: vi.fn(),
	setAlwaysAllowFollowupQuestions: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

const open = () => fireEvent.click(screen.getByTestId("auto-approve-dropdown-trigger"))

const reset = (overrides: Partial<typeof state> = {}) => {
	Object.assign(state, {
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: false,
		alwaysAllowWrite: false,
		alwaysAllowExecute: false,
		alwaysAllowMcp: false,
		alwaysAllowSubtasks: false,
		alwaysAllowFollowupQuestions: false,
		...overrides,
	})
}

describe("AutoApproveDropdown — the trigger", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		reset()
	})

	it("says how many permissions are on", () => {
		reset({ alwaysAllowReadOnly: true, alwaysAllowWrite: true })

		render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toHaveTextContent("chat:autoApprove.triggerLabel:2")
	})

	it("says so when every permission is on", () => {
		reset({
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: true,
			alwaysAllowExecute: true,
			alwaysAllowMcp: true,
			alwaysAllowSubtasks: true,
			alwaysAllowFollowupQuestions: true,
		})

		render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toHaveTextContent(
			"chat:autoApprove.triggerLabelAll",
		)
	})

	it("counts zero when auto-approval is on but nothing is permitted yet", () => {
		const { container } = render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toHaveTextContent("chat:autoApprove.triggerLabel:0")
		expect(container.querySelector(".lucide-check-check")).toBeInTheDocument()
	})

	it("shows the off state while auto-approval is switched off", () => {
		reset({ autoApprovalEnabled: false })

		const { container } = render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toHaveTextContent(
			"chat:autoApprove.triggerLabelOff",
		)
		expect(container.querySelector(".lucide-x")).toBeInTheDocument()
	})

	it("shows the on state once something is approved automatically", () => {
		reset({ alwaysAllowReadOnly: true })

		const { container } = render(<AutoApproveDropdown />)

		expect(container.querySelector(".lucide-check-check")).toBeInTheDocument()
	})

	it("shows the off state while the master switch is off", () => {
		reset({ autoApprovalEnabled: false, alwaysAllowReadOnly: true })

		render(<AutoApproveDropdown />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger")).toHaveTextContent(
			"chat:autoApprove.triggerLabelOff",
		)
	})

	it("cannot be opened while disabled", () => {
		render(<AutoApproveDropdown disabled />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger").className).toContain("cursor-not-allowed")
		open()
		expect(screen.queryByTestId("auto-approve-alwaysAllowReadOnly")).not.toBeInTheDocument()
	})

	it("keeps any extra styling it was handed", () => {
		render(<AutoApproveDropdown triggerClassName="my-trigger" />)

		expect(screen.getByTestId("auto-approve-dropdown-trigger").className).toContain("my-trigger")
	})
})

describe("AutoApproveDropdown — changing permissions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		reset({ alwaysAllowReadOnly: true })
	})

	it("saves the change and updates the local state", () => {
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(screen.getByTestId("auto-approve-alwaysAllowWrite"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { alwaysAllowWrite: true },
		})
		expect(state.setAlwaysAllowWrite).toHaveBeenCalledWith(true)
	})

	it("turns a permission back off", () => {
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(screen.getByTestId("auto-approve-alwaysAllowReadOnly"))

		expect(state.setAlwaysAllowReadOnly).toHaveBeenCalledWith(false)
	})

	it("routes every permission to its own setter", () => {
		render(<AutoApproveDropdown />)
		open()

		for (const key of [
			"alwaysAllowExecute",
			"alwaysAllowMcp",
			"alwaysAllowSubtasks",
			"alwaysAllowFollowupQuestions",
		] as const) {
			fireEvent.click(screen.getByTestId(`auto-approve-${key}`))
		}

		expect(state.setAlwaysAllowExecute).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowMcp).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowSubtasks).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowFollowupQuestions).toHaveBeenCalledWith(true)
	})

	it("leaves the master switch alone when a permission is turned off", () => {
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(screen.getByTestId("auto-approve-alwaysAllowReadOnly"))

		expect(state.setAutoApprovalEnabled).not.toHaveBeenCalled()
	})

	it("turns everything on at once", () => {
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(screen.getByRole("button", { name: "chat:autoApprove.selectAll" }))

		expect(state.setAlwaysAllowWrite).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowFollowupQuestions).toHaveBeenCalledWith(true)
	})

	it("turns the master switch on when everything is selected while it was off", () => {
		reset({ autoApprovalEnabled: false })
		render(<AutoApproveDropdown />)
		open()

		// The dropdown is disabled while auto-approval is off, so the state change comes from
		// the toggle itself.
		fireEvent.click(screen.getByLabelText("Toggle auto-approval"))

		expect(state.setAutoApprovalEnabled).toHaveBeenCalledWith(true)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "autoApprovalEnabled", bool: true })
	})

	it("turns everything off at once", () => {
		reset({ alwaysAllowReadOnly: true, alwaysAllowWrite: true })
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(screen.getByRole("button", { name: "chat:autoApprove.selectNone" }))

		expect(state.setAlwaysAllowReadOnly).toHaveBeenCalledWith(false)
		expect(state.setAlwaysAllowWrite).toHaveBeenCalledWith(false)
		expect(state.setAutoApprovalEnabled).not.toHaveBeenCalled()
	})

	it("locks the permission buttons while auto-approval is off", () => {
		reset({ autoApprovalEnabled: false })
		render(<AutoApproveDropdown />)
		open()

		expect(screen.getByTestId("auto-approve-alwaysAllowWrite")).toBeDisabled()
		expect(screen.getByRole("button", { name: "chat:autoApprove.selectAll" })).toBeDisabled()
	})

	it("switches auto-approval off again from the toggle", () => {
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(screen.getByLabelText("Toggle auto-approval"))

		expect(state.setAutoApprovalEnabled).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "autoApprovalEnabled", bool: false })
	})

	it("treats an unset master switch as off", () => {
		reset({ autoApprovalEnabled: undefined, alwaysAllowReadOnly: true })
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(screen.getByLabelText("Toggle auto-approval"))

		expect(state.setAutoApprovalEnabled).toHaveBeenCalledWith(true)
	})

	it("toggles auto-approval when the label next to the switch is clicked", () => {
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(screen.getByText("Enabled"))

		expect(state.setAutoApprovalEnabled).toHaveBeenCalledTimes(1)
	})

	it("does not toggle twice when the switch itself is clicked", () => {
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(screen.getByLabelText("Toggle auto-approval"))

		expect(state.setAutoApprovalEnabled).toHaveBeenCalledTimes(1)
	})

	it("opens the auto-approve settings section", () => {
		// jsdom's postMessage insists on a targetOrigin, which browsers do not require here.
		const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => {})
		render(<AutoApproveDropdown />)
		open()

		fireEvent.click(document.querySelector(".lucide-settings")!)

		expect(postMessage).toHaveBeenCalledWith({
			type: "action",
			action: "settingsButtonClicked",
			values: { section: "autoApprove" },
		})
		postMessage.mockRestore()
	})
})
