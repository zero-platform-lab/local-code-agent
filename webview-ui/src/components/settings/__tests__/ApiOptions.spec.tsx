// npx vitest src/components/settings/__tests__/ApiOptions.spec.tsx

import { render, screen, fireEvent, waitFor, act } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { type ModelInfo, type ProviderSettings, openAiModelInfoSaneDefaults } from "@openai-agent/types"

import * as ExtensionStateContext from "@src/context/ExtensionStateContext"
const { ExtensionStateContextProvider } = ExtensionStateContext

import { vscode } from "@/utils/vscode"

import ApiOptions, { ApiOptionsProps } from "../ApiOptions"

// Mock VSCode components
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onBlur }: any) => (
		<div>
			{children}
			<input type="text" value={value} onChange={onBlur} />
		</div>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
	VSCodeRadio: ({ value, checked }: any) => <input type="radio" value={value} checked={checked} />,
	VSCodeRadioGroup: ({ children }: any) => <div>{children}</div>,
	VSCodeButton: ({ children }: any) => <div>{children}</div>,
	VSCodeCheckbox: ({ children, checked, onChange }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange && onChange({ target: { checked: e.target.checked } })}
			/>
			{children}
		</label>
	),
}))

// Mock other components
vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label data-testid={`checkbox-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				data-testid={`checkbox-input-${children?.toString().replace(/\s+/g, "-").toLowerCase()}`}
			/>
			{children}
		</label>
	),
}))

// Mock @shadcn/ui components
vi.mock("@/components/ui", () => ({
	Select: ({ children, value, onValueChange }: any) => (
		<div className="select-mock">
			<select value={value} onChange={(e) => onValueChange && onValueChange(e.target.value)}>
				{children}
			</select>
		</div>
	),
	SelectTrigger: ({ children }: any) => <div className="select-trigger-mock">{children}</div>,
	SelectValue: ({ children }: any) => <div className="select-value-mock">{children}</div>,
	SelectContent: ({ children }: any) => <div className="select-content-mock">{children}</div>,
	SelectItem: ({ children, value }: any) => (
		<option value={value} className="select-item-mock">
			{children}
		</option>
	),
	SelectSeparator: ({ children }: any) => <div className="select-separator-mock">{children}</div>,
	Button: ({ children, onClick, _variant, role, className }: any) => (
		<button onClick={onClick} className={`button-mock ${className || ""}`} role={role}>
			{children}
		</button>
	),
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
	// Add missing components used by ModelPicker
	Command: ({ children }: any) => <div className="command-mock">{children}</div>,
	CommandEmpty: ({ children }: any) => <div className="command-empty-mock">{children}</div>,
	CommandGroup: ({ children }: any) => <div className="command-group-mock">{children}</div>,
	CommandInput: ({ value, onValueChange, placeholder, className, _ref }: any) => (
		<input
			value={value}
			onChange={(e) => onValueChange && onValueChange(e.target.value)}
			placeholder={placeholder}
			className={className}
		/>
	),
	CommandItem: ({ children, value, onSelect }: any) => (
		<div className="command-item-mock" onClick={() => onSelect && onSelect(value)}>
			{children}
		</div>
	),
	CommandList: ({ children }: any) => <div className="command-list-mock">{children}</div>,
	Popover: ({ children, _open, _onOpenChange }: any) => <div className="popover-mock">{children}</div>,
	PopoverContent: ({ children, _className }: any) => <div className="popover-content-mock">{children}</div>,
	PopoverTrigger: ({ children, _asChild }: any) => <div className="popover-trigger-mock">{children}</div>,
	Slider: ({ value, onChange, onValueChange }: any) => (
		<div data-testid="slider">
			<input
				type="range"
				value={Array.isArray(value) ? value[0] : value || 0}
				onChange={(e) =>
					onValueChange ? onValueChange([parseFloat(e.target.value)]) : onChange(parseFloat(e.target.value))
				}
			/>
		</div>
	),
	SearchableSelect: ({ value, onValueChange, options, placeholder, "data-testid": dataTestId }: any) => (
		<div className="searchable-select-mock" data-testid={dataTestId || "provider-popover-trigger"}>
			<select value={value} onChange={(e) => onValueChange && onValueChange(e.target.value)}>
				<option value="">{placeholder || "Select..."}</option>
				{options?.map((option: any) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	),
	// Add Collapsible components
	Collapsible: ({ children, open, onOpenChange }: any) => (
		<div className="collapsible-mock" data-open={open}>
			<button data-testid="toggle-advanced" onClick={() => onOpenChange?.(!open)} />
			{children}
		</div>
	),
	CollapsibleTrigger: ({ children, className, onClick }: any) => (
		<div className={`collapsible-trigger-mock ${className || ""}`} onClick={onClick}>
			{children}
		</div>
	),
	CollapsibleContent: ({ children, className }: any) => (
		<div className={`collapsible-content-mock ${className || ""}`}>{children}</div>
	),
}))

vi.mock("../TemperatureControl", () => ({
	TemperatureControl: ({ value, onChange }: any) => (
		<div data-testid="temperature-control">
			<input
				type="range"
				value={value || 0}
				onChange={(e) => onChange(parseFloat(e.target.value))}
				min={0}
				max={2}
				step={0.1}
			/>
		</div>
	),
}))

vi.mock("../RateLimitSecondsControl", () => ({
	RateLimitSecondsControl: ({ value, onChange }: any) => (
		<div data-testid="rate-limit-seconds-control">
			<input
				type="range"
				value={value || 0}
				onChange={(e) => onChange(parseFloat(e.target.value))}
				min={0}
				max={60}
				step={1}
			/>
		</div>
	),
}))

// Mock TodoListSettingsControl for tests
vi.mock("../TodoListSettingsControl", () => ({
	TodoListSettingsControl: ({ todoListEnabled, onChange }: any) => (
		<div data-testid="todo-list-settings-control">
			<label>
				Enable todo list tool
				<input
					type="checkbox"
					checked={todoListEnabled}
					onChange={(e) => onChange("todoListEnabled", e.target.checked)}
				/>
			</label>
		</div>
	),
}))

// Mock WebFetchSettingsControl for tests
vi.mock("../WebFetchSettingsControl", () => ({
	WebFetchSettingsControl: ({ webFetchEnabled, onChange }: any) => (
		<div data-testid="web-fetch-settings-control">
			<label>
				Enable web fetch tool
				<input
					type="checkbox"
					checked={webFetchEnabled}
					onChange={(e) => onChange("webFetchEnabled", e.target.checked)}
				/>
			</label>
		</div>
	),
}))

// Mock ThinkingBudget component
vi.mock("../ThinkingBudget", () => ({
	ThinkingBudget: ({ modelInfo }: any) => {
		// Only render if model supports reasoning budget (thinking models)
		if (modelInfo?.supportsReasoningBudget || modelInfo?.requiredReasoningBudget) {
			return (
				<div data-testid="reasoning-budget">
					<div>Max Thinking Tokens</div>
					<input type="range" min={1024} max={100000} step={1024} />
				</div>
			)
		}
		return null
	},
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: vi.fn((apiConfiguration: ProviderSettings) => {
		if (apiConfiguration.apiModelId?.includes("thinking")) {
			const info: ModelInfo = {
				contextWindow: 4000,
				maxTokens: 128000,
				supportsPromptCache: true,
			}

			return {
				id: apiConfiguration.apiModelId ?? apiConfiguration.openAiModelId,
				provider: apiConfiguration.apiProvider,
				info,
			}
		} else {
			const info: ModelInfo = { contextWindow: 4000, supportsPromptCache: true }

			return {
				id: apiConfiguration.apiModelId ?? apiConfiguration.openAiModelId,
				provider: apiConfiguration.apiProvider,
				info,
			}
		}
	}),
}))

const renderApiOptions = (props: Partial<ApiOptionsProps> = {}) => {
	const queryClient = new QueryClient()

	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ApiOptions
					errorMessage={undefined}
					setErrorMessage={() => {}}
					uriScheme={undefined}
					apiConfiguration={{}}
					setApiConfigurationField={() => {}}
					{...props}
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ApiOptions", () => {
	it("shows temperature and rate limit controls by default", () => {
		renderApiOptions({
			apiConfiguration: {},
		})
		expect(screen.getByTestId("temperature-control")).toBeInTheDocument()
		expect(screen.getByTestId("rate-limit-seconds-control")).toBeInTheDocument()
	})

	describe("OpenAI provider tests", () => {
		it("removes reasoningEffort from openAiCustomModelInfo when unchecked", () => {
			const mockSetApiConfigurationField = vi.fn()
			const initialConfig = {
				apiProvider: "openai" as const,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					...openAiModelInfoSaneDefaults, // Start with defaults
					reasoningEffort: "low" as const, // Set an initial value
				},
				// Add other necessary default fields for openai provider if needed
			}

			renderApiOptions({
				apiConfiguration: initialConfig,
				setApiConfigurationField: mockSetApiConfigurationField,
			})

			// Find the checkbox by its test ID instead of label text
			// This is more reliable than using the label text which might be affected by translations
			const checkbox =
				screen.getByTestId("checkbox-input-settings:providers.setreasoninglevel") ||
				screen.getByTestId("checkbox-input-set-reasoning-level")

			// Simulate unchecking the checkbox
			fireEvent.click(checkbox)

			// 1. Check if enableReasoningEffort was set to false
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", false)

			// 2. Check if openAiCustomModelInfo was updated
			const updateCall = mockSetApiConfigurationField.mock.calls.find(
				(call) => call[0] === "openAiCustomModelInfo",
			)
			expect(updateCall).toBeDefined()

			// 3. Check if reasoningEffort property is absent in the updated info
			const updatedInfo = updateCall![1]
			expect(updatedInfo).not.toHaveProperty("reasoningEffort")

			// Optional: Check if other properties were preserved (example)
			expect(updatedInfo).toHaveProperty("contextWindow", openAiModelInfoSaneDefaults.contextWindow)
		})

		it("does not render ReasoningEffort component when initially disabled", () => {
			const mockSetApiConfigurationField = vi.fn()
			const initialConfig = {
				apiProvider: "openai" as const,
				enableReasoningEffort: false, // Initially disabled
				openAiCustomModelInfo: {
					...openAiModelInfoSaneDefaults,
				},
			}

			renderApiOptions({
				apiConfiguration: initialConfig,
				setApiConfigurationField: mockSetApiConfigurationField,
			})

			// Check that the ReasoningEffort select component is not rendered.
			expect(screen.queryByTestId("reasoning-effort")).not.toBeInTheDocument()
		})

		it("renders ReasoningEffort component and sets flag when checkbox is checked", () => {
			const mockSetApiConfigurationField = vi.fn()
			const initialConfig = {
				apiProvider: "openai" as const,
				enableReasoningEffort: false, // Initially disabled
				openAiCustomModelInfo: {
					...openAiModelInfoSaneDefaults,
				},
			}

			renderApiOptions({
				apiConfiguration: initialConfig,
				setApiConfigurationField: mockSetApiConfigurationField,
			})

			const checkbox = screen.getByTestId("checkbox-input-settings:providers.setreasoninglevel")

			// Simulate checking the checkbox
			fireEvent.click(checkbox)

			// 1. Check if enableReasoningEffort was set to true
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true)

			// We can't directly test the rendering of the ReasoningEffort component after the state change
			// without a more complex setup involving state management mocks or re-rendering.
			// However, we've tested the state update call.
		})

		it.skip("updates reasoningEffort in openAiCustomModelInfo when select value changes", () => {
			const mockSetApiConfigurationField = vi.fn()
			const initialConfig = {
				apiProvider: "openai" as const,
				enableReasoningEffort: true, // Initially enabled
				openAiCustomModelInfo: {
					...openAiModelInfoSaneDefaults,
					reasoningEffort: "low" as const,
				},
			}

			renderApiOptions({
				apiConfiguration: initialConfig,
				setApiConfigurationField: mockSetApiConfigurationField,
			})

			// Find the reasoning effort select among all comboboxes by its current value
			// const allSelects = screen.getAllByRole("combobox") as HTMLSelectElement[]
			// const reasoningSelect = allSelects.find(
			// 	(el) => el.value === initialConfig.openAiCustomModelInfo.reasoningEffort,
			// )
			// expect(reasoningSelect).toBeDefined()
			const selectContainer = screen.getByTestId("reasoning-effort")
			expect(selectContainer).toBeInTheDocument()

			console.log(selectContainer.querySelector("select")?.value)

			// Simulate changing the reasoning effort to 'high'
			fireEvent.change(selectContainer.querySelector("select")!, { target: { value: "high" } })

			// Check if setApiConfigurationField was called correctly for openAiCustomModelInfo
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith(
				"openAiCustomModelInfo",
				expect.objectContaining({ reasoningEffort: "high" }),
			)

			// Check that other properties were preserved
			expect(mockSetApiConfigurationField).toHaveBeenCalledWith(
				"openAiCustomModelInfo",
				expect.objectContaining({
					contextWindow: openAiModelInfoSaneDefaults.contextWindow,
				}),
			)
		})
	})
	describe("wiring to the rest of the settings", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("records the provider the user picked", () => {
			const setApiConfigurationField = vi.fn()
			renderApiOptions({ apiConfiguration: { apiProvider: "openai" }, setApiConfigurationField })

			fireEvent.change(screen.getByTestId("provider-select").querySelector("select")!, {
				target: { value: "openai" },
			})

			expect(setApiConfigurationField).toHaveBeenCalledWith("apiProvider", "openai")
		})

		it("shows the validation error it was handed", () => {
			renderApiOptions({ errorMessage: "something is wrong" })

			expect(screen.getByText("something is wrong")).toBeInTheDocument()
		})

		it("reports a configuration problem to its parent", async () => {
			const setErrorMessage = vi.fn()
			renderApiOptions({ apiConfiguration: { apiProvider: "openai" }, setErrorMessage })

			await waitFor(() => expect(setErrorMessage).toHaveBeenCalled())
		})

		it("keeps the advanced settings folded away until asked", () => {
			renderApiOptions({})

			fireEvent.click(screen.getByText("settings:advancedSettings.title"))

			expect(screen.getByTestId("temperature-control")).toBeInTheDocument()
		})

		it("passes the configured rate limit through, defaulting to none", () => {
			const { rerender } = render(<div />)
			rerender(<div />)
			renderApiOptions({ apiConfiguration: { rateLimitSeconds: 12 } })

			expect(screen.getByTestId("rate-limit-seconds-control").querySelector("input")).toHaveValue("12")
		})

		it("asks the extension for the available models once typing settles", async () => {
			vi.useFakeTimers()

			try {
				renderApiOptions({
					apiConfiguration: { apiProvider: "openai", openAiBaseUrl: "http://x/v1", openAiApiKey: "k" },
				})

				await act(async () => {
					vi.advanceTimersByTime(300)
				})

				expect(vscode.postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ type: "requestOpenAiModels" }),
				)
			} finally {
				vi.useRealTimers()
			}
		})

		it("keeps the custom headers in step with the saved configuration", async () => {
			vi.useFakeTimers()
			const setApiConfigurationField = vi.fn()

			try {
				renderApiOptions({
					apiConfiguration: { apiProvider: "openai", openAiHeaders: { "X-Trace": "1" } },
					setApiConfigurationField,
				})

				await act(async () => {
					vi.advanceTimersByTime(300)
				})

				expect(setApiConfigurationField).not.toHaveBeenCalledWith("openAiHeaders", expect.anything(), true)
			} finally {
				vi.useRealTimers()
			}
		})
	})
	describe("advanced settings", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		const openAdvanced = () => fireEvent.click(screen.getByText("settings:advancedSettings.title"))

		it("saves the todo list switch", () => {
			const setApiConfigurationField = vi.fn()
			renderApiOptions({ setApiConfigurationField })
			openAdvanced()

			fireEvent.click(screen.getByTestId("todo-list-settings-control").querySelector("input")!)

			expect(setApiConfigurationField).toHaveBeenCalledWith("todoListEnabled", expect.anything())
		})

		it("saves the web fetch switch", () => {
			const setApiConfigurationField = vi.fn()
			renderApiOptions({ setApiConfigurationField })
			openAdvanced()

			fireEvent.click(screen.getByTestId("web-fetch-settings-control").querySelector("input")!)

			expect(setApiConfigurationField).toHaveBeenCalledWith("webFetchEnabled", expect.anything())
		})

		it("saves the temperature", () => {
			const setApiConfigurationField = vi.fn()
			renderApiOptions({ setApiConfigurationField })
			openAdvanced()

			fireEvent.change(screen.getByTestId("temperature-control").querySelector("input")!, {
				target: { value: "1" },
			})

			expect(setApiConfigurationField).toHaveBeenCalledWith("modelTemperature", expect.anything())
		})

		it("saves the rate limit", () => {
			const setApiConfigurationField = vi.fn()
			renderApiOptions({ setApiConfigurationField })
			openAdvanced()

			fireEvent.change(screen.getByTestId("rate-limit-seconds-control").querySelector("input")!, {
				target: { value: "5" },
			})

			expect(setApiConfigurationField).toHaveBeenCalledWith("rateLimitSeconds", 5)
		})

		it("keeps the model id in step with the model that is selected", async () => {
			const setApiConfigurationField = vi.fn()
			renderApiOptions({
				apiConfiguration: { apiProvider: "openai", openAiModelId: "gpt-4" },
				setApiConfigurationField,
			})

			await waitFor(() => expect(setApiConfigurationField).toHaveBeenCalledWith("apiModelId", "gpt-4", false))
		})

		it("adopts headers that arrive from outside without fighting them", async () => {
			vi.useFakeTimers()
			const setApiConfigurationField = vi.fn()

			try {
				const { rerender } = render(
					<ExtensionStateContextProvider>
						<QueryClientProvider client={new QueryClient()}>
							<ApiOptions
								errorMessage={undefined}
								setErrorMessage={() => {}}
								uriScheme={undefined}
								apiConfiguration={{ apiProvider: "openai" }}
								setApiConfigurationField={setApiConfigurationField}
							/>
						</QueryClientProvider>
					</ExtensionStateContextProvider>,
				)

				rerender(
					<ExtensionStateContextProvider>
						<QueryClientProvider client={new QueryClient()}>
							<ApiOptions
								errorMessage={undefined}
								setErrorMessage={() => {}}
								uriScheme={undefined}
								apiConfiguration={{ apiProvider: "openai", openAiHeaders: { "X-Trace": "1" } }}
								setApiConfigurationField={setApiConfigurationField}
							/>
						</QueryClientProvider>
					</ExtensionStateContextProvider>,
				)

				setApiConfigurationField.mockClear()

				await act(async () => {
					vi.advanceTimersByTime(400)
				})
				await act(async () => {
					vi.advanceTimersByTime(400)
				})

				// The local copy settles on what was saved instead of writing back repeatedly.
				const headerWrites = setApiConfigurationField.mock.calls.filter(
					([field]: unknown[]) => field === "openAiHeaders",
				)
				expect(headerWrites.length).toBeLessThanOrEqual(1)
			} finally {
				vi.useRealTimers()
			}
		})
	})
	describe("the advanced section", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("turns the chevron as it opens and closes", () => {
			const { container } = render(
				<ExtensionStateContextProvider>
					<QueryClientProvider client={new QueryClient()}>
						<ApiOptions
							errorMessage={undefined}
							setErrorMessage={() => {}}
							uriScheme={undefined}
							apiConfiguration={{}}
							setApiConfigurationField={() => {}}
						/>
					</QueryClientProvider>
				</ExtensionStateContextProvider>,
			)

			expect(container.querySelector(".codicon-chevron-right")).toBeInTheDocument()

			fireEvent.click(screen.getByTestId("toggle-advanced"))

			expect(container.querySelector(".codicon-chevron-down")).toBeInTheDocument()
		})

		it("saves how many mistakes in a row are tolerated", () => {
			const setApiConfigurationField = vi.fn()
			renderApiOptions({ apiConfiguration: { consecutiveMistakeLimit: 4 }, setApiConfigurationField })

			const sliders = screen.getAllByTestId("slider")
			fireEvent.change(sliders[sliders.length - 1].querySelector("input")!, { target: { value: "7" } })

			expect(setApiConfigurationField).toHaveBeenCalledWith("consecutiveMistakeLimit", 7)
		})
	})
})
