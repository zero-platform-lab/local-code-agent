// npx vitest src/components/settings/__tests__/ThinkingBudget.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ModelInfo } from "@openai-agent/types"

import { ThinkingBudget } from "../ThinkingBudget"

vi.mock("@/components/ui", () => ({
	Slider: ({ value, onValueChange, min, max, step }: any) => (
		<input
			type="range"
			data-testid="slider"
			min={min}
			max={max}
			step={step}
			value={value[0]}
			onChange={(e) => onValueChange([parseInt(e.target.value)])}
		/>
	),
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			<button data-testid="pick-disable" onClick={() => onValueChange?.("disable")} />
			<button data-testid="pick-high" onClick={() => onValueChange?.("high")} />
			{children}
		</div>
	),
	SelectTrigger: ({ children }: any) => <button data-testid="select-trigger">{children}</button>,
	SelectValue: ({ placeholder }: any) => <span data-testid="select-value">{placeholder}</span>,
	SelectContent: ({ children }: any) => <div data-testid="select-content">{children}</div>,
	SelectItem: ({ children, value }: any) => (
		<div data-testid={`select-item-${value}`} data-value={value}>
			{children}
		</div>
	),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label>
			<input
				type="checkbox"
				data-testid="checkbox"
				checked={!!checked}
				onChange={(e) => onChange(e.target.checked)}
			/>
			{children}
		</label>
	),
}))

vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: (apiConfiguration: any) => {
		// Return the model ID based on apiConfiguration for testing
		// For Gemini tests, check if apiProvider is gemini and use apiModelId
		if (apiConfiguration?.apiProvider === "openai") {
			return {
				id: apiConfiguration?.apiModelId || "gemini-2.0-flash-exp",
				provider: "openai",
				info: undefined,
			}
		}
		return {
			id: apiConfiguration?.apiModelId || "claude-3-5-sonnet-20241022",
			provider: apiConfiguration?.apiProvider || "openai",
			info: undefined,
		}
	},
}))

describe("ThinkingBudget", () => {
	const mockModelInfo: ModelInfo = {
		maxTokens: 16384,
		contextWindow: 200000,
		supportsPromptCache: true,
		supportsImages: true,
	}

	const defaultProps = {
		apiConfiguration: {},
		setApiConfigurationField: vi.fn(),
		modelInfo: mockModelInfo,
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should render nothing when model doesn't support thinking", () => {
		const { container } = render(
			<ThinkingBudget
				{...defaultProps}
				modelInfo={{
					...mockModelInfo,
					maxTokens: 16384,
					contextWindow: 200000,
					supportsPromptCache: true,
					supportsImages: true,
				}}
			/>,
		)

		expect(container.firstChild).toBeNull()
	})

	it("should render simple reasoning toggle when model has supportsReasoningBinary (binary reasoning)", () => {
		render(
			<ThinkingBudget
				{...defaultProps}
				modelInfo={{
					...mockModelInfo,
					supportsReasoningBinary: true,
					supportsReasoningEffort: false,
				}}
			/>,
		)

		// Should show the reasoning checkbox (translation key)
		expect(screen.getByText("settings:providers.useReasoning")).toBeInTheDocument()

		// Should NOT show sliders or other complex reasoning controls
		expect(screen.queryByTestId("reasoning-budget")).not.toBeInTheDocument()
		expect(screen.queryByTestId("reasoning-effort")).not.toBeInTheDocument()
	})

	describe("reasoning effort dropdown", () => {
		const reasoningEffortModelInfo: ModelInfo = {
			supportsReasoningEffort: true,
			contextWindow: 200000,
			supportsPromptCache: true,
		}

		it("should show 'disable' option when supportsReasoningEffort is boolean true", () => {
			render(<ThinkingBudget {...defaultProps} modelInfo={reasoningEffortModelInfo} />)

			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
			// "disable" should be shown when supportsReasoningEffort is true (boolean)
			expect(screen.getByTestId("select-item-disable")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-medium")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		})

		it("should NOT show 'disable' option when supportsReasoningEffort is an explicit array without disable", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["low", "high"],
					}}
				/>,
			)

			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
			// "disable" should NOT be shown when model explicitly specifies only ["low", "high"]
			expect(screen.queryByTestId("select-item-disable")).not.toBeInTheDocument()
			expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
			expect(screen.queryByTestId("select-item-medium")).not.toBeInTheDocument()
			expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		})

		it("should show 'disable' option when supportsReasoningEffort array explicitly includes disable", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["disable", "low", "high"],
					}}
				/>,
			)

			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
			// "disable" should be shown when model explicitly includes it in the array
			expect(screen.getByTestId("select-item-disable")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
			expect(screen.queryByTestId("select-item-medium")).not.toBeInTheDocument()
			expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		})

		it("should show 'none' option when supportsReasoningEffort array includes none", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{
						...reasoningEffortModelInfo,
						supportsReasoningEffort: ["none", "low", "medium", "high"],
					}}
				/>,
			)

			expect(screen.getByTestId("reasoning-effort")).toBeInTheDocument()
			// Only values from the explicit array should be shown
			expect(screen.queryByTestId("select-item-disable")).not.toBeInTheDocument()
			expect(screen.getByTestId("select-item-none")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-low")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-medium")).toBeInTheDocument()
			expect(screen.getByTestId("select-item-high")).toBeInTheDocument()
		})
	})
	describe("saving what the user picks", () => {
		const supportsEffort: ModelInfo = { ...mockModelInfo, supportsReasoningEffort: true }

		it("turns reasoning off when 'disable' is picked", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={supportsEffort}
					setApiConfigurationField={setApiConfigurationField}
				/>,
			)

			fireEvent.click(screen.getByTestId("pick-disable"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", false)
			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "disable")
		})

		it("turns reasoning on when a level is picked", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={supportsEffort}
					setApiConfigurationField={setApiConfigurationField}
				/>,
			)

			fireEvent.click(screen.getByTestId("pick-high"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true)
			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "high")
		})

		it("shows the level that is already stored", () => {
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ reasoningEffort: "low" }}
					modelInfo={supportsEffort}
				/>,
			)

			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "low")
		})

		it("starts disabled for a model that does not require reasoning", () => {
			render(<ThinkingBudget {...defaultProps} modelInfo={supportsEffort} />)

			expect(screen.getByTestId("select")).toHaveAttribute("data-value", "disable")
		})

		it("applies the model's own default when reasoning is required", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{ ...supportsEffort, requiredReasoningEffort: true, reasoningEffort: "low" }}
					setApiConfigurationField={setApiConfigurationField}
				/>,
			)

			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "low", false)
			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true, false)
		})

		it("falls back to a medium effort when the model names none", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{ ...supportsEffort, requiredReasoningEffort: true }}
					setApiConfigurationField={setApiConfigurationField}
				/>,
			)

			expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", "medium", false)
		})

		it("leaves a stored level alone", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					apiConfiguration={{ reasoningEffort: "high", enableReasoningEffort: true }}
					modelInfo={{ ...supportsEffort, requiredReasoningEffort: true }}
					setApiConfigurationField={setApiConfigurationField}
				/>,
			)

			expect(setApiConfigurationField).not.toHaveBeenCalledWith("reasoningEffort", "medium", false)
			expect(setApiConfigurationField).not.toHaveBeenCalledWith("enableReasoningEffort", true, false)
		})

		it("saves the on/off switch of a model with binary reasoning", () => {
			const setApiConfigurationField = vi.fn()
			render(
				<ThinkingBudget
					{...defaultProps}
					modelInfo={{ ...mockModelInfo, supportsReasoningBinary: true }}
					setApiConfigurationField={setApiConfigurationField}
				/>,
			)

			fireEvent.click(screen.getByTestId("checkbox"))

			expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", true)
		})
	})
	it("shows nothing at all when the model is not known yet", () => {
		const { container } = render(<ThinkingBudget {...defaultProps} modelInfo={undefined} />)

		expect(container).toBeEmptyDOMElement()
	})
})
