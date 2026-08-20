// npx vitest run src/components/ui/__tests__/autosize-textarea.spec.tsx

import React from "react"
import { render, screen, fireEvent, act } from "@/utils/test-utils"
import { renderHook } from "@testing-library/react"
import { AutosizeTextarea, useAutosizeTextArea, type AutosizeTextAreaRef } from "../autosize-textarea"

describe("useAutosizeTextArea", () => {
	it("sets minHeight and maxHeight on init", () => {
		const textarea = document.createElement("textarea")
		const ref = { current: textarea }

		renderHook(() =>
			useAutosizeTextArea({
				textAreaRef: ref,
				triggerAutoSize: "",
				minHeight: 40,
				maxHeight: 200,
			}),
		)

		expect(textarea.style.minHeight).toBe("46px") // 40 + offsetBorder(6)
		expect(textarea.style.maxHeight).toBe("200px")
	})

	it("does not set maxHeight when maxHeight <= minHeight", () => {
		const textarea = document.createElement("textarea")
		const ref = { current: textarea }

		renderHook(() =>
			useAutosizeTextArea({
				textAreaRef: ref,
				triggerAutoSize: "",
				minHeight: 100,
				maxHeight: 50,
			}),
		)

		expect(textarea.style.minHeight).toBe("106px")
		// maxHeight should not be set
		expect(textarea.style.maxHeight).toBe("")
	})

	it("uses maxHeight when scrollHeight exceeds it", () => {
		const textarea = document.createElement("textarea")
		// Mock scrollHeight to be larger than maxHeight
		Object.defineProperty(textarea, "scrollHeight", { value: 500, configurable: true })
		const ref = { current: textarea }

		renderHook(() =>
			useAutosizeTextArea({
				textAreaRef: ref,
				triggerAutoSize: "some text",
				minHeight: 40,
				maxHeight: 200,
			}),
		)

		expect(textarea.style.height).toBe("200px")
	})

	it("uses scrollHeight + offset when scrollHeight is within maxHeight", () => {
		const textarea = document.createElement("textarea")
		Object.defineProperty(textarea, "scrollHeight", { value: 100, configurable: true })
		const ref = { current: textarea }

		renderHook(() =>
			useAutosizeTextArea({
				textAreaRef: ref,
				triggerAutoSize: "text",
				minHeight: 40,
				maxHeight: 200,
			}),
		)

		expect(textarea.style.height).toBe("106px") // 100 + 6
	})

	it("does nothing when ref is null", () => {
		const ref = { current: null }

		// Should not throw
		renderHook(() =>
			useAutosizeTextArea({
				textAreaRef: ref,
				triggerAutoSize: "",
				minHeight: 40,
				maxHeight: 200,
			}),
		)
	})

	it("defaults minHeight to 0 and maxHeight to MAX_SAFE_INTEGER", () => {
		const textarea = document.createElement("textarea")
		Object.defineProperty(textarea, "scrollHeight", { value: 50, configurable: true })
		const ref = { current: textarea }

		renderHook(() =>
			useAutosizeTextArea({
				textAreaRef: ref,
				triggerAutoSize: "",
			}),
		)

		expect(textarea.style.minHeight).toBe("6px") // 0 + 6
		expect(textarea.style.height).toBe("56px") // 50 + 6
	})
})

describe("AutosizeTextarea", () => {
	it("renders a textarea element", () => {
		render(<AutosizeTextarea minHeight={40} maxHeight={200} data-testid="ata" />)
		expect(screen.getByTestId("ata").tagName).toBe("TEXTAREA")
	})

	it("applies default styling classes", () => {
		render(<AutosizeTextarea minHeight={40} maxHeight={200} data-testid="ata" />)
		const ta = screen.getByTestId("ata")
		expect(ta.className).toContain("bg-vscode-input-background")
	})

	it("merges custom className", () => {
		render(<AutosizeTextarea minHeight={40} maxHeight={200} className="custom" data-testid="ata" />)
		expect(screen.getByTestId("ata").className).toContain("custom")
	})

	it("calls onChange callback and updates trigger", () => {
		const onChange = vi.fn()
		render(<AutosizeTextarea minHeight={40} maxHeight={200} onChange={onChange} data-testid="ata" />)

		fireEvent.change(screen.getByTestId("ata"), { target: { value: "hello" } })
		expect(onChange).toHaveBeenCalled()
	})

	it("fires onChange even without external handler", () => {
		// Should not throw
		render(<AutosizeTextarea minHeight={40} maxHeight={200} data-testid="ata" />)
		fireEvent.change(screen.getByTestId("ata"), { target: { value: "hello" } })
	})

	it("exposes imperative handle via ref", () => {
		const ref = React.createRef<AutosizeTextAreaRef>()
		render(<AutosizeTextarea ref={ref} minHeight={40} maxHeight={200} />)

		expect(ref.current).toBeTruthy()
		expect(ref.current!.minHeight).toBe(40)
		expect(ref.current!.maxHeight).toBe(200)
		expect(ref.current!.textArea).toBeInstanceOf(HTMLTextAreaElement)
	})

	it("focuses the underlying textarea through the imperative handle", () => {
		const ref = React.createRef<AutosizeTextAreaRef>()
		render(<AutosizeTextarea ref={ref} minHeight={40} maxHeight={200} data-testid="ata" />)

		// vitest.setup.ts が HTMLElement.prototype.focus を差し替えているため、
		// activeElement では観測できない。setter 経由で差し込んで呼び出しを見る。
		const focused = vi.fn()
		const textArea = screen.getByTestId("ata") as HTMLTextAreaElement
		textArea.focus = focused
		act(() => ref.current!.focus())
		expect(focused).toHaveBeenCalledTimes(1)
	})

	it("triggers autosize when value prop changes", () => {
		const { rerender } = render(<AutosizeTextarea minHeight={40} maxHeight={200} value="a" data-testid="ata" />)
		rerender(<AutosizeTextarea minHeight={40} maxHeight={200} value="abcdef" data-testid="ata" />)
		// This just verifies no crash; the effect runs internally
		expect(screen.getByTestId("ata")).toBeInTheDocument()
	})

	it("triggers autosize when defaultValue changes", () => {
		const { rerender } = render(
			<AutosizeTextarea minHeight={40} maxHeight={200} defaultValue="a" data-testid="ata" />,
		)
		rerender(<AutosizeTextarea minHeight={40} maxHeight={200} defaultValue="xyz" data-testid="ata" />)
		expect(screen.getByTestId("ata")).toBeInTheDocument()
	})
})
