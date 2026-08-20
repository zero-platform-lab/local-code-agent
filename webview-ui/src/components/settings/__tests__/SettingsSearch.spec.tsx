import { render, screen, fireEvent, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import React, { forwardRef } from "react"
import type { LucideProps } from "lucide-react"

import { SettingsSearch } from "../SettingsSearch"
import type { SearchableSettingData } from "../useSettingsSearch"

vi.mock("../SettingsSearchInput", () => ({
	SettingsSearchInput: ({ value, onChange, onFocus, onBlur, onKeyDown, inputRef }: any) => (
		<input
			data-testid="search-input"
			ref={inputRef}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			onFocus={onFocus}
			onBlur={onBlur}
			onKeyDown={onKeyDown}
		/>
	),
}))

vi.mock("../SettingsSearchResults", () => ({
	SettingsSearchResults: ({ results, onSelectResult, highlightedResultId }: any) => (
		<div data-testid="results" data-highlighted={highlightedResultId ?? ""}>
			{results.map((r: any) => (
				<button
					key={r.settingId}
					id={`settings-search-result-${r.settingId}`}
					data-testid={`result-${r.settingId}`}
					onClick={() => onSelectResult(r)}>
					{r.label}
				</button>
			))}
		</div>
	),
}))

// LucideIcon は forwardRef コンポーネント。素の関数だと型が合わないので同じ形で作る。
const FakeIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => <svg ref={ref} {...props} />)
FakeIcon.displayName = "FakeIcon"

const index: SearchableSettingData[] = [
	{ settingId: "a", section: "browser" as any, label: "Enable browser", sectionLabel: "Browser" },
	{ settingId: "b", section: "browser" as any, label: "Browser cache", sectionLabel: "Browser" },
]
const sections = [{ id: "browser" as any, icon: FakeIcon }]

const setup = (onNavigate = vi.fn()) => {
	render(<SettingsSearch index={index} onNavigate={onNavigate} sections={sections} />)
	const input = screen.getByTestId("search-input") as HTMLInputElement
	return { input, onNavigate }
}

const openWithQuery = (input: HTMLInputElement, query: string) => {
	fireEvent.focus(input)
	fireEvent.change(input, { target: { value: query } })
}

describe("SettingsSearch", () => {
	beforeEach(() => {
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(0)
			return 0
		})
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("keeps the dropdown closed until focused with a query", () => {
		const { input } = setup()
		fireEvent.change(input, { target: { value: "browser" } })
		// not focused yet -> isOpen false -> no dropdown
		expect(screen.queryByTestId("results")).not.toBeInTheDocument()

		fireEvent.focus(input)
		expect(screen.getByTestId("results")).toBeInTheDocument()
	})

	it("defaults the highlight to the first result", () => {
		const { input } = setup()
		openWithQuery(input, "browser")
		expect(screen.getByTestId("results")).toHaveAttribute("data-highlighted", "a")
	})

	it("moves the highlight with ArrowDown and ArrowUp (wrapping)", () => {
		const { input } = setup()
		openWithQuery(input, "browser")

		fireEvent.keyDown(input, { key: "ArrowDown" })
		expect(screen.getByTestId("results")).toHaveAttribute("data-highlighted", "b")

		fireEvent.keyDown(input, { key: "ArrowUp" })
		expect(screen.getByTestId("results")).toHaveAttribute("data-highlighted", "a")

		// wrap upward from first -> last
		fireEvent.keyDown(input, { key: "ArrowUp" })
		expect(screen.getByTestId("results")).toHaveAttribute("data-highlighted", "b")
	})

	it("selects the highlighted result on Enter and clears the query", () => {
		const { input, onNavigate } = setup()
		openWithQuery(input, "browser")
		fireEvent.keyDown(input, { key: "Enter" })
		expect(onNavigate).toHaveBeenCalledWith("browser", "a")
		// cleared -> dropdown hidden
		expect(screen.queryByTestId("results")).not.toBeInTheDocument()
	})

	it("closes the dropdown on Escape", () => {
		const { input } = setup()
		openWithQuery(input, "browser")
		expect(screen.getByTestId("results")).toBeInTheDocument()
		fireEvent.keyDown(input, { key: "Escape" })
		expect(screen.queryByTestId("results")).not.toBeInTheDocument()
	})

	it("ignores navigation keys when there are no results", () => {
		const { input } = setup()
		openWithQuery(input, "zzzzzzz")
		// dropdown is shown (query + open) but with zero results
		expect(screen.getByTestId("results")).toBeInTheDocument()
		expect(screen.queryByTestId("result-a")).not.toBeInTheDocument()
		// no crash / no highlight
		fireEvent.keyDown(input, { key: "ArrowDown" })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(screen.getByTestId("results")).toHaveAttribute("data-highlighted", "")
	})

	it("selects a result when clicked", () => {
		const { input, onNavigate } = setup()
		openWithQuery(input, "cache")
		fireEvent.click(screen.getByTestId("result-b"))
		expect(onNavigate).toHaveBeenCalledWith("browser", "b")
	})

	it("preserves the current highlight when it survives a results change", () => {
		const { input } = setup()
		openWithQuery(input, "browser")
		fireEvent.keyDown(input, { key: "ArrowDown" }) // highlight "b"
		expect(screen.getByTestId("results")).toHaveAttribute("data-highlighted", "b")

		// narrow to only the "b" item; current highlight "b" still present -> kept
		fireEvent.change(input, { target: { value: "cache" } })
		expect(screen.getByTestId("result-b")).toBeInTheDocument()
		expect(screen.queryByTestId("result-a")).not.toBeInTheDocument()
		expect(screen.getByTestId("results")).toHaveAttribute("data-highlighted", "b")
	})

	it("resets the highlight to the first result when the current one disappears", () => {
		const { input } = setup()
		openWithQuery(input, "cache") // only "b"
		expect(screen.getByTestId("results")).toHaveAttribute("data-highlighted", "b")

		// switch to a query where "b" is gone but "a" matches
		fireEvent.change(input, { target: { value: "enable" } })
		expect(screen.getByTestId("results")).toHaveAttribute("data-highlighted", "a")
	})

	it("collapses on blur after the timeout", () => {
		vi.useFakeTimers()
		try {
			render(<SettingsSearch index={index} onNavigate={vi.fn()} sections={sections} />)
			const input = screen.getByTestId("search-input") as HTMLInputElement
			fireEvent.focus(input)
			fireEvent.change(input, { target: { value: "browser" } })
			expect(screen.getByTestId("results")).toBeInTheDocument()
			act(() => {
				fireEvent.blur(input)
				vi.advanceTimersByTime(200)
			})
			expect(screen.queryByTestId("results")).not.toBeInTheDocument()
		} finally {
			vi.useRealTimers()
		}
	})
})
