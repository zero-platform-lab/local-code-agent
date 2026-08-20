import { render, screen, fireEvent } from "@/utils/test-utils"

import CodebaseSearchResultsDisplay from "../CodebaseSearchResultsDisplay"

// 子コンポーネントはファイルパスだけを描画するモックに差し替える
vi.mock("../CodebaseSearchResult", () => ({
	default: ({ filePath }: { filePath: string }) => <div data-testid="result">{filePath}</div>,
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, count }: { i18nKey: string; count: number }) => (
		<span>
			{i18nKey}:{count}
		</span>
	),
}))

const results = [
	{ filePath: "a.ts", score: 0.5, startLine: 1, endLine: 2, codeChunk: "chunk-a" },
	{ filePath: "b.ts", score: 0.9, startLine: 3, endLine: 4, codeChunk: "chunk-b" },
]

describe("CodebaseSearchResultsDisplay", () => {
	it("is collapsed by default (results hidden) and shows the count", () => {
		render(<CodebaseSearchResultsDisplay results={results} />)
		expect(screen.getByText("chat:codebaseSearch.didSearch:2")).toBeInTheDocument()
		expect(screen.queryByTestId("result")).not.toBeInTheDocument()
	})

	it("expands to show every result on click, then collapses again", () => {
		const { container } = render(<CodebaseSearchResultsDisplay results={results} />)
		const header = container.querySelector(".cursor-pointer") as HTMLElement

		fireEvent.click(header)
		expect(screen.getAllByTestId("result")).toHaveLength(2)
		expect(screen.getByText("a.ts")).toBeInTheDocument()
		expect(screen.getByText("b.ts")).toBeInTheDocument()
		// chevron が up になる
		expect(container.querySelector(".codicon-chevron-up")).toBeInTheDocument()

		fireEvent.click(header)
		expect(screen.queryByTestId("result")).not.toBeInTheDocument()
		expect(container.querySelector(".codicon-chevron-down")).toBeInTheDocument()
	})
})
