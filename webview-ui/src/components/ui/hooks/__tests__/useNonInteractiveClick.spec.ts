import { renderHook } from "@testing-library/react"

import { useAddNonInteractiveClickListener } from "../useNonInteractiveClick"

// 入力中の要素をクリックしても handler を呼ばない（入力を邪魔しない）ことを固定する。
describe("useAddNonInteractiveClickListener", () => {
	const clickOn = (element: HTMLElement) => {
		document.body.appendChild(element)
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
		element.remove()
	}

	it("calls the handler for a click on a non-interactive element", () => {
		const handler = vi.fn()
		renderHook(() => useAddNonInteractiveClickListener(handler))

		clickOn(document.createElement("div"))

		expect(handler).toHaveBeenCalledTimes(1)
	})

	it.each(["input", "select", "textarea", "vscode-text-area", "vscode-text-field"])(
		"does not call the handler for a click on <%s>",
		(tag) => {
			const handler = vi.fn()
			renderHook(() => useAddNonInteractiveClickListener(handler))

			clickOn(document.createElement(tag))

			expect(handler).not.toHaveBeenCalled()
		},
	)

	it("does not call the handler for a click on a contentEditable element", () => {
		const handler = vi.fn()
		renderHook(() => useAddNonInteractiveClickListener(handler))

		const div = document.createElement("div")
		// jsdom does not implement isContentEditable, so define it the way a browser reports it.
		Object.defineProperty(div, "isContentEditable", { value: true })
		clickOn(div)

		expect(handler).not.toHaveBeenCalled()
	})

	it("stops listening after unmount", () => {
		const handler = vi.fn()
		const { unmount } = renderHook(() => useAddNonInteractiveClickListener(handler))

		unmount()
		clickOn(document.createElement("div"))

		expect(handler).not.toHaveBeenCalled()
	})
})
