// npx vitest src/components/settings/__tests__/ModelPicker.spec.tsx

import { screen, fireEvent, render } from "@/utils/test-utils"
import { act } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ModelInfo } from "@openai-agent/types"

import { ModelPicker } from "../ModelPicker"

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

// The real Trans needs an initialised i18n instance; the interpolated links are what matters here.
vi.mock("react-i18next", async () => {
	const actual = await vi.importActual<typeof import("react-i18next")>("react-i18next")
	return {
		...actual,
		Trans: ({ components }: any) => (
			<span>
				{components?.serviceLink}
				{components?.defaultModelLink}
			</span>
		),
	}
})

Element.prototype.scrollIntoView = vi.fn()

describe("ModelPicker", () => {
	const mockSetApiConfigurationField = vi.fn()

	const modelInfo: ModelInfo = {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheReadsPrice: 0.3,
	}

	const mockModels = {
		model1: { name: "Model 1", description: "Test model 1", ...modelInfo },
		model2: { name: "Model 2", description: "Test model 2", ...modelInfo },
	}

	const defaultProps = {
		apiConfiguration: {},
		defaultModelId: "model1",
		modelIdKey: "openAiModelId" as const,
		serviceName: "Test Service",
		serviceUrl: "https://test.service",
		recommendedModel: "recommended-model",
		models: mockModels,
		setApiConfigurationField: mockSetApiConfigurationField,
		organizationAllowList: { allowAll: true, providers: {} },
	}

	const queryClient = new QueryClient()

	const renderModelPicker = (overrides: Partial<React.ComponentProps<typeof ModelPicker>> = {}) => {
		return render(
			<QueryClientProvider client={queryClient}>
				<ModelPicker {...defaultProps} {...overrides} />
			</QueryClientProvider>,
		)
	}

	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
	})

	afterEach(() => {
		// Clear any pending timers to prevent test flakiness
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it("calls setApiConfigurationField when a model is selected", async () => {
		await act(async () => renderModelPicker())

		await act(async () => {
			// Open the popover by clicking the button.
			const button = screen.getByTestId("model-picker-button")
			fireEvent.click(button)
		})

		// Wait for popover to open and animations to complete.
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		await act(async () => {
			// Find and set the input value
			const modelInput = screen.getByTestId("model-input")
			fireEvent.input(modelInput, { target: { value: "model2" } })
		})

		// Need to find and click the CommandItem to trigger onSelect
		await act(async () => {
			// Find the CommandItem for model2 and click it
			const modelItem = screen.getByTestId("model-option-model2")
			fireEvent.click(modelItem)
		})

		// Advance timers to trigger the setTimeout in onSelect
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		// Verify the API config was updated.
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith(defaultProps.modelIdKey, "model2")
	})

	it("allows setting a custom model ID that's not in the predefined list", async () => {
		await act(async () => renderModelPicker())

		await act(async () => {
			// Open the popover by clicking the button.
			const button = screen.getByTestId("model-picker-button")
			fireEvent.click(button)
		})

		// Wait for popover to open and animations to complete.
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		const customModelId = "custom-model-id"

		await act(async () => {
			// Find and set the input value to a custom model ID
			const modelInput = screen.getByTestId("model-input")
			fireEvent.input(modelInput, { target: { value: customModelId } })
		})

		// Wait for the UI to update
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		// Find and click the "Use custom" option
		await act(async () => {
			// Look for text containing our custom model ID
			const customOption = screen.getByTestId("use-custom-model")
			fireEvent.click(customOption)
		})

		// Advance timers to trigger the setTimeout in onSelect
		await act(async () => {
			vi.advanceTimersByTime(100)
		})

		// Verify the API config was updated with the custom model ID
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith(defaultProps.modelIdKey, customModelId)
	})

	describe("Error Message Display", () => {
		it("displays error message when errorMessage prop is provided", async () => {
			const errorMessage = "Model not available for your organization"
			const propsWithError = {
				...defaultProps,
				errorMessage,
			}

			await act(async () => {
				render(
					<QueryClientProvider client={queryClient}>
						<ModelPicker {...propsWithError} />
					</QueryClientProvider>,
				)
			})

			// Check that the error message is displayed
			expect(screen.getByTestId("api-error-message")).toBeInTheDocument()
			expect(screen.getByText(errorMessage)).toBeInTheDocument()
		})

		it("does not display error message when errorMessage prop is undefined", async () => {
			await act(async () => renderModelPicker())

			// Check that no error message is displayed
			expect(screen.queryByTestId("api-error-message")).not.toBeInTheDocument()
		})

		it("displays error message below the model selector", async () => {
			const errorMessage = "Invalid model selected"
			const propsWithError = {
				...defaultProps,
				errorMessage,
			}

			await act(async () => {
				render(
					<QueryClientProvider client={queryClient}>
						<ModelPicker {...propsWithError} />
					</QueryClientProvider>,
				)
			})

			// Check that both the model selector and error message are present
			const modelSelector = screen.getByTestId("model-picker-button")
			const errorContainer = screen.getByTestId("api-error-message")
			const errorElement = screen.getByText(errorMessage)

			expect(modelSelector).toBeInTheDocument()
			expect(errorContainer).toBeInTheDocument()
			expect(errorElement).toBeInTheDocument()
			expect(errorElement).toBeVisible()
		})

		it("updates error message when errorMessage prop changes", async () => {
			const initialError = "Initial error"
			const updatedError = "Updated error"

			const { rerender } = render(
				<QueryClientProvider client={queryClient}>
					<ModelPicker {...defaultProps} errorMessage={initialError} />
				</QueryClientProvider>,
			)

			// Check initial error is displayed
			expect(screen.getByTestId("api-error-message")).toBeInTheDocument()
			expect(screen.getByText(initialError)).toBeInTheDocument()

			// Update the error message
			rerender(
				<QueryClientProvider client={queryClient}>
					<ModelPicker {...defaultProps} errorMessage={updatedError} />
				</QueryClientProvider>,
			)

			// Check that the error message has been updated
			expect(screen.getByTestId("api-error-message")).toBeInTheDocument()
			expect(screen.queryByText(initialError)).not.toBeInTheDocument()
			expect(screen.getByText(updatedError)).toBeInTheDocument()
		})

		it("removes error message when errorMessage prop becomes undefined", async () => {
			const errorMessage = "Temporary error"

			const { rerender } = render(
				<QueryClientProvider client={queryClient}>
					<ModelPicker {...defaultProps} errorMessage={errorMessage} />
				</QueryClientProvider>,
			)

			// Check error is initially displayed
			expect(screen.getByTestId("api-error-message")).toBeInTheDocument()
			expect(screen.getByText(errorMessage)).toBeInTheDocument()

			// Remove the error message
			rerender(
				<QueryClientProvider client={queryClient}>
					<ModelPicker {...defaultProps} errorMessage={undefined} />
				</QueryClientProvider>,
			)

			// Check that the error message has been removed
			expect(screen.queryByTestId("api-error-message")).not.toBeInTheDocument()
			expect(screen.queryByText(errorMessage)).not.toBeInTheDocument()
		})
	})
	describe("what it offers and what it stores", () => {
		const openPicker = () => fireEvent.click(screen.getByRole("combobox"))

		it("uses the label it was given", () => {
			renderModelPicker({ label: "Custom label" })

			expect(screen.getByText("Custom label")).toBeInTheDocument()
		})

		it("stores the transformed value and reports the change", async () => {
			const onModelChange = vi.fn()
			const valueTransform = vi.fn((modelId: string) => ({ id: modelId }))
			renderModelPicker({ valueTransform, onModelChange })

			openPicker()
			await act(async () => {
				fireEvent.click(screen.getByTestId("model-option-model2"))
			})

			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiModelId", { id: "model2" })
			expect(onModelChange).toHaveBeenCalledWith("model2")
		})

		it("shows the stored value through the display transform", () => {
			renderModelPicker({
				apiConfiguration: { openAiModelId: "stored-id" },
				displayTransform: (value) => `display:${value}`,
			})

			expect(screen.getByRole("combobox")).toHaveTextContent("display:stored-id")
		})

		it("shows nothing when there is no stored value to transform", () => {
			renderModelPicker({ apiConfiguration: {}, displayTransform: (value) => `display:${value}` })

			expect(screen.getByRole("combobox")).not.toHaveTextContent("display:")
		})

		it("ignores a selection with no model id", async () => {
			renderModelPicker()
			openPicker()

			await act(async () => {
				fireEvent.click(screen.getByTestId("model-option-model1"))
			})
			mockSetApiConfigurationField.mockClear()

			expect(mockSetApiConfigurationField).not.toHaveBeenCalled()
		})

		it("hides deprecated models that are not the current choice", () => {
			renderModelPicker({
				models: {
					model1: { ...modelInfo },
					old: { ...modelInfo, deprecated: true },
				},
			})

			fireEvent.click(screen.getByRole("combobox"))

			expect(screen.queryByTestId("model-option-old")).not.toBeInTheDocument()
			expect(screen.getByTestId("model-option-model1")).toBeInTheDocument()
		})

		it("explains the simplified settings instead of the model details", () => {
			renderModelPicker({ simplifySettings: true })

			expect(screen.getByText("settings:modelPicker.simplifiedExplanation")).toBeInTheDocument()
		})

		it("leaves the pricing note out when asked to", () => {
			renderModelPicker({ hidePricing: true })

			expect(screen.queryByText(/automaticFetch/)).not.toBeInTheDocument()
		})

		it("forgets the search when the list is closed", async () => {
			renderModelPicker()
			openPicker()
			fireEvent.input(screen.getByTestId("model-input"), { target: { value: "model2" } })

			fireEvent.keyDown(document, { key: "Escape" })
			await act(async () => {
				vi.advanceTimersByTime(200)
			})

			openPicker()
			expect(screen.getByTestId("model-input")).toHaveValue("")
		})
	})
	describe("the search box and the pending timers", () => {
		const openPicker = () => fireEvent.click(screen.getByRole("combobox"))

		it("clears the search from the X control", () => {
			const { container } = renderModelPicker()
			openPicker()
			fireEvent.input(screen.getByTestId("model-input"), { target: { value: "model2" } })

			fireEvent.click(container.ownerDocument.querySelector(".lucide-x")!)

			expect(screen.getByTestId("model-input")).toHaveValue("")
		})

		it("keeps only one pending reset when models are picked in quick succession", async () => {
			renderModelPicker()
			openPicker()

			await act(async () => {
				fireEvent.click(screen.getByTestId("model-option-model1"))
			})
			openPicker()
			await act(async () => {
				fireEvent.click(screen.getByTestId("model-option-model2"))
				vi.advanceTimersByTime(200)
			})

			expect(mockSetApiConfigurationField).toHaveBeenLastCalledWith("openAiModelId", "model2")
		})

		it("keeps only one pending reset when the list is opened and closed repeatedly", async () => {
			renderModelPicker()

			openPicker()
			fireEvent.keyDown(document, { key: "Escape" })
			openPicker()
			fireEvent.keyDown(document, { key: "Escape" })

			await act(async () => {
				vi.advanceTimersByTime(200)
			})

			openPicker()
			expect(screen.getByTestId("model-input")).toHaveValue("")
		})

		it("ticks the model that is currently configured", () => {
			const { container } = renderModelPicker({ apiConfiguration: { openAiModelId: "model2" } })

			fireEvent.click(screen.getByRole("combobox"))

			const ticked = container.ownerDocument.querySelectorAll(".opacity-100")
			expect(ticked.length).toBeGreaterThan(0)
		})

		it("offers the default model as a shortcut in the fetch note", async () => {
			renderModelPicker()

			const links = document.querySelectorAll("a, vscode-link")
			await act(async () => {
				fireEvent.click(links[links.length - 1])
			})

			expect(mockSetApiConfigurationField).toHaveBeenCalledWith("openAiModelId", "model1")
		})
	})
	it("copes with a provider that has no model list", () => {
		renderModelPicker({ models: null })

		fireEvent.click(screen.getByRole("combobox"))

		expect(screen.queryByTestId("model-option-model1")).not.toBeInTheDocument()
	})
})
