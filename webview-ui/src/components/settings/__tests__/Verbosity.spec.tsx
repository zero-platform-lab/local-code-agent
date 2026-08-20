import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import type { ModelInfo, ProviderSettings } from "@openai-agent/types"

import { Verbosity } from "../Verbosity"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			<button data-testid="select-high" onClick={() => onValueChange("high")}>
				change
			</button>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-testid={`item-${value}`}>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
}))

const modelInfo = { contextWindow: 1000, supportsPromptCache: false } as unknown as ModelInfo

describe("Verbosity", () => {
	it("renders null when modelInfo is missing", () => {
		const { container } = render(
			<Verbosity
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={vi.fn()}
				modelInfo={undefined}
			/>,
		)
		expect(container.firstChild).toBeNull()
	})

	it("defaults to 'medium' when verbosity is unset", () => {
		render(
			<Verbosity
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={vi.fn()}
				modelInfo={modelInfo}
			/>,
		)
		expect(screen.getByTestId("select")).toHaveAttribute("data-value", "medium")
	})

	it("reflects the configured verbosity value", () => {
		render(
			<Verbosity
				apiConfiguration={{ verbosity: "low" } as ProviderSettings}
				setApiConfigurationField={vi.fn()}
				modelInfo={modelInfo}
			/>,
		)
		expect(screen.getByTestId("select")).toHaveAttribute("data-value", "low")
	})

	it("updates only the verbosity field on change", () => {
		const setField = vi.fn()
		render(
			<Verbosity
				apiConfiguration={{} as ProviderSettings}
				setApiConfigurationField={setField}
				modelInfo={modelInfo}
			/>,
		)
		fireEvent.click(screen.getByTestId("select-high"))
		expect(setField).toHaveBeenCalledTimes(1)
		expect(setField).toHaveBeenCalledWith("verbosity", "high")
	})
})
