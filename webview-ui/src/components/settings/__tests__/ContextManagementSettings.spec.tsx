// npx vitest src/components/settings/__tests__/ContextManagementSettings.spec.tsx

import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import { ContextManagementSettings } from "../ContextManagementSettings"

// Mock the translation hook
vi.mock("@/hooks/useAppTranslation", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			// Return specific translations for our test cases
			if (key === "settings:contextManagement.diagnostics.maxMessages.unlimitedLabel") {
				return "Unlimited"
			}
			return key
		},
	}),
}))

// Mock the UI components
vi.mock("@/components/ui", () => ({
	...vi.importActual("@/components/ui"),
	Slider: ({ value, onValueChange, "data-testid": dataTestId, disabled, min, max }: any) => (
		<input
			type="range"
			value={value?.[0] ?? 0}
			min={min}
			max={max}
			onChange={(e) => onValueChange([parseFloat(e.target.value)])}
			onKeyDown={(e) => {
				const currentValue = value?.[0] ?? 0
				if (e.key === "ArrowRight") {
					onValueChange([currentValue + 1])
				} else if (e.key === "ArrowLeft") {
					onValueChange([currentValue - 1])
				}
			}}
			data-testid={dataTestId}
			disabled={disabled}
			role="slider"
		/>
	),
	Input: ({ value, onChange, "data-testid": dataTestId, ...props }: any) => (
		<input value={value} onChange={onChange} data-testid={dataTestId} {...props} />
	),
	Button: ({ children, onClick, ...props }: any) => (
		<button onClick={onClick} {...props}>
			{children}
		</button>
	),
	Select: ({ children, onValueChange, value, ...props }: any) => (
		<div role="combobox" data-value={value} {...props}>
			<button data-testid="pick-default-profile" onClick={() => onValueChange?.("default")} />
			<button data-testid="pick-profile-a" onClick={() => onValueChange?.("profile-a")} />
			<button data-testid="pick-profile-b" onClick={() => onValueChange?.("profile-b")} />
			{children}
		</div>
	),
	SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectValue: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectItem: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
}))

// Mock vscode utilities - this is necessary since we're not in a VSCode environment

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock VSCode components to behave like standard HTML elements
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
	// The real toolkit textarea reports its value through a CustomEvent detail; the button below
	// reproduces that shape so both code paths can be exercised.
	VSCodeTextArea: ({ value, onChange, onInput, ...props }: any) => (
		<>
			<textarea value={value} onChange={onChange} onInput={onInput} {...props} />
			<button
				data-testid="emit-detail-input"
				onClick={() => onInput?.({ detail: { target: { value: "from detail" } } })}
			/>
		</>
	),
}))

describe("ContextManagementSettings", () => {
	const defaultProps = {
		autoCondenseContext: false,
		autoCondenseContextPercent: 80,
		listApiConfigMeta: [],
		maxOpenTabsContext: 20,
		maxWorkspaceFiles: 200,
		showAgentIgnoredFiles: false,
		profileThresholds: {},
		includeDiagnosticMessages: true,
		maxDiagnosticMessages: 50,
		writeDelayMs: 1000,
		customSupportPrompts: {},
		setCustomSupportPrompts: vi.fn(),
		setCachedStateField: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders diagnostic settings", () => {
		render(<ContextManagementSettings {...defaultProps} />)

		// Check for diagnostic checkbox
		expect(screen.getByTestId("include-diagnostic-messages-checkbox")).toBeInTheDocument()

		// Check for slider
		expect(screen.getByTestId("max-diagnostic-messages-slider")).toBeInTheDocument()
		expect(screen.getByText("50")).toBeInTheDocument()
	})

	it("renders with diagnostic messages enabled", () => {
		render(<ContextManagementSettings {...defaultProps} includeDiagnosticMessages={true} />)

		const checkbox = screen.getByTestId("include-diagnostic-messages-checkbox")
		expect(checkbox.querySelector("input")).toBeChecked()

		const slider = screen.getByTestId("max-diagnostic-messages-slider")
		expect(slider).toBeInTheDocument()
		expect(slider).toHaveValue("50")
	})

	it("renders with diagnostic messages disabled", () => {
		render(<ContextManagementSettings {...defaultProps} includeDiagnosticMessages={false} />)

		const checkbox = screen.getByTestId("include-diagnostic-messages-checkbox")
		expect(checkbox.querySelector("input")).not.toBeChecked()

		// Slider should still be rendered when diagnostics are disabled
		expect(screen.getByTestId("max-diagnostic-messages-slider")).toBeInTheDocument()
		expect(screen.getByText("50")).toBeInTheDocument()
	})

	it("calls setCachedStateField when include diagnostic messages checkbox is toggled", async () => {
		const setCachedStateField = vi.fn()
		render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		const checkbox = screen.getByTestId("include-diagnostic-messages-checkbox").querySelector("input")!
		fireEvent.click(checkbox)

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("includeDiagnosticMessages", false)
		})
	})

	it("calls setCachedStateField when max diagnostic messages slider is changed", async () => {
		const setCachedStateField = vi.fn()
		render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		const slider = screen.getByTestId("max-diagnostic-messages-slider")
		fireEvent.change(slider, { target: { value: "100" } })

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", -1)
		})
	})

	it("keeps slider visible when include diagnostic messages is unchecked", () => {
		const { rerender } = render(<ContextManagementSettings {...defaultProps} includeDiagnosticMessages={true} />)

		const slider = screen.getByTestId("max-diagnostic-messages-slider")
		expect(slider).toBeInTheDocument()

		// Update to disabled - slider should still be visible
		rerender(<ContextManagementSettings {...defaultProps} includeDiagnosticMessages={false} />)
		expect(screen.getByTestId("max-diagnostic-messages-slider")).toBeInTheDocument()
	})

	it("displays correct max diagnostic messages value", () => {
		const { rerender } = render(<ContextManagementSettings {...defaultProps} maxDiagnosticMessages={25} />)

		expect(screen.getByText("25")).toBeInTheDocument()

		// Update value - 100 should display as "Unlimited"
		rerender(<ContextManagementSettings {...defaultProps} maxDiagnosticMessages={100} />)
		expect(
			screen.getByText("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel"),
		).toBeInTheDocument()

		// Test unlimited value (-1) displays as "Unlimited"
		rerender(<ContextManagementSettings {...defaultProps} maxDiagnosticMessages={-1} />)
		expect(
			screen.getByText("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel"),
		).toBeInTheDocument()
	})

	it("renders other context management settings", () => {
		render(<ContextManagementSettings {...defaultProps} />)

		// Check for other sliders
		expect(screen.getByTestId("open-tabs-limit-slider")).toBeInTheDocument()
		expect(screen.getByTestId("workspace-files-limit-slider")).toBeInTheDocument()

		// Check for checkboxes
		expect(screen.getByTestId("show-agentignored-files-checkbox")).toBeInTheDocument()
		expect(screen.getByTestId("auto-condense-context-checkbox")).toBeInTheDocument()
	})

	describe("Edge cases for maxDiagnosticMessages", () => {
		it("handles zero value as unlimited", async () => {
			const setCachedStateField = vi.fn()
			render(
				<ContextManagementSettings
					{...defaultProps}
					maxDiagnosticMessages={0}
					setCachedStateField={setCachedStateField}
				/>,
			)

			// Zero is now treated as unlimited
			expect(
				screen.getByText("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel"),
			).toBeInTheDocument()

			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			// Zero should map to slider position 100 (unlimited)
			expect(slider).toHaveValue("100")
		})

		it("handles negative values as unlimited", async () => {
			const setCachedStateField = vi.fn()
			render(
				<ContextManagementSettings
					{...defaultProps}
					maxDiagnosticMessages={-10}
					setCachedStateField={setCachedStateField}
				/>,
			)

			// Component displays "Unlimited" for any negative value
			expect(
				screen.getByText("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel"),
			).toBeInTheDocument()

			// Slider should be at max position (100) for negative values
			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			expect(slider).toHaveValue("100")
		})

		it("handles very large numbers by capping at maximum", async () => {
			const setCachedStateField = vi.fn()
			const largeNumber = 1000
			render(
				<ContextManagementSettings
					{...defaultProps}
					maxDiagnosticMessages={largeNumber}
					setCachedStateField={setCachedStateField}
				/>,
			)

			// Should display the actual value even if it exceeds slider max
			expect(screen.getByText(largeNumber.toString())).toBeInTheDocument()

			// Slider value would be capped at max (100)
			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			expect(slider).toHaveValue("100")
		})

		it("enforces maximum value constraint", async () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("max-diagnostic-messages-slider")

			// Test that setting value above 100 gets capped
			fireEvent.change(slider, { target: { value: "150" } })

			await waitFor(() => {
				// Should be capped at 100, which maps to -1 (unlimited)
				expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", -1)
			})
		})

		it("handles boundary value at minimum (1)", async () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			fireEvent.change(slider, { target: { value: "1" } })

			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", 1)
			})
		})

		it("handles boundary value at maximum (100) as unlimited (-1)", async () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			fireEvent.change(slider, { target: { value: "100" } })

			await waitFor(() => {
				// When slider is at 100, it should set the value to -1 (unlimited)
				expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", -1)
			})
		})

		it("handles decimal values by parsing as float", async () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			fireEvent.change(slider, { target: { value: "50.7" } })

			await waitFor(() => {
				// The mock slider component parses as float
				expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", 50.7)
			})
		})
	})

	it("renders with autoCondenseContext enabled", () => {
		const propsWithAutoCondense = {
			...defaultProps,
			autoCondenseContext: true,
			autoCondenseContextPercent: 75,
		}
		render(<ContextManagementSettings {...propsWithAutoCondense} />)

		// Should render the auto condense section
		const autoCondenseCheckbox = screen.getByTestId("auto-condense-context-checkbox")
		expect(autoCondenseCheckbox).toBeInTheDocument()

		// Should render the threshold slider with correct value
		const slider = screen.getByTestId("condense-threshold-slider")
		expect(slider).toBeInTheDocument()

		// Should render the profile select dropdown
		const selects = screen.getAllByRole("combobox")
		expect(selects).toHaveLength(1)
	})

	describe("Auto Condense Context functionality", () => {
		const autoCondenseProps = {
			...defaultProps,
			autoCondenseContext: true,
			autoCondenseContextPercent: 75,
			listApiConfigMeta: [
				{ id: "config-1", name: "Config 1" },
				{ id: "config-2", name: "Config 2" },
			],
		}

		it("toggles auto condense context setting", () => {
			const mockSetCachedStateField = vitest.fn()
			const props = { ...autoCondenseProps, setCachedStateField: mockSetCachedStateField }
			render(<ContextManagementSettings {...props} />)

			const checkbox = screen.getByTestId("auto-condense-context-checkbox")
			const input = checkbox.querySelector('input[type="checkbox"]')
			expect(input).toBeChecked()

			// Toggle off
			fireEvent.click(checkbox)
			expect(mockSetCachedStateField).toHaveBeenCalledWith("autoCondenseContext", false)
		})

		it("shows threshold settings when auto condense is enabled", () => {
			render(<ContextManagementSettings {...autoCondenseProps} />)

			// Threshold settings should be visible
			expect(screen.getByTestId("condense-threshold-slider")).toBeInTheDocument()
			// One combobox for profile selection
			expect(screen.getAllByRole("combobox")).toHaveLength(1)
		})

		it("updates auto condense context percent", () => {
			const mockSetCachedStateField = vitest.fn()
			const props = { ...autoCondenseProps, setCachedStateField: mockSetCachedStateField }
			render(<ContextManagementSettings {...props} />)

			// Find the condense threshold slider
			const slider = screen.getByTestId("condense-threshold-slider")

			// Test slider interaction
			slider.focus()
			fireEvent.keyDown(slider, { key: "ArrowRight" })

			expect(mockSetCachedStateField).toHaveBeenCalledWith("autoCondenseContextPercent", 76)
		})

		it("displays correct auto condense context percent value", () => {
			render(<ContextManagementSettings {...autoCondenseProps} />)
			expect(screen.getByText("75%")).toBeInTheDocument()
		})
	})

	it("handles boundary values for sliders", () => {
		const mockSetCachedStateField = vitest.fn()
		const props = {
			...defaultProps,
			maxOpenTabsContext: 0,
			maxWorkspaceFiles: 500,
			maxGitStatusFiles: 0,
			setCachedStateField: mockSetCachedStateField,
		}
		render(<ContextManagementSettings {...props} />)

		// Check boundary values are displayed by checking the slider values directly
		const openTabsSlider = screen.getByTestId("open-tabs-limit-slider")
		expect(openTabsSlider).toHaveValue("0")

		const workspaceFilesSlider = screen.getByTestId("workspace-files-limit-slider")
		expect(workspaceFilesSlider).toHaveValue("500")

		const gitStatusSlider = screen.getByTestId("max-git-status-files-slider")
		expect(gitStatusSlider).toHaveValue("0")
	})

	it("handles undefined optional props gracefully", () => {
		const propsWithUndefined = {
			...defaultProps,
			showAgentIgnoredFiles: undefined,
		}

		expect(() => {
			render(<ContextManagementSettings {...propsWithUndefined} />)
		}).not.toThrow()

		// Should use default values
		expect(screen.getByText("20")).toBeInTheDocument() // default maxOpenTabsContext
		expect(screen.getByText("200")).toBeInTheDocument() // default maxWorkspaceFiles
	})

	describe("Conditional rendering", () => {
		it("does not render threshold settings when autoCondenseContext is false", () => {
			const propsWithoutAutoCondense = {
				...defaultProps,
				autoCondenseContext: false,
			}
			render(<ContextManagementSettings {...propsWithoutAutoCondense} />)

			// When auto condense is false, threshold slider should not be visible
			expect(screen.queryByTestId("condense-threshold-slider")).not.toBeInTheDocument()
		})
	})

	describe("Accessibility", () => {
		it("has proper labels and descriptions", () => {
			render(<ContextManagementSettings {...defaultProps} />)

			// Check that labels are present
			expect(screen.getByText("settings:contextManagement.openTabs.label")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.workspaceFiles.label")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.agentignore.label")).toBeInTheDocument()

			// Check that descriptions are present
			expect(screen.getByText("settings:contextManagement.openTabs.description")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.workspaceFiles.description")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.agentignore.description")).toBeInTheDocument()
		})

		it("has proper test ids for all interactive elements", () => {
			render(<ContextManagementSettings {...defaultProps} />)

			expect(screen.getByTestId("open-tabs-limit-slider")).toBeInTheDocument()
			expect(screen.getByTestId("workspace-files-limit-slider")).toBeInTheDocument()
			expect(screen.getByTestId("show-agentignored-files-checkbox")).toBeInTheDocument()
		})
	})

	describe("Integration with translation system", () => {
		it("uses translation keys for all text content", () => {
			render(<ContextManagementSettings {...defaultProps} />)

			// Verify that translation keys are being used (mocked to return the key)
			expect(screen.getByText("settings:sections.contextManagement")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.description")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.openTabs.label")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.workspaceFiles.label")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.agentignore.label")).toBeInTheDocument()
		})
	})
	describe("the plain limits", () => {
		const renderSettings = (props: Record<string, unknown> = {}) =>
			render(<ContextManagementSettings {...defaultProps} {...props} />)

		it("saves the open tabs, workspace files and git status limits", () => {
			const setCachedStateField = vi.fn()
			renderSettings({ setCachedStateField })

			fireEvent.change(screen.getByTestId("open-tabs-limit-slider"), { target: { value: "30" } })
			fireEvent.change(screen.getByTestId("workspace-files-limit-slider"), { target: { value: "150" } })
			fireEvent.change(screen.getByTestId("max-git-status-files-slider"), { target: { value: "40" } })

			expect(setCachedStateField).toHaveBeenCalledWith("maxOpenTabsContext", 30)
			expect(setCachedStateField).toHaveBeenCalledWith("maxWorkspaceFiles", 150)
			expect(setCachedStateField).toHaveBeenCalledWith("maxGitStatusFiles", 40)
		})

		it("saves the agentignore and subfolder rule switches", () => {
			const setCachedStateField = vi.fn()
			renderSettings({ setCachedStateField })

			fireEvent.click(screen.getByTestId("show-agentignored-files-checkbox").querySelector("input")!)
			fireEvent.click(screen.getByTestId("enable-subfolder-rules-checkbox").querySelector("input")!)

			expect(setCachedStateField).toHaveBeenCalledWith("showAgentIgnoredFiles", true)
			expect(setCachedStateField).toHaveBeenCalledWith("enableSubfolderRules", true)
		})

		it("saves the write delay and the timestamp and cost switches", () => {
			const setCachedStateField = vi.fn()
			renderSettings({ setCachedStateField })

			fireEvent.change(screen.getByTestId("write-delay-slider"), { target: { value: "2000" } })
			fireEvent.click(screen.getByTestId("include-current-time-checkbox").querySelector("input")!)
			fireEvent.click(screen.getByTestId("include-current-cost-checkbox").querySelector("input")!)

			expect(setCachedStateField).toHaveBeenCalledWith("writeDelayMs", 2000)
			expect(setCachedStateField).toHaveBeenCalledWith("includeCurrentTime", true)
			expect(setCachedStateField).toHaveBeenCalledWith("includeCurrentCost", true)
		})

		it("accepts image size limits inside their range and rejects the rest", () => {
			const setCachedStateField = vi.fn()
			renderSettings({ setCachedStateField })

			fireEvent.change(screen.getByTestId("max-image-file-size-input"), { target: { value: "50" } })
			fireEvent.change(screen.getByTestId("max-total-image-size-input"), { target: { value: "250" } })
			expect(setCachedStateField).toHaveBeenCalledWith("maxImageFileSize", 50)
			expect(setCachedStateField).toHaveBeenCalledWith("maxTotalImageSize", 250)

			setCachedStateField.mockClear()
			fireEvent.change(screen.getByTestId("max-image-file-size-input"), { target: { value: "0" } })
			fireEvent.change(screen.getByTestId("max-image-file-size-input"), { target: { value: "101" } })
			fireEvent.change(screen.getByTestId("max-image-file-size-input"), { target: { value: "abc" } })
			fireEvent.change(screen.getByTestId("max-total-image-size-input"), { target: { value: "501" } })

			expect(setCachedStateField).not.toHaveBeenCalled()
		})

		it("selects the whole image size field when it is clicked", () => {
			renderSettings()
			const input = screen.getByTestId("max-image-file-size-input") as HTMLInputElement
			const select = vi.spyOn(input, "select")

			fireEvent.click(input)

			expect(select).toHaveBeenCalled()
		})
	})

	describe("the condense prompt", () => {
		const renderSettings = (props: Record<string, unknown> = {}) =>
			render(<ContextManagementSettings {...defaultProps} {...props} />)

		it("stores what was typed", () => {
			const setCustomSupportPrompts = vi.fn()
			renderSettings({ setCustomSupportPrompts })

			fireEvent.input(screen.getByTestId("condense-prompt-textarea"), { target: { value: "my prompt" } })

			expect(setCustomSupportPrompts).toHaveBeenCalledWith({ CONDENSE: "my prompt" })
		})

		it("takes the value from the toolkit's own event shape too", () => {
			const setCustomSupportPrompts = vi.fn()
			renderSettings({ setCustomSupportPrompts })

			fireEvent.click(screen.getByTestId("emit-detail-input"))

			expect(setCustomSupportPrompts).toHaveBeenCalledWith({ CONDENSE: "from detail" })
		})

		it("forgets the custom prompt when it is reset", () => {
			const setCustomSupportPrompts = vi.fn()
			renderSettings({ customSupportPrompts: { CONDENSE: "mine" }, setCustomSupportPrompts })

			fireEvent.click(document.querySelectorAll(".codicon-discard")[1].closest("button")!)

			expect(setCustomSupportPrompts).toHaveBeenCalledWith({})
		})
	})

	describe("the condensing threshold", () => {
		const withProfiles = {
			...defaultProps,
			autoCondenseContext: true,
			listApiConfigMeta: [
				{ id: "profile-a", name: "Profile A" },
				{ id: "profile-b", name: "Profile B" },
			],
		}

		it("shows the threshold controls only while auto condensing is on", () => {
			const { rerender } = render(<ContextManagementSettings {...defaultProps} />)
			expect(screen.queryByTestId("condense-threshold-slider")).not.toBeInTheDocument()

			rerender(<ContextManagementSettings {...withProfiles} />)

			expect(screen.getByTestId("condense-threshold-slider")).toBeInTheDocument()
		})

		it("saves the default threshold globally", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...withProfiles} setCachedStateField={setCachedStateField} />)

			fireEvent.change(screen.getByTestId("condense-threshold-slider"), { target: { value: "70" } })

			expect(setCachedStateField).toHaveBeenCalledWith("autoCondenseContextPercent", 70)
		})

		it("saves a per-profile threshold and tells the extension", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...withProfiles} setCachedStateField={setCachedStateField} />)

			fireEvent.click(screen.getByTestId("pick-profile-a"))
			fireEvent.change(screen.getByTestId("condense-threshold-slider"), { target: { value: "65" } })

			expect(setCachedStateField).toHaveBeenCalledWith("profileThresholds", { "profile-a": 65 })
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "updateSettings",
				updatedSettings: { profileThresholds: { "profile-a": 65 } },
			})
		})

		it("shows the profile's own threshold once it has one", () => {
			render(
				<ContextManagementSettings
					{...withProfiles}
					autoCondenseContextPercent={80}
					profileThresholds={{ "profile-a": 65 }}
				/>,
			)

			fireEvent.click(screen.getByTestId("pick-profile-a"))

			expect(screen.getByText("65%")).toBeInTheDocument()
		})

		it("falls back to the global threshold for a profile that has none or opted out", () => {
			render(
				<ContextManagementSettings
					{...withProfiles}
					autoCondenseContextPercent={80}
					profileThresholds={{ "profile-b": -1 }}
				/>,
			)

			fireEvent.click(screen.getByTestId("pick-profile-b"))
			expect(screen.getByText("80%")).toBeInTheDocument()

			fireEvent.click(screen.getByTestId("pick-profile-a"))
			expect(screen.getByText("80%")).toBeInTheDocument()
		})

		it("goes back to the global threshold when the default profile is chosen again", () => {
			render(<ContextManagementSettings {...withProfiles} autoCondenseContextPercent={80} />)
			fireEvent.click(screen.getByTestId("pick-profile-a"))

			fireEvent.click(screen.getByTestId("pick-default-profile"))

			expect(screen.getByText("80%")).toBeInTheDocument()
		})

		it("saves the auto condense switch", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			fireEvent.click(screen.getByTestId("auto-condense-context-checkbox").querySelector("input")!)

			expect(setCachedStateField).toHaveBeenCalledWith("autoCondenseContext", true)
		})
	})
	describe("defaults and displays", () => {
		it("falls back to the built-in limits when none are stored", () => {
			render(
				<ContextManagementSettings
					{...defaultProps}
					maxOpenTabsContext={undefined as unknown as number}
					maxWorkspaceFiles={undefined as unknown as number}
					maxDiagnosticMessages={undefined as unknown as number}
				/>,
			)

			expect(screen.getByTestId("open-tabs-limit-slider")).toHaveValue("20")
			expect(screen.getByTestId("workspace-files-limit-slider")).toHaveValue("200")
		})

		it("calls an unlimited diagnostics setting unlimited", () => {
			render(<ContextManagementSettings {...defaultProps} maxDiagnosticMessages={0} />)

			expect(
				screen.getAllByText("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel").length,
			).toBeGreaterThan(0)
		})

		it("resets the diagnostics limit back to the default", () => {
			const setCachedStateField = vi.fn()
			render(
				<ContextManagementSettings
					{...defaultProps}
					maxDiagnosticMessages={10}
					setCachedStateField={setCachedStateField}
				/>,
			)

			fireEvent.click(document.querySelectorAll(".codicon-discard")[0].closest("button")!)

			expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", 50)
		})

		it("selects the whole total image size field when it is clicked", () => {
			render(<ContextManagementSettings {...defaultProps} />)
			const input = screen.getByTestId("max-total-image-size-input") as HTMLInputElement
			const select = vi.spyOn(input, "select")

			fireEvent.click(input)

			expect(select).toHaveBeenCalled()
		})

		it("shows each profile's threshold next to its name", () => {
			render(
				<ContextManagementSettings
					{...defaultProps}
					autoCondenseContext
					autoCondenseContextPercent={80}
					listApiConfigMeta={[
						{ id: "profile-a", name: "Profile A" },
						{ id: "profile-b", name: "Profile B" },
						{ id: "profile-c", name: "Profile C" },
					]}
					profileThresholds={{ "profile-a": 65, "profile-b": -1 }}
				/>,
			)

			expect(screen.getByText(/Profile A/).textContent).toContain("(65%)")
			expect(screen.getByText(/Profile B/).textContent).toContain(
				"settings:contextManagement.condensingThreshold.usesGlobal",
			)
			expect(screen.getByText("Profile C").textContent).toBe("Profile C")
		})
	})
	it("copes with no profile list at all", () => {
		render(
			<ContextManagementSettings {...defaultProps} autoCondenseContext listApiConfigMeta={undefined as never} />,
		)

		expect(screen.getByTestId("condense-threshold-slider")).toBeInTheDocument()
	})
})
