import { render, screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import type { ModelInfo } from "@openai-agent/types"

import { ModelInfoView } from "../ModelInfoView"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("../ModelDescriptionMarkdown", () => ({
	ModelDescriptionMarkdown: ({ markdown }: any) => <div data-testid="model-description">{markdown}</div>,
}))

const props = {
	isDescriptionExpanded: false,
	setIsDescriptionExpanded: vi.fn(),
}

describe("ModelInfoView", () => {
	it("renders 'not supported' rows and no pricing/description when modelInfo is undefined", () => {
		render(<ModelInfoView {...props} modelInfo={undefined} />)
		expect(screen.getByText("settings:modelInfo.noImages")).toBeInTheDocument()
		expect(screen.getByText("settings:modelInfo.noPromptCache")).toBeInTheDocument()
		expect(screen.queryByTestId("model-description")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:modelInfo.inputPrice")).not.toBeInTheDocument()
	})

	it("renders all info rows and the description for a fully populated model", () => {
		const modelInfo = {
			contextWindow: 128000,
			maxTokens: 4096,
			supportsImages: true,
			supportsPromptCache: true,
			inputPrice: 1,
			outputPrice: 2,
			cacheReadsPrice: 0.5,
			description: "A great model",
		} as unknown as ModelInfo

		render(<ModelInfoView {...props} modelInfo={modelInfo} />)
		expect(screen.getByText("settings:modelInfo.contextWindow")).toBeInTheDocument()
		expect(screen.getByText(/settings:modelInfo.maxOutput/)).toBeInTheDocument()
		expect(screen.getByText("settings:modelInfo.supportsImages")).toBeInTheDocument()
		expect(screen.getByText("settings:modelInfo.supportsPromptCache")).toBeInTheDocument()
		expect(screen.getByText(/settings:modelInfo.inputPrice/)).toBeInTheDocument()
		expect(screen.getByText(/settings:modelInfo.outputPrice/)).toBeInTheDocument()
		expect(screen.getByText(/settings:modelInfo.cacheReadsPrice/)).toBeInTheDocument()
		expect(screen.getByTestId("model-description")).toHaveTextContent("A great model")
	})

	it("omits pricing rows when hidePricing is true", () => {
		const modelInfo = {
			contextWindow: 1000,
			inputPrice: 1,
			outputPrice: 2,
			supportsPromptCache: true,
			cacheReadsPrice: 0.5,
		} as unknown as ModelInfo

		render(<ModelInfoView {...props} modelInfo={modelInfo} hidePricing={true} />)
		expect(screen.queryByText(/settings:modelInfo.inputPrice/)).not.toBeInTheDocument()
		expect(screen.queryByText(/settings:modelInfo.cacheReadsPrice/)).not.toBeInTheDocument()
	})

	it("treats zero context window / max tokens as absent and skips cache price without cacheReadsPrice", () => {
		const modelInfo = {
			contextWindow: 0,
			maxTokens: 0,
			supportsPromptCache: true,
			// cacheReadsPrice undefined -> cache price row hidden even though prompt cache supported
		} as unknown as ModelInfo

		render(<ModelInfoView {...props} modelInfo={modelInfo} />)
		expect(screen.queryByText("settings:modelInfo.contextWindow")).not.toBeInTheDocument()
		expect(screen.queryByText(/settings:modelInfo.maxOutput/)).not.toBeInTheDocument()
		expect(screen.queryByText(/settings:modelInfo.cacheReadsPrice/)).not.toBeInTheDocument()
	})
})
