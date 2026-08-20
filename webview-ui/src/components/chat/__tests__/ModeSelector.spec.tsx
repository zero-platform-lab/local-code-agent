import { render, screen, fireEvent, act } from "@/utils/test-utils"

import type { ModeConfig } from "@openai-agent/types"

import type { Mode } from "@agent/modes"

import { ModeSelector } from "../ModeSelector"

const mockSetHasOpenedModeSelector = vi.hoisted(() => vi.fn())
const extensionState = vi.hoisted(() => ({ hasOpenedModeSelector: false }))
const mockPostMessage = vi.hoisted(() => vi.fn())

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		hasOpenedModeSelector: extensionState.hasOpenedModeSelector,
		setHasOpenedModeSelector: mockSetHasOpenedModeSelector,
	}),
}))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: mockPostMessage } }))

// Create a variable to control what getAllModes returns.
let mockModes: ModeConfig[] = []

vi.mock("@agent/modes", async () => {
	const actual = await vi.importActual<typeof import("@agent/modes")>("@agent/modes")
	return {
		...actual,
		getAllModes: () => mockModes,
		defaultModeSlug: "code", // Export the default mode slug for tests
	}
})

describe("ModeSelector", () => {
	test("shows custom description from customModePrompts", () => {
		const customModePrompts = {
			code: {
				description: "Custom code mode description",
			},
		}

		render(
			<ModeSelector
				title="Mode Selector"
				value={"code" as Mode}
				onChange={vi.fn()}
				modeShortcutText="Ctrl+M"
				customModePrompts={customModePrompts}
			/>,
		)

		expect(screen.getByTestId("mode-selector-trigger")).toBeInTheDocument()
	})

	test("falls back to default description when no custom prompt", () => {
		render(
			<ModeSelector title="Mode Selector" value={"code" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />,
		)

		expect(screen.getByTestId("mode-selector-trigger")).toBeInTheDocument()
	})

	test("shows search bar when there are more than 6 modes", () => {
		mockModes = Array.from({ length: 7 }, (_, i) => ({
			slug: `mode-${i}`,
			name: `Mode ${i}`,
			description: `Description for mode ${i}`,
			roleDefinition: "Role definition",
			groups: ["read", "edit"],
		}))

		render(
			<ModeSelector
				title="Mode Selector"
				value={"mode-0" as Mode}
				onChange={vi.fn()}
				modeShortcutText="Ctrl+M"
			/>,
		)

		// Click to open the popover.
		fireEvent.click(screen.getByTestId("mode-selector-trigger"))

		// Search input should be visible.
		expect(screen.getByTestId("mode-search-input")).toBeInTheDocument()

		// Info icon should be visible.
		expect(screen.getByText("chat:modeSelector.title")).toBeInTheDocument()
		const infoIcon = document.querySelector(".codicon-info")
		expect(infoIcon).toBeInTheDocument()
	})

	test("shows info blurb instead of search bar when there are 6 or fewer modes", () => {
		mockModes = Array.from({ length: 5 }, (_, i) => ({
			slug: `mode-${i}`,
			name: `Mode ${i}`,
			description: `Description for mode ${i}`,
			roleDefinition: "Role definition",
			groups: ["read", "edit"],
		}))

		render(
			<ModeSelector
				title="Mode Selector"
				value={"mode-0" as Mode}
				onChange={vi.fn()}
				modeShortcutText="Ctrl+M"
			/>,
		)

		// Click to open the popover.
		fireEvent.click(screen.getByTestId("mode-selector-trigger"))

		// Search input should NOT be visible.
		expect(screen.queryByTestId("mode-search-input")).not.toBeInTheDocument()

		// Info blurb should be visible.
		expect(screen.getByText(/chat:modeSelector.description/)).toBeInTheDocument()

		// Info icon should NOT be visible.
		const infoIcon = document.querySelector(".codicon-info")
		expect(infoIcon).not.toBeInTheDocument()
	})

	test("filters modes correctly when searching", () => {
		mockModes = Array.from({ length: 7 }, (_, i) => ({
			slug: `mode-${i}`,
			name: `Mode ${i}`,
			description: `Description for mode ${i}`,
			roleDefinition: "Role definition",
			groups: ["read", "edit"],
		}))

		render(
			<ModeSelector
				title="Mode Selector"
				value={"mode-0" as Mode}
				onChange={vi.fn()}
				modeShortcutText="Ctrl+M"
			/>,
		)

		// Click to open the popover.
		fireEvent.click(screen.getByTestId("mode-selector-trigger"))

		// Type in search.
		const searchInput = screen.getByTestId("mode-search-input")
		fireEvent.change(searchInput, { target: { value: "Mode 3" } })

		// Should show filtered results.
		const modeItems = screen.getAllByTestId("mode-selector-item")
		expect(modeItems.length).toBeLessThan(7) // Should have filtered some out.
	})

	test("respects disableSearch prop even when there are more than 6 modes", () => {
		mockModes = Array.from({ length: 10 }, (_, i) => ({
			slug: `mode-${i}`,
			name: `Mode ${i}`,
			description: `Description for mode ${i}`,
			roleDefinition: "Role definition",
			groups: ["read", "edit"],
		}))

		render(
			<ModeSelector
				title="Mode Selector"
				value={"mode-0" as Mode}
				onChange={vi.fn()}
				modeShortcutText="Ctrl+M"
				disableSearch={true}
			/>,
		)

		// Click to open the popover.
		fireEvent.click(screen.getByTestId("mode-selector-trigger"))

		// Search input should NOT be visible even with 10 modes.
		expect(screen.queryByTestId("mode-search-input")).not.toBeInTheDocument()

		// Info blurb should be visible instead.
		expect(screen.getByText(/chat:modeSelector.description/)).toBeInTheDocument()

		// Info icon should NOT be visible.
		const infoIcon = document.querySelector(".codicon-info")
		expect(infoIcon).not.toBeInTheDocument()
	})

	test("shows search when disableSearch is false (default) and modes > 6", () => {
		mockModes = Array.from({ length: 8 }, (_, i) => ({
			slug: `mode-${i}`,
			name: `Mode ${i}`,
			description: `Description for mode ${i}`,
			roleDefinition: "Role definition",
			groups: ["read", "edit"],
		}))

		// Don't pass disableSearch prop (should default to false).
		render(
			<ModeSelector
				title="Mode Selector"
				value={"mode-0" as Mode}
				onChange={vi.fn()}
				modeShortcutText="Ctrl+M"
			/>,
		)

		fireEvent.click(screen.getByTestId("mode-selector-trigger"))

		expect(screen.getByTestId("mode-search-input")).toBeInTheDocument()

		const infoIcon = document.querySelector(".codicon-info")
		expect(infoIcon).toBeInTheDocument()
	})

	test("falls back to default mode when current mode is not available", async () => {
		// Set up modes including "code" as the default mode (which getAllModes returns first)
		mockModes = [
			{
				slug: "code",
				name: "Code",
				description: "Code mode",
				roleDefinition: "Role definition",
				groups: ["read", "edit"],
			},
			{
				slug: "other",
				name: "Other",
				description: "Other mode",
				roleDefinition: "Role definition",
				groups: ["read"],
			},
		]

		const onChange = vi.fn()

		render(
			<ModeSelector
				title="Mode Selector"
				value={"non-existent-mode" as Mode}
				onChange={onChange}
				modeShortcutText="Ctrl+M"
			/>,
		)

		// The component should automatically call onChange with the fallback mode (code)
		// via useEffect after render
		await vi.waitFor(() => {
			expect(onChange).toHaveBeenCalledWith("code")
		})
	})

	test("shows default mode name when current mode is not available", () => {
		// Set up modes where "code" is available (the default mode)
		mockModes = [
			{
				slug: "code",
				name: "Code",
				description: "Code mode",
				roleDefinition: "Role definition",
				groups: ["read", "edit"],
			},
			{
				slug: "other",
				name: "Other",
				description: "Other mode",
				roleDefinition: "Role definition",
				groups: ["read"],
			},
		]

		render(
			<ModeSelector
				title="Mode Selector"
				value={"non-existent-mode" as Mode}
				onChange={vi.fn()}
				modeShortcutText="Ctrl+M"
			/>,
		)

		// Should show the default mode name instead of empty string
		const trigger = screen.getByTestId("mode-selector-trigger")
		expect(trigger).toHaveTextContent("Code")
	})
	describe("choosing and searching", () => {
		const someModes = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				slug: `mode-${index}`,
				name: `Mode ${index}`,
				description: `Description for mode ${index}`,
				roleDefinition: "Role definition",
				groups: ["read", "edit"],
			})) as ModeConfig[]

		beforeEach(() => {
			mockModes = someModes(7)
			extensionState.hasOpenedModeSelector = false
			mockPostMessage.mockClear()
			mockSetHasOpenedModeSelector.mockClear()
		})

		test("reports the chosen mode and closes the list", () => {
			const onChange = vi.fn()
			render(<ModeSelector title="Mode" value={"mode-0" as Mode} onChange={onChange} modeShortcutText="Ctrl+M" />)

			fireEvent.click(screen.getByTestId("mode-selector-trigger"))
			fireEvent.click(screen.getAllByTestId("mode-selector-item")[2])

			expect(onChange).toHaveBeenCalledWith("mode-2")
			expect(screen.queryAllByTestId("mode-selector-item")).toHaveLength(0)
		})

		test("marks the current mode in the list", () => {
			const { container } = render(
				<ModeSelector title="Mode" value={"mode-1" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />,
			)

			fireEvent.click(screen.getByTestId("mode-selector-trigger"))

			expect(screen.getAllByTestId("mode-selector-item")[1].className).toContain("activeSelectionBackground")
			expect(container.ownerDocument.querySelectorAll(".lucide-check")).toHaveLength(1)
		})

		test("finds a mode by its description as well as its name", () => {
			mockModes = [
				{
					slug: "code",
					name: "Code",
					description: "writes software",
					roleDefinition: "r",
					groups: ["read"],
				},
				{
					slug: "ask",
					name: "Ask",
					description: "answers questions",
					roleDefinition: "r",
					groups: ["read"],
				},
				...someModes(5),
			] as ModeConfig[]

			render(<ModeSelector title="Mode" value={"code" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))
			fireEvent.change(screen.getByTestId("mode-search-input"), { target: { value: "questions" } })

			const items = screen.getAllByTestId("mode-selector-item")
			expect(items).toHaveLength(1)
			expect(items[0]).toHaveTextContent("Ask")
		})

		test("says so when nothing matches", () => {
			render(<ModeSelector title="Mode" value={"mode-0" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))

			fireEvent.change(screen.getByTestId("mode-search-input"), { target: { value: "zzzz-nothing" } })

			expect(screen.queryAllByTestId("mode-selector-item")).toHaveLength(0)
			expect(screen.getByText("chat:modeSelector.noResults")).toBeInTheDocument()
		})

		test("clears the search from the X control", () => {
			const { container } = render(
				<ModeSelector title="Mode" value={"mode-0" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />,
			)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))
			const input = screen.getByTestId("mode-search-input") as HTMLInputElement
			fireEvent.change(input, { target: { value: "mode-3" } })

			fireEvent.click(container.ownerDocument.querySelector(".lucide-x")!)

			expect((screen.getByTestId("mode-search-input") as HTMLInputElement).value).toBe("")
			expect(screen.getAllByTestId("mode-selector-item").length).toBeGreaterThan(1)
		})

		test("forgets the search when the list is closed again", () => {
			render(<ModeSelector title="Mode" value={"mode-0" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))
			fireEvent.change(screen.getByTestId("mode-search-input"), { target: { value: "mode-3" } })

			fireEvent.click(screen.getByTestId("mode-selector-trigger"))
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))

			expect((screen.getByTestId("mode-search-input") as HTMLInputElement).value).toBe("")
		})

		test("remembers that the selector has been opened, so it stops being highlighted", () => {
			render(<ModeSelector title="Mode" value={"mode-0" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)
			const trigger = screen.getByTestId("mode-selector-trigger")
			expect(trigger.className).toContain("bg-primary")

			fireEvent.click(trigger)

			expect(mockSetHasOpenedModeSelector).toHaveBeenCalledWith(true)
		})

		test("is not highlighted once it has been opened before", () => {
			extensionState.hasOpenedModeSelector = true

			render(<ModeSelector title="Mode" value={"mode-0" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)

			expect(screen.getByTestId("mode-selector-trigger").className).not.toContain("bg-primary")
		})

		test("opens the mode settings and closes the list", () => {
			render(<ModeSelector title="Mode" value={"mode-0" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))

			fireEvent.click(screen.getByRole("button", { name: "chat:modeSelector.settings" }))

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "switchTab",
				tab: "settings",
				values: { section: "modes" },
			})
			expect(screen.queryAllByTestId("mode-selector-item")).toHaveLength(0)
		})

		test("falls back to the default mode when the current one no longer exists", () => {
			const onChange = vi.fn()
			mockModes = [
				{ slug: "code", name: "Code", description: "d", roleDefinition: "r", groups: ["read"] },
			] as ModeConfig[]

			const { rerender } = render(
				<ModeSelector title="Mode" value={"gone" as Mode} onChange={onChange} modeShortcutText="Ctrl+M" />,
			)

			expect(onChange).toHaveBeenCalledWith("code")
			expect(screen.getByTestId("mode-selector-trigger")).toHaveTextContent("Code")

			// Re-rendering with the same invalid mode must not tell the parent twice.
			onChange.mockClear()
			rerender(<ModeSelector title="Mode" value={"gone" as Mode} onChange={onChange} modeShortcutText="Ctrl+M" />)
			expect(onChange).not.toHaveBeenCalled()
		})

		test("says nothing when the default mode is missing too", () => {
			const onChange = vi.fn()
			mockModes = [
				{ slug: "other", name: "Other", description: "d", roleDefinition: "r", groups: ["read"] },
			] as ModeConfig[]

			render(<ModeSelector title="Mode" value={"gone" as Mode} onChange={onChange} modeShortcutText="Ctrl+M" />)

			expect(onChange).not.toHaveBeenCalled()
			expect(screen.getByTestId("mode-selector-trigger")).toHaveTextContent("")
		})
	})
	describe("presentation details", () => {
		beforeEach(() => {
			extensionState.hasOpenedModeSelector = false
			mockPostMessage.mockClear()
		})

		test("keeps a mode's own description when the custom prompts do not override it", () => {
			mockModes = [
				{
					slug: "code",
					name: "Code",
					description: "built-in description",
					roleDefinition: "r",
					groups: ["read"],
				},
			] as ModeConfig[]

			render(
				<ModeSelector
					title="Mode"
					value={"code" as Mode}
					onChange={vi.fn()}
					modeShortcutText="Ctrl+M"
					customModePrompts={{ other: { description: "not this one" } }}
				/>,
			)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))

			expect(screen.getByText("built-in description")).toBeInTheDocument()
		})

		test("renders a mode that has no description at all", () => {
			mockModes = [{ slug: "code", name: "Code", roleDefinition: "r", groups: ["read"] }] as ModeConfig[]

			render(<ModeSelector title="Mode" value={"code" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))

			expect(screen.getByTestId("mode-selector-item")).toHaveTextContent("Code")
		})

		test("cannot be opened while disabled", () => {
			mockModes = [
				{ slug: "code", name: "Code", description: "d", roleDefinition: "r", groups: ["read"] },
			] as ModeConfig[]

			render(
				<ModeSelector
					title="Mode"
					value={"code" as Mode}
					onChange={vi.fn()}
					modeShortcutText="Ctrl+M"
					disabled
				/>,
			)
			const trigger = screen.getByTestId("mode-selector-trigger")

			expect(trigger.className).toContain("cursor-not-allowed")
			fireEvent.click(trigger)
			expect(screen.queryAllByTestId("mode-selector-item")).toHaveLength(0)
		})

		test("tells the parent only once about the same missing mode", () => {
			const onChange = vi.fn()
			mockModes = [
				{ slug: "code", name: "Code", description: "d", roleDefinition: "r", groups: ["read"] },
			] as ModeConfig[]

			const { rerender } = render(
				<ModeSelector
					title="Mode"
					value={"gone" as Mode}
					onChange={onChange}
					modeShortcutText="Ctrl+M"
					customModePrompts={{ code: { description: "one" } }}
				/>,
			)
			expect(onChange).toHaveBeenCalledTimes(1)

			// A new customModePrompts object rebuilds the mode list and re-runs the check.
			rerender(
				<ModeSelector
					title="Mode"
					value={"gone" as Mode}
					onChange={onChange}
					modeShortcutText="Ctrl+M"
					customModePrompts={{ code: { description: "two" } }}
				/>,
			)

			expect(onChange).toHaveBeenCalledTimes(1)
		})

		test("scrolls the current mode into the middle of the list when opened", async () => {
			mockModes = Array.from({ length: 7 }, (_, index) => ({
				slug: `mode-${index}`,
				name: `Mode ${index}`,
				description: `Description ${index}`,
				roleDefinition: "r",
				groups: ["read"],
			})) as ModeConfig[]

			const scrollTo = vi.fn()
			Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: scrollTo, configurable: true })
			Object.defineProperty(HTMLElement.prototype, "clientHeight", { value: 100, configurable: true })
			Object.defineProperty(HTMLElement.prototype, "scrollHeight", { value: 400, configurable: true })
			Object.defineProperty(HTMLElement.prototype, "offsetHeight", { value: 20, configurable: true })
			Object.defineProperty(HTMLElement.prototype, "offsetTop", { value: 200, configurable: true })

			render(<ModeSelector title="Mode" value={"mode-4" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))

			await act(async () => {
				await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
			})

			// 200 - 100/2 + 20/2 = 160, which is within the 300px of scrollable room.
			expect(scrollTo).toHaveBeenCalledWith({ top: 160, behavior: "instant" })
		})
	})
	describe("focus", () => {
		beforeEach(() => {
			extensionState.hasOpenedModeSelector = false
		})

		test("puts the caret in the search box as soon as the list opens", async () => {
			// Radix moves focus into the popover content, which starts at the search input. The
			// test setup replaces HTMLElement.focus with a no-op, so the call itself is observed
			// rather than document.activeElement.
			const focus = vi.fn()
			const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "focus")
			Object.defineProperty(HTMLInputElement.prototype, "focus", { value: focus, configurable: true })

			mockModes = Array.from({ length: 7 }, (_, index) => ({
				slug: `mode-${index}`,
				name: `Mode ${index}`,
				description: `Description ${index}`,
				roleDefinition: "r",
				groups: ["read"],
			})) as ModeConfig[]

			render(<ModeSelector title="Mode" value={"mode-0" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))

			await act(async () => {
				await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
			})

			expect(focus).toHaveBeenCalled()

			if (original) {
				Object.defineProperty(HTMLInputElement.prototype, "focus", original)
			} else {
				delete (HTMLInputElement.prototype as unknown as Record<string, unknown>).focus
			}
		})

		test("opens fine when there is no search box to focus", async () => {
			mockModes = [
				{ slug: "code", name: "Code", description: "d", roleDefinition: "r", groups: ["read"] },
			] as ModeConfig[]

			render(<ModeSelector title="Mode" value={"code" as Mode} onChange={vi.fn()} modeShortcutText="Ctrl+M" />)
			fireEvent.click(screen.getByTestId("mode-selector-trigger"))

			await act(async () => {
				await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
			})

			expect(screen.queryByTestId("mode-search-input")).not.toBeInTheDocument()
			expect(screen.getByTestId("mode-selector-item")).toBeInTheDocument()
		})
	})
})
