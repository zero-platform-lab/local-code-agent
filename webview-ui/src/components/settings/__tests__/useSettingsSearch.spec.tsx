import { renderHook, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import {
	useSearchIndexContext,
	useSearchIndexRegistry,
	useSettingsSearch,
	scanDOMForSearchableSettings,
	type SearchableSettingData,
} from "../useSettingsSearch"

const getSectionLabel = (section: string) => `label:${section}`

const sampleIndex: SearchableSettingData[] = [
	{ settingId: "a", section: "browser" as any, label: "Enable browser", sectionLabel: "Browser" },
	{ settingId: "b", section: "checkpoints" as any, label: "Checkpoint timeout", sectionLabel: "Checkpoints" },
]

describe("useSearchIndexContext", () => {
	it("returns null when no provider is present", () => {
		const { result } = renderHook(() => useSearchIndexContext())
		expect(result.current).toBeNull()
	})
})

describe("scanDOMForSearchableSettings", () => {
	it("collects only elements with all three data attributes", () => {
		const container = document.createElement("div")
		container.innerHTML = `
			<div data-searchable data-setting-id="one" data-setting-section="browser" data-setting-label="One"></div>
			<div data-searchable data-setting-id="two" data-setting-section="browser"></div>
			<div data-searchable data-setting-section="browser" data-setting-label="No id"></div>
		`
		const result = scanDOMForSearchableSettings(container, getSectionLabel)
		expect(result).toEqual([{ settingId: "one", section: "browser", label: "One", sectionLabel: "label:browser" }])
	})
})

describe("useSearchIndexRegistry", () => {
	beforeEach(() => {
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(0)
			return 0
		})
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("registers settings and builds the index with section labels", () => {
		const { result } = renderHook(() => useSearchIndexRegistry(getSectionLabel))
		expect(result.current.index).toEqual([])

		act(() => {
			result.current.contextValue.registerSetting({ settingId: "x", section: "browser" as any, label: "X" })
		})

		expect(result.current.index).toEqual([
			{ settingId: "x", section: "browser", label: "X", sectionLabel: "label:browser" },
		])
	})

	it("coalesces multiple registrations scheduled before the frame runs", () => {
		let frameCb: FrameRequestCallback | null = null
		const rafSpy = vi.fn((cb: FrameRequestCallback) => {
			frameCb = cb
			return 0
		})
		vi.stubGlobal("requestAnimationFrame", rafSpy)

		const { result } = renderHook(() => useSearchIndexRegistry(getSectionLabel))

		act(() => {
			result.current.contextValue.registerSetting({ settingId: "x", section: "browser" as any, label: "X" })
			// Second registration before the frame fires must not schedule another frame.
			result.current.contextValue.registerSetting({ settingId: "y", section: "browser" as any, label: "Y" })
		})

		expect(rafSpy).toHaveBeenCalledTimes(1)

		act(() => {
			frameCb?.(0)
		})

		expect(result.current.index.map((s) => s.settingId).sort()).toEqual(["x", "y"])
	})
})

describe("useSettingsSearch", () => {
	it("returns no results for an empty/whitespace query", () => {
		const { result } = renderHook(() => useSettingsSearch({ index: sampleIndex }))
		expect(result.current.results).toEqual([])

		act(() => result.current.setSearchQuery("   "))
		expect(result.current.results).toEqual([])
	})

	it("returns fuzzy matches with positions for a query", () => {
		const { result } = renderHook(() => useSettingsSearch({ index: sampleIndex }))
		act(() => result.current.setSearchQuery("browser"))
		expect(result.current.results.length).toBeGreaterThan(0)
		expect(result.current.results[0].settingId).toBe("a")
		expect(result.current.results[0].positions).toBeInstanceOf(Set)
	})

	it("clearSearch resets the query and closes the dropdown", () => {
		const { result } = renderHook(() => useSettingsSearch({ index: sampleIndex }))
		act(() => {
			result.current.setSearchQuery("browser")
			result.current.setIsOpen(true)
		})
		expect(result.current.results.length).toBeGreaterThan(0)

		act(() => result.current.clearSearch())
		expect(result.current.searchQuery).toBe("")
		expect(result.current.isOpen).toBe(false)
		expect(result.current.results).toEqual([])
	})
})
