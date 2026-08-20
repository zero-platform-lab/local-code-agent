// npx vitest run src/components/ui/__tests__/searchable-select.spec.tsx

import { ReactNode } from "react"
import { render, screen, fireEvent, act } from "@/utils/test-utils"
import { SearchableSelect, type SearchableSelectOption } from "../searchable-select"

// Mock useEscapeKey
vi.mock("@/hooks/useEscapeKey", () => ({
	useEscapeKey: vi.fn(),
}))

// Mock the UI components to avoid Radix portal/popover complexity
vi.mock("@/components/ui", async () => {
	const { forwardRef } = await import("react")
	return {
		Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
		Popover: ({
			children,
			open,
			onOpenChange,
		}: {
			children: ReactNode
			open?: boolean
			onOpenChange?: (o: boolean) => void
		}) => {
			return (
				<div data-testid="popover" data-open={open}>
					{children}
					{/* Expose onOpenChange for testing */}
					<button
						data-testid="popover-close"
						onClick={() => onOpenChange?.(false)}
						style={{ display: "none" }}
					/>
					<button
						data-testid="popover-open"
						onClick={() => onOpenChange?.(true)}
						style={{ display: "none" }}
					/>
				</div>
			)
		},
		PopoverTrigger: ({ children, asChild, ...props }: any) => {
			if (asChild) return <>{children}</>
			return <div {...props}>{children}</div>
		},
		PopoverContent: ({ children }: any) => <div data-testid="popover-content">{children}</div>,
		Command: ({ children }: any) => <div>{children}</div>,
		CommandEmpty: ({ children }: any) => <div data-testid="cmd-empty">{children}</div>,
		CommandGroup: ({ children }: any) => <div>{children}</div>,
		CommandInput: forwardRef(({ value, onValueChange, placeholder, ...props }: any, ref: any) => (
			<input
				data-testid="search-input"
				ref={ref}
				value={value}
				onChange={(e: any) => onValueChange?.(e.target.value)}
				placeholder={placeholder}
				{...props}
			/>
		)),
		CommandItem: ({ children, onSelect, disabled, ...props }: any) => (
			<div data-testid="cmd-item" onClick={() => !disabled && onSelect?.()} data-disabled={disabled} {...props}>
				{children}
			</div>
		),
		CommandList: ({ children }: any) => <div>{children}</div>,
	}
})

const baseOptions: SearchableSelectOption[] = [
	{ value: "apple", label: "Apple" },
	{ value: "banana", label: "Banana" },
	{ value: "cherry", label: "Cherry" },
]

describe("SearchableSelect", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("renders placeholder when no value selected", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select fruit"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)
		expect(screen.getByText("Select fruit")).toBeInTheDocument()
	})

	it("renders selected option label", () => {
		render(
			<SearchableSelect
				value="banana"
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select fruit"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)
		// 選択済みラベルはトリガー側に出る（同じ文字列が候補リストにも並ぶため範囲を絞る）。
		expect(screen.getByRole("combobox")).toHaveTextContent("Banana")
	})

	it("calls onValueChange when an item is selected", () => {
		const onValueChange = vi.fn()
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={onValueChange}
				placeholder="Select fruit"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		const items = screen.getAllByTestId("cmd-item")
		fireEvent.click(items[1]) // click Banana
		expect(onValueChange).toHaveBeenCalledWith("banana")
	})

	it("filters options based on search value", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		const input = screen.getByTestId("search-input")
		fireEvent.change(input, { target: { value: "ban" } })

		// After filtering, only Banana should match
		const items = screen.getAllByTestId("cmd-item")
		expect(items).toHaveLength(1)
		expect(items[0]).toHaveTextContent("Banana")
	})

	it("shows clear search button when search has value", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		// Initially no clear button
		expect(screen.queryByTestId("clear-search-button")).not.toBeInTheDocument()

		const input = screen.getByTestId("search-input")
		fireEvent.change(input, { target: { value: "x" } })
		expect(screen.getByTestId("clear-search-button")).toBeInTheDocument()
	})

	it("clears search when clear button is clicked", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		const input = screen.getByTestId("search-input")
		fireEvent.change(input, { target: { value: "ban" } })
		expect(screen.getAllByTestId("cmd-item")).toHaveLength(1)

		fireEvent.click(screen.getByTestId("clear-search-button"))

		// All options visible again
		expect(screen.getAllByTestId("cmd-item")).toHaveLength(3)
	})

	it("returns focus to the search input after clearing", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		const input = screen.getByTestId("search-input") as HTMLInputElement
		// vitest.setup.ts が focus を差し替えているので setter 経由で観測する。
		const focused = vi.fn()
		input.focus = focused

		fireEvent.change(input, { target: { value: "ban" } })
		fireEvent.click(screen.getByTestId("clear-search-button"))

		expect(focused).toHaveBeenCalledTimes(1)
	})

	it("limits displayed items to maxDisplayItems", () => {
		const manyOptions = Array.from({ length: 100 }, (_, i) => ({
			value: `opt-${i}`,
			label: `Option ${i}`,
		}))

		render(
			<SearchableSelect
				options={manyOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
				maxDisplayItems={10}
			/>,
		)

		expect(screen.getAllByTestId("cmd-item")).toHaveLength(10)
	})

	it("prepends selected option when it would be truncated", () => {
		const manyOptions = Array.from({ length: 100 }, (_, i) => ({
			value: `opt-${i}`,
			label: `Option ${i}`,
		}))

		render(
			<SearchableSelect
				value="opt-99"
				options={manyOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
				maxDisplayItems={10}
			/>,
		)

		const items = screen.getAllByTestId("cmd-item")
		expect(items).toHaveLength(10)
		// The selected option (opt-99) should be in the list
		expect(items.some((item) => item.textContent?.includes("Option 99"))).toBe(true)
	})

	it("resets search when value changes", () => {
		const { rerender } = render(
			<SearchableSelect
				value="apple"
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		const input = screen.getByTestId("search-input")
		fireEvent.change(input, { target: { value: "ban" } })

		rerender(
			<SearchableSelect
				value="banana"
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		// After value change, search should reset (after timeout)
		act(() => {
			vi.advanceTimersByTime(100)
		})

		expect((input as HTMLInputElement).value).toBe("")
	})

	it("resets search when popover closes", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		const input = screen.getByTestId("search-input")
		fireEvent.change(input, { target: { value: "ban" } })

		// Close the popover
		fireEvent.click(screen.getByTestId("popover-close"))

		act(() => {
			vi.advanceTimersByTime(100)
		})

		expect((input as HTMLInputElement).value).toBe("")
	})

	it("drops the pending reset when the popover closes again", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		const input = screen.getByTestId("search-input") as HTMLInputElement
		// マウント時にも「100ms 後に検索欄を空にする」予約が入るので、先に流しておく。
		act(() => {
			vi.advanceTimersByTime(100)
		})

		fireEvent.change(input, { target: { value: "ban" } })

		fireEvent.click(screen.getByTestId("popover-close"))
		act(() => {
			vi.advanceTimersByTime(60)
		})

		// 2 回目の close は 1 回目の予約を捨てる。捨てないと、この後に打ち直した
		// 検索語が古いタイマーで消える。
		fireEvent.click(screen.getByTestId("popover-close"))
		fireEvent.change(input, { target: { value: "che" } })

		act(() => {
			vi.advanceTimersByTime(60)
		})
		expect(input.value).toBe("che")

		act(() => {
			vi.advanceTimersByTime(60)
		})
		expect(input.value).toBe("")
	})

	it("handles disabled prop", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
				disabled
			/>,
		)

		const trigger = screen.getByRole("combobox")
		expect(trigger).toBeDisabled()
	})

	it("renders disabled options with error styling", () => {
		const opts: SearchableSelectOption[] = [
			{ value: "a", label: "Alpha", disabled: true },
			{ value: "b", label: "Beta" },
		]

		render(
			<SearchableSelect
				options={opts}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		const items = screen.getAllByTestId("cmd-item")
		expect(items[0]).toHaveAttribute("data-disabled", "true")
	})

	it("passes data-testid to trigger", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
				data-testid="my-select"
			/>,
		)

		expect(screen.getByTestId("my-select")).toBeInTheDocument()
	})

	it("renders option icons", () => {
		const opts: SearchableSelectOption[] = [
			{ value: "a", label: "Alpha", icon: <span data-testid="icon-a">*</span> },
		]

		render(
			<SearchableSelect
				options={opts}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		expect(screen.getByTestId("icon-a")).toBeInTheDocument()
	})

	it("shows emptyMessage only when searching with no results", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="Nothing found"
			/>,
		)

		const input = screen.getByTestId("search-input")
		fireEvent.change(input, { target: { value: "zzz" } })

		expect(screen.getByText("Nothing found")).toBeInTheDocument()
	})

	it("cleans up timeout on unmount", () => {
		const { unmount } = render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
			/>,
		)

		// Close popover to create a timeout
		fireEvent.click(screen.getByTestId("popover-close"))

		// Unmount should clear the timeout without errors
		unmount()
		act(() => {
			vi.advanceTimersByTime(200)
		})
	})

	it("applies custom className", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
				className="my-class"
			/>,
		)

		const trigger = screen.getByRole("combobox")
		expect(trigger.className).toContain("my-class")
	})

	it("does not prepend selected option when it is already in the limited set", () => {
		const manyOptions = Array.from({ length: 100 }, (_, i) => ({
			value: `opt-${i}`,
			label: `Option ${i}`,
		}))

		render(
			<SearchableSelect
				value="opt-0"
				options={manyOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
				maxDisplayItems={10}
			/>,
		)

		const items = screen.getAllByTestId("cmd-item")
		expect(items).toHaveLength(10)
	})

	it("returns all items when under maxDisplayItems", () => {
		render(
			<SearchableSelect
				options={baseOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
				maxDisplayItems={50}
			/>,
		)

		expect(screen.getAllByTestId("cmd-item")).toHaveLength(3)
	})

	it("does not prepend selected option when it does not match current filter", () => {
		const manyOptions = Array.from({ length: 100 }, (_, i) => ({
			value: `opt-${i}`,
			label: `Option ${i}`,
		}))

		render(
			<SearchableSelect
				value="opt-99"
				options={manyOptions}
				onValueChange={vi.fn()}
				placeholder="Select"
				searchPlaceholder="Search..."
				emptyMessage="None"
				maxDisplayItems={5}
			/>,
		)

		const input = screen.getByTestId("search-input")
		// Filter to only show options 10-19
		fireEvent.change(input, { target: { value: "Option 1" } })

		const items = screen.getAllByTestId("cmd-item")
		// opt-99 should NOT be prepended because it doesn't match the filter "Option 1"
		expect(items.every((item) => !item.textContent?.includes("Option 99"))).toBe(true)
	})
})
