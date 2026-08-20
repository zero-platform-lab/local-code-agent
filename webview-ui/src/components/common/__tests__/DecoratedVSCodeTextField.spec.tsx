import { createRef } from "react"

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { DecoratedVSCodeTextField } from "../DecoratedVSCodeTextField"

// The real VSCodeTextField is a web component whose input lives in a shadow root; jsdom does not
// upgrade it, so the mock reproduces both placements plus the "no input at all" case.
const toolkit = vi.hoisted(() => ({ inputPlacement: "light-dom" as "light-dom" | "shadow" | "none" }))

vi.mock("@vscode/webview-ui-toolkit/react", async () => {
	const { forwardRef } = await import("react")

	const VSCodeTextField = forwardRef((props: any, ref: any) => {
		const attach = (element: HTMLElement | null) => {
			if (element && toolkit.inputPlacement === "shadow" && !element.shadowRoot) {
				element.attachShadow({ mode: "open" }).appendChild(document.createElement("input"))
			}

			if (typeof ref === "function") {
				ref(element)
			}
		}

		return (
			<div data-testid={props["data-testid"] ?? "vscode-text-field"} ref={attach} style={props.style}>
				{toolkit.inputPlacement === "light-dom" ? <input /> : null}
			</div>
		)
	})

	return { VSCodeTextField }
})

const field = () => screen.getByTestId("vscode-text-field")

describe("DecoratedVSCodeTextField", () => {
	beforeEach(() => {
		toolkit.inputPlacement = "light-dom"
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("hands the caller a ref to the real input, not to the web component", () => {
		const ref = createRef<HTMLInputElement>()

		render(<DecoratedVSCodeTextField ref={ref} />)

		expect(ref.current).toBeInstanceOf(HTMLInputElement)
	})

	it("supports a callback ref as well", () => {
		const received: unknown[] = []

		render(<DecoratedVSCodeTextField ref={(element) => received.push(element)} />)

		expect(received.some((element) => element instanceof HTMLInputElement)).toBe(true)
	})

	it("finds the input inside the shadow root", () => {
		toolkit.inputPlacement = "shadow"
		const ref = createRef<HTMLInputElement>()

		render(<DecoratedVSCodeTextField ref={ref} />)

		expect(ref.current).toBeInstanceOf(HTMLInputElement)
	})

	it("leaves the ref alone when there is no input to point at", () => {
		toolkit.inputPlacement = "none"
		const ref = createRef<HTMLInputElement>()

		render(<DecoratedVSCodeTextField ref={ref} />)

		expect(ref.current).toBeNull()
	})

	it("renders without a ref at all", () => {
		expect(() => render(<DecoratedVSCodeTextField />)).not.toThrow()
	})

	it("focuses the input when the surrounding box is clicked", async () => {
		vi.useFakeTimers()
		const ref = createRef<HTMLInputElement>()
		const { container } = render(<DecoratedVSCodeTextField ref={ref} />)
		const focus = vi.fn()
		ref.current!.focus = focus

		fireEvent.mouseDown(container.firstChild!)
		act(() => {
			vi.runAllTimers()
		})

		expect(focus).toHaveBeenCalled()
		vi.useRealTimers()
	})

	it("does not steal focus that the input already has", async () => {
		vi.useFakeTimers()
		const ref = createRef<HTMLInputElement>()
		const { container } = render(<DecoratedVSCodeTextField ref={ref} />)
		const focus = vi.fn()
		ref.current!.focus = focus
		const activeElement = vi.spyOn(document, "activeElement", "get").mockReturnValue(ref.current)

		fireEvent.mouseDown(container.firstChild!)
		act(() => {
			vi.runAllTimers()
		})

		expect(focus).not.toHaveBeenCalled()
		activeElement.mockRestore()
		vi.useRealTimers()
	})

	it("does nothing on click when there is no input", () => {
		toolkit.inputPlacement = "none"
		vi.useFakeTimers()
		const { container } = render(<DecoratedVSCodeTextField />)

		fireEvent.mouseDown(container.firstChild!)

		expect(() =>
			act(() => {
				vi.runAllTimers()
			}),
		).not.toThrow()
		vi.useRealTimers()
	})

	it("makes room for decorations on the side that has them", () => {
		render(<DecoratedVSCodeTextField leftNodes={[<span key="l">L</span>]} />)

		expect(field().style.paddingLeft).toBe("24px")
		expect(field().style.paddingRight).toBe("")
		expect(screen.getByText("L")).toBeInTheDocument()
	})

	it("makes room on the right as well", () => {
		render(<DecoratedVSCodeTextField rightNodes={[<span key="r">R</span>]} />)

		expect(field().style.paddingRight).toBe("24px")
		expect(field().style.paddingLeft).toBe("")
	})

	it("reserves no room for an empty decoration list", () => {
		render(<DecoratedVSCodeTextField leftNodes={[]} rightNodes={[]} />)

		expect(field().style.paddingLeft).toBe("")
		expect(field().style.paddingRight).toBe("")
	})

	it("reserves no room when every decoration is falsy", () => {
		render(<DecoratedVSCodeTextField leftNodes={[null, false]} rightNodes={[undefined]} />)

		expect(field().style.paddingLeft).toBe("")
		expect(field().style.paddingRight).toBe("")
	})

	it("reserves no room when no decorations are passed at all", () => {
		render(<DecoratedVSCodeTextField />)

		expect(field().style.paddingLeft).toBe("")
	})

	it("keeps the caller's class name and style on the wrapper", () => {
		const { container } = render(<DecoratedVSCodeTextField className="w-32" style={{ marginTop: 4 }} />)
		const wrapper = container.firstChild as HTMLElement

		expect(wrapper.className).toContain("w-32")
		expect(wrapper.className).toContain("relative")
		expect(wrapper.style.marginTop).toBe("4px")
	})

	it("passes the test id through to the field itself", () => {
		render(<DecoratedVSCodeTextField data-testid="my-field" />)

		expect(screen.getByTestId("my-field")).toBeInTheDocument()
	})
})
