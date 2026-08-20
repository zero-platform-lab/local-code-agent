import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, afterEach } from "vitest"
import { UISettings } from "../UISettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		// Echo interpolation params so the platform-specific modifier is assertable.
		t: (key: string, params?: Record<string, unknown>) =>
			params?.primaryMod ? `${key}:${params.primaryMod}` : key,
	}),
}))

const setPlatform = (value: string) => {
	Object.defineProperty(navigator, "platform", { value, configurable: true })
}

describe("UISettings", () => {
	afterEach(() => {
		setPlatform("")
	})
	const defaultProps = {
		reasoningBlockCollapsed: false,
		enterBehavior: "send" as const,
		setCachedStateField: vi.fn(),
	}

	it("renders the collapse thinking checkbox", () => {
		const { getByTestId } = render(<UISettings {...defaultProps} />)
		const checkbox = getByTestId("collapse-thinking-checkbox")
		expect(checkbox).toBeTruthy()
	})

	it("displays the correct initial state", () => {
		const { getByTestId } = render(<UISettings {...defaultProps} reasoningBlockCollapsed={true} />)
		const checkbox = getByTestId("collapse-thinking-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("calls setCachedStateField when checkbox is toggled", async () => {
		const setCachedStateField = vi.fn()
		const { getByTestId } = render(<UISettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		const checkbox = getByTestId("collapse-thinking-checkbox")
		fireEvent.click(checkbox)

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("reasoningBlockCollapsed", true)
		})
	})

	it("updates checkbox state when prop changes", () => {
		const { getByTestId, rerender } = render(<UISettings {...defaultProps} reasoningBlockCollapsed={false} />)
		const checkbox = getByTestId("collapse-thinking-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(false)

		rerender(<UISettings {...defaultProps} reasoningBlockCollapsed={true} />)
		expect(checkbox.checked).toBe(true)
	})

	it("reflects enterBehavior='newline' as a checked enter-behavior checkbox", () => {
		const { getByTestId } = render(<UISettings {...defaultProps} enterBehavior="newline" />)
		const checkbox = getByTestId("enter-behavior-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("sets enterBehavior to 'newline' when the checkbox is checked", async () => {
		const setCachedStateField = vi.fn()
		const { getByTestId } = render(
			<UISettings {...defaultProps} enterBehavior="send" setCachedStateField={setCachedStateField} />,
		)
		fireEvent.click(getByTestId("enter-behavior-checkbox"))
		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("enterBehavior", "newline")
		})
	})

	it("sets enterBehavior to 'send' when the checkbox is unchecked", async () => {
		const setCachedStateField = vi.fn()
		const { getByTestId } = render(
			<UISettings {...defaultProps} enterBehavior="newline" setCachedStateField={setCachedStateField} />,
		)
		fireEvent.click(getByTestId("enter-behavior-checkbox"))
		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("enterBehavior", "send")
		})
	})

	it("uses the ⌘ modifier label on macOS", () => {
		setPlatform("MacIntel")
		render(<UISettings {...defaultProps} />)
		expect(screen.getByText(/settings:ui\.requireCtrlEnterToSend\.label:⌘/)).toBeInTheDocument()
	})

	it("uses the Ctrl modifier label on non-mac platforms", () => {
		setPlatform("Win32")
		render(<UISettings {...defaultProps} />)
		expect(screen.getByText(/settings:ui\.requireCtrlEnterToSend\.label:Ctrl/)).toBeInTheDocument()
	})
})
