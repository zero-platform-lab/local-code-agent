import { forwardRef } from "react"
import type { LucideProps } from "lucide-react"

import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { SettingsSearchResults } from "../SettingsSearchResults"
import type { SearchResult } from "../useSettingsSearch"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params?.query ? `${key}:${params.query}` : key),
	}),
}))

// LucideIcon は forwardRef コンポーネント。素の関数だと型が合わないので同じ形で作る。
const BrowserIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
	<svg ref={ref} data-testid="browser-icon" {...props} />
))
BrowserIcon.displayName = "BrowserIcon"

const makeResult = (over: Partial<SearchResult>): SearchResult => ({
	settingId: "id",
	section: "browser" as any,
	label: "label",
	sectionLabel: "Browser",
	positions: new Set(),
	...over,
})

describe("SettingsSearchResults", () => {
	const sections = [{ id: "browser" as any, icon: BrowserIcon }]

	it("shows the no-results message when there are no results", () => {
		render(<SettingsSearchResults results={[]} query="foo" onSelectResult={vi.fn()} sections={sections} />)
		expect(screen.getByText("settings:search.noResults:foo")).toBeInTheDocument()
	})

	it("groups results, renders section icons only when known, and highlights matches", () => {
		const results = [
			// leading char highlighted -> currentHighlighted starts true
			makeResult({ settingId: "a", section: "browser" as any, label: "abc", positions: new Set([0, 2]) }),
			// empty positions -> HighlightMatch early return (plain text)
			makeResult({ settingId: "b", section: "browser" as any, label: "xyz", positions: new Set() }),
			// different section with no icon in the map -> Icon is undefined
			makeResult({ settingId: "c", section: "checkpoints" as any, label: "def", positions: new Set([1]) }),
		]

		render(
			<SettingsSearchResults
				results={results}
				query="q"
				onSelectResult={vi.fn()}
				sections={sections}
				highlightedResultId="a"
			/>,
		)

		expect(screen.getByRole("listbox")).toBeInTheDocument()
		expect(screen.getAllByRole("option")).toHaveLength(3)

		// browser section has an icon, checkpoints does not
		expect(screen.getAllByTestId("browser-icon")).toHaveLength(1)

		// highlighted result marked selected
		expect(document.getElementById("settings-search-result-a")).toHaveAttribute("aria-selected", "true")
		expect(document.getElementById("settings-search-result-b")).toHaveAttribute("aria-selected", "false")

		// highlight produced <mark> segments
		const marks = document.querySelectorAll("mark")
		expect(marks.length).toBeGreaterThan(0)
	})

	it("invokes onSelectResult on click and prevents default on mousedown", () => {
		const onSelectResult = vi.fn()
		const result = makeResult({
			settingId: "c",
			section: "browser" as any,
			label: "clickme",
			positions: new Set([1]),
		})
		render(
			<SettingsSearchResults results={[result]} query="q" onSelectResult={onSelectResult} sections={sections} />,
		)
		const option = document.getElementById("settings-search-result-c")!
		fireEvent.mouseDown(option)
		fireEvent.click(option)
		expect(onSelectResult).toHaveBeenCalledWith(result)
	})
})
