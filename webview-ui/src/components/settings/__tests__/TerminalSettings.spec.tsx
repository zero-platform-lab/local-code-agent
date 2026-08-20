// npx vitest src/components/settings/__tests__/TerminalSettings.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { TerminalSettings } from "../TerminalSettings"

// Mock vscode
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

import { vscode } from "@/utils/vscode"

// Mock VSCode components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children, "data-testid": dataTestId, ...props }: any) => (
		<label data-testid={dataTestId} {...props}>
			<input
				type="checkbox"
				role="checkbox"
				checked={checked || false}
				aria-checked={checked || false}
				onChange={(e: any) => onChange?.({ target: { checked: e.target.checked } })}
			/>
			{children}
		</label>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

// Mock UI components
vi.mock("@/components/ui", () => ({
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			<select value={value} onChange={(e) => onValueChange?.(e.target.value)}>
				{children}
			</select>
		</div>
	),
	SelectTrigger: ({ children, "data-testid": dataTestId }: any) => <div data-testid={dataTestId}>{children}</div>,
	SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
	Slider: ({ value, onValueChange, min, max, step }: any) => (
		<>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value?.[0] ?? 0}
				onChange={(e) => onValueChange?.([parseFloat(e.target.value)])}
				data-testid={`slider-${max}`}
			/>
			{/* range 入力は jsdom 側で min/max に丸められてしまい、コンポーネント自身の
			    クランプを踏めない。生値をそのまま onValueChange に流す入口を用意する。 */}
			<button
				data-testid={`slider-raw-${max}`}
				onClick={(e) => onValueChange?.([Number((e.currentTarget as HTMLButtonElement).dataset.raw)])}
			/>
		</>
	),
}))

// Mock SearchableSetting/SectionHeader/Section
vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: any) => <div>{children}</div>,
}))
vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: any) => <div data-testid="section-header">{children}</div>,
}))
vi.mock("../Section", () => ({
	Section: ({ children }: any) => <div>{children}</div>,
}))

describe("TerminalSettings", () => {
	const mockSetCachedStateField = vi.fn()

	const defaultProps = {
		setCachedStateField: mockSetCachedStateField,
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders section header", () => {
		render(<TerminalSettings {...defaultProps} />)
		expect(screen.getByTestId("section-header")).toBeInTheDocument()
	})

	it("sends getVSCodeSetting message on mount", () => {
		render(<TerminalSettings {...defaultProps} />)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "getVSCodeSetting",
			setting: "terminal.integrated.inheritEnv",
		})
	})

	it("renders output preview size selector with default 'medium'", () => {
		render(<TerminalSettings {...defaultProps} />)
		const select = screen.getByTestId("terminal-output-preview-size-dropdown")
		expect(select).toBeInTheDocument()
	})

	it("updates terminalOutputPreviewSize when changed", () => {
		render(<TerminalSettings {...defaultProps} />)
		const select = screen.getByTestId("select")
		const selectElement = select.querySelector("select")!
		fireEvent.change(selectElement, { target: { value: "large" } })
		expect(mockSetCachedStateField).toHaveBeenCalledWith("terminalOutputPreviewSize", "large")
	})

	it("renders shell integration disabled checkbox checked by default", () => {
		render(<TerminalSettings {...defaultProps} />)
		// terminalShellIntegrationDisabled defaults to true
		const checkboxes = screen.getAllByRole("checkbox")
		// First checkbox after output preview is shell integration disabled
		const shellIntCheckbox = checkboxes.find((cb) => {
			const label = cb.closest("label")
			return label?.textContent?.includes("settings:terminal.shellIntegrationDisabled.label")
		})
		expect(shellIntCheckbox).toBeChecked()
	})

	it("calls setCachedStateField when shell integration disabled is toggled", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={true} />)
		const checkboxes = screen.getAllByRole("checkbox")
		const shellIntCheckbox = checkboxes.find((cb) => {
			const label = cb.closest("label")
			return label?.textContent?.includes("settings:terminal.shellIntegrationDisabled.label")
		})
		fireEvent.click(shellIntCheckbox!)
		expect(mockSetCachedStateField).toHaveBeenCalledWith("terminalShellIntegrationDisabled", false)
	})

	it("does NOT show advanced settings when shell integration is disabled", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={true} />)
		// When shell integration is disabled (true), advanced settings are hidden
		expect(screen.queryByTestId("terminal-inherit-env-checkbox")).not.toBeInTheDocument()
		expect(screen.queryByTestId("terminal-zdotdir-checkbox")).not.toBeInTheDocument()
	})

	it("shows all advanced settings when shell integration is enabled (disabled=false)", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)
		expect(screen.getByTestId("terminal-inherit-env-checkbox")).toBeInTheDocument()
		expect(screen.getByTestId("terminal-zdotdir-checkbox")).toBeInTheDocument()
	})

	it("updates inheritEnv via vscode message when checkbox changed", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)
		const checkbox = screen.getByTestId("terminal-inherit-env-checkbox").querySelector("input")!
		fireEvent.click(checkbox)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateVSCodeSetting",
			setting: "terminal.integrated.inheritEnv",
			value: false,
		})
	})

	it("updates zdotdir when toggled", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} terminalZdotdir={false} />)
		const checkbox = screen.getByTestId("terminal-zdotdir-checkbox").querySelector("input")!
		fireEvent.click(checkbox)
		expect(mockSetCachedStateField).toHaveBeenCalledWith("terminalZdotdir", true)
	})

	it("handles vsCodeSetting message for inheritEnv", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)

		// Simulate receiving a message from extension
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "vsCodeSetting",
						setting: "terminal.integrated.inheritEnv",
						value: false,
					},
				}),
			)
		})

		// The checkbox should now be unchecked
		const checkbox = screen.getByTestId("terminal-inherit-env-checkbox").querySelector("input")!
		expect(checkbox).not.toBeChecked()
	})

	it("handles vsCodeSetting message with null value (defaults to true)", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "vsCodeSetting",
						setting: "terminal.integrated.inheritEnv",
						value: null,
					},
				}),
			)
		})

		const checkbox = screen.getByTestId("terminal-inherit-env-checkbox").querySelector("input")!
		expect(checkbox).toBeChecked()
	})

	it("ignores unrelated message types", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "someOtherType",
					},
				}),
			)
		})

		// Should not crash and inheritEnv should still be true (default)
		const checkbox = screen.getByTestId("terminal-inherit-env-checkbox").querySelector("input")!
		expect(checkbox).toBeChecked()
	})

	it("ignores unrelated vsCodeSetting settings", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "vsCodeSetting",
						setting: "some.other.setting",
						value: false,
					},
				}),
			)
		})

		// inheritEnv should still be true (default)
		const checkbox = screen.getByTestId("terminal-inherit-env-checkbox").querySelector("input")!
		expect(checkbox).toBeChecked()
	})

	it("updates shellIntegrationTimeout slider", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)
		// 既定値は DEFAULT_SHELL_INTEGRATION_TIMEOUT_MS(=5000) なので、別の値に動かす。
		fireEvent.change(screen.getByTestId("slider-60000"), { target: { value: "10000" } })
		expect(mockSetCachedStateField).toHaveBeenCalledWith("terminalShellIntegrationTimeout", 10000)
	})

	it("clamps shellIntegrationTimeout above the maximum", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)
		const raw = screen.getByTestId("slider-raw-60000")
		raw.dataset.raw = "70000"
		fireEvent.click(raw)
		expect(mockSetCachedStateField).toHaveBeenCalledWith("terminalShellIntegrationTimeout", 60000)
	})

	it("clamps shellIntegrationTimeout below the minimum", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)
		const raw = screen.getByTestId("slider-raw-60000")
		raw.dataset.raw = "0"
		fireEvent.click(raw)
		expect(mockSetCachedStateField).toHaveBeenCalledWith("terminalShellIntegrationTimeout", 1000)
	})

	it("updates command delay slider", () => {
		render(
			<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} terminalCommandDelay={100} />,
		)
		fireEvent.change(screen.getByTestId("slider-1000"), { target: { value: "500" } })
		expect(mockSetCachedStateField).toHaveBeenCalledWith("terminalCommandDelay", 500)
	})

	it("clamps command delay above the maximum", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)
		const raw = screen.getByTestId("slider-raw-1000")
		raw.dataset.raw = "2000"
		fireEvent.click(raw)
		expect(mockSetCachedStateField).toHaveBeenCalledWith("terminalCommandDelay", 1000)
	})

	it("clamps command delay below the minimum", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)
		const raw = screen.getByTestId("slider-raw-1000")
		raw.dataset.raw = "-50"
		fireEvent.click(raw)
		expect(mockSetCachedStateField).toHaveBeenCalledWith("terminalCommandDelay", 0)
	})

	it("passes className and additional props", () => {
		const { container } = render(<TerminalSettings {...defaultProps} className="custom-class" data-extra="test" />)
		const rootDiv = container.firstChild as HTMLElement
		expect(rootDiv.className).toContain("custom-class")
		expect(rootDiv.getAttribute("data-extra")).toBe("test")
	})

	it("displays correct timeout value in seconds", () => {
		render(
			<TerminalSettings
				{...defaultProps}
				terminalShellIntegrationDisabled={false}
				terminalShellIntegrationTimeout={15000}
			/>,
		)
		expect(screen.getByText("15s")).toBeInTheDocument()
	})

	it("displays correct delay value in ms", () => {
		render(
			<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} terminalCommandDelay={200} />,
		)
		expect(screen.getByText("200ms")).toBeInTheDocument()
	})

	it("uses default terminalCommandDelay display (50ms) when prop is undefined", () => {
		render(<TerminalSettings {...defaultProps} terminalShellIntegrationDisabled={false} />)
		// When terminalCommandDelay is undefined, display shows 50ms (default for display)
		expect(screen.getByText("50ms")).toBeInTheDocument()
	})
})
