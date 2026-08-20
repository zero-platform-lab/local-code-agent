import { render, screen, fireEvent, act, waitFor } from "@/utils/test-utils"

import { getHighlighter, isLanguageLoaded } from "@src/utils/highlighter"

import CodeBlock from "../CodeBlock"

const toJsxRuntime = vi.hoisted(() => vi.fn())
const copyWithFeedback = vi.hoisted(() => vi.fn())
const clipboardState = vi.hoisted(() => ({ showCopyFeedback: false }))

vi.mock("hast-util-to-jsx-runtime", () => ({ toJsxRuntime }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback, showCopyFeedback: clipboardState.showCopyFeedback }),
}))

vi.mock("@src/utils/highlighter", () => ({
	normalizeLanguage: vi.fn((language?: string) => language || "txt"),
	isLanguageLoaded: vi.fn(() => true),
	getHighlighter: vi.fn(),
}))

vi.mock("shiki", () => ({ bundledLanguages: { typescript: {}, txt: {} } }))

const hastFor = (code: string, options: any) => {
	const node = {
		type: "element",
		tagName: "pre",
		properties: {} as Record<string, unknown>,
		children: [
			{
				type: "element",
				tagName: "code",
				properties: {} as Record<string, unknown>,
				children: [{ type: "text", value: code }],
			},
		],
	}

	for (const transformer of options.transformers ?? []) {
		transformer.pre?.(node)
		transformer.code?.(node.children[0])
		// Shiki calls the line transformer for every line: one that already carries a class and one
		// that does not.
		transformer.line?.(node.children[0])
		transformer.line?.({ properties: {} })
	}

	return node
}

const codeToHast = vi.fn(async (code: string, options: any) => hastFor(code, options))

const addScroller = () => {
	const scroller = document.createElement("div")
	scroller.setAttribute("data-virtuoso-scroller", "true")
	scroller.scrollBy = vi.fn()
	document.body.appendChild(scroller)
	return scroller
}

const flushHighlighting = async () => {
	// The highlight chain awaits the highlighter, the HAST conversion and then a state update.
	await act(async () => {
		for (let i = 0; i < 5; i++) {
			await Promise.resolve()
		}
	})
}

const renderBlock = async (ui: React.ReactElement) => {
	const result = render(ui)
	await flushHighlighting()
	return result
}

describe("CodeBlock — highlighting", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		clipboardState.showCopyFeedback = false
		document.body.innerHTML = ""
		document.body.className = ""
		codeToHast.mockImplementation(async (code: string, options: any) => hastFor(code, options))
		vi.mocked(getHighlighter).mockResolvedValue({ codeToHast } as never)
		vi.mocked(isLanguageLoaded).mockReturnValue(true)
		toJsxRuntime.mockImplementation((hast: any) => (
			<pre data-testid="highlighted" className={String(hast.children[0].properties.class ?? "")}>
				{hast.children[0].children[0].value}
			</pre>
		))
	})

	it("renders the highlighted code once Shiki answers", async () => {
		await renderBlock(<CodeBlock source="const a = 1" language="typescript" />)

		expect(screen.getByTestId("highlighted")).toHaveTextContent("const a = 1")
	})

	it("strips the wrapper padding and tags the code element with the language", async () => {
		await renderBlock(<CodeBlock source="const a = 1" language="typescript" />)

		const [, options] = codeToHast.mock.calls[0]
		const node = hastFor("x", options)
		expect(node.properties.style).toBe("padding: 0; margin: 0;")
		expect(node.children[0].properties.class).toBe("hljs language-typescript")
	})

	it("shows plain text first when the language still has to be loaded", async () => {
		vi.mocked(isLanguageLoaded).mockReturnValue(false)
		let resolveHighlighter: (value: unknown) => void = () => {}
		vi.mocked(getHighlighter).mockReturnValue(
			new Promise((resolve) => {
				resolveHighlighter = resolve
			}) as never,
		)

		render(<CodeBlock source="const a = 1" language="typescript" />)

		expect(await screen.findByText("const a = 1")).toBeInTheDocument()
		expect(screen.queryByTestId("highlighted")).not.toBeInTheDocument()

		await act(async () => {
			resolveHighlighter({ codeToHast })
			await Promise.resolve()
		})
	})

	it("picks the light Shiki theme in a light VS Code theme", async () => {
		document.body.className = "vscode-light"

		await renderBlock(<CodeBlock source="a" language="typescript" />)

		expect(codeToHast.mock.calls[0][1].theme).toBe("github-light")
	})

	it("picks the dark Shiki theme otherwise", async () => {
		await renderBlock(<CodeBlock source="a" language="typescript" />)

		expect(codeToHast.mock.calls[0][1].theme).toBe("github-dark")
	})

	it("falls back to plain text when the highlighted tree cannot be converted", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		toJsxRuntime.mockImplementation(() => {
			throw new Error("bad hast")
		})

		await renderBlock(<CodeBlock source="const a = 1" language="typescript" />)

		expect(screen.getByText("const a = 1")).toBeInTheDocument()
		expect(error).toHaveBeenCalledWith("[CodeBlock] Error converting HAST to JSX:", expect.any(Error))
		error.mockRestore()
	})

	it("falls back to plain text when highlighting fails outright", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(getHighlighter).mockRejectedValue(new Error("no highlighter"))

		await renderBlock(<CodeBlock source="const a = 1" language="typescript" />)

		expect(screen.getByText("const a = 1")).toBeInTheDocument()
		expect(error).toHaveBeenCalled()
		error.mockRestore()
	})

	it("renders an empty fallback when there is no source and no language", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(getHighlighter).mockRejectedValue(new Error("no highlighter"))

		const { container } = await renderBlock(
			<CodeBlock source={undefined} language={undefined as unknown as string} />,
		)

		expect(container.querySelector("code")).toHaveClass("hljs", "language-txt")
		error.mockRestore()
	})

	it("does not touch state after the block is unmounted", async () => {
		let resolveHighlighter: (value: unknown) => void = () => {}
		vi.mocked(getHighlighter).mockReturnValue(
			new Promise((resolve) => {
				resolveHighlighter = resolve
			}) as never,
		)

		const { unmount } = render(<CodeBlock source="const a = 1" language="typescript" />)
		unmount()

		await act(async () => {
			resolveHighlighter({ codeToHast })
			await Promise.resolve()
		})

		expect(screen.queryByTestId("highlighted")).not.toBeInTheDocument()
	})

	it("renders nothing at all for an empty source", async () => {
		const { container } = await renderBlock(<CodeBlock source="" language="typescript" />)

		expect(container).toBeEmptyDOMElement()
	})
})

const rect = (top: number, bottom: number, height = bottom - top): DOMRect =>
	({ top, bottom, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

describe("CodeBlock — copy button placement", () => {
	let scroller: HTMLElement
	const originalGetComputedStyle = window.getComputedStyle

	const elements = () => {
		const block = document.querySelector("[data-partially-visible], div") as HTMLElement
		const buttons = screen.queryAllByRole("button")
		return { block, wrapper: buttons[0]?.parentElement as HTMLElement, button: buttons[0] as HTMLElement }
	}

	beforeEach(() => {
		vi.clearAllMocks()
		clipboardState.showCopyFeedback = false
		document.body.innerHTML = ""
		document.body.className = ""
		codeToHast.mockImplementation(async (code: string, options: any) => hastFor(code, options))
		vi.mocked(getHighlighter).mockResolvedValue({ codeToHast } as never)
		vi.mocked(isLanguageLoaded).mockReturnValue(true)
		toJsxRuntime.mockImplementation((hast: any) => (
			<pre data-testid="highlighted">{hast.children[0].children[0].value}</pre>
		))
		window.getComputedStyle = vi.fn().mockImplementation((element: Element) => ({
			...originalGetComputedStyle(element),
			getPropertyValue: () => "12px",
		})) as never
		scroller = addScroller()
		scroller.getBoundingClientRect = () => rect(0, 500)
	})

	afterEach(() => {
		window.getComputedStyle = originalGetComputedStyle
	})

	it("does nothing when the chat has no scroll container", async () => {
		document.body.removeChild(scroller)
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)
		const block = container.firstChild as HTMLElement
		block.getBoundingClientRect = () => rect(100, 130)

		fireEvent.mouseOver(elements().wrapper)

		expect(block.getAttribute("data-partially-visible")).toBeNull()
	})

	it("marks a visible block and positions the buttons inside it", async () => {
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)
		const block = container.firstChild as HTMLElement
		block.getBoundingClientRect = () => rect(100, 130)
		const { wrapper } = elements()
		wrapper.getBoundingClientRect = () => rect(0, 20)

		fireEvent.mouseOver(wrapper)

		expect(block.getAttribute("data-partially-visible")).toBe("true")
		expect(block.style.getPropertyValue("--copy-button-opacity")).toBe("1")
		expect(block.style.getPropertyValue("--copy-button-top")).toBe("98px")
	})

	it("hides the buttons while the pointer is pressed, without forgetting the block is visible", async () => {
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)
		const block = container.firstChild as HTMLElement
		block.getBoundingClientRect = () => rect(100, 130)
		const pre = block.firstChild as HTMLElement

		fireEvent.mouseDown(pre)

		expect(block.getAttribute("data-partially-visible")).toBe("true")
		expect(block.style.getPropertyValue("--copy-button-opacity")).toBe("0")
		expect(block.style.getPropertyValue("--copy-button-events")).toBe("none")

		fireEvent.mouseUp(pre)

		expect(block.style.getPropertyValue("--copy-button-opacity")).toBe("1")
	})

	it("measures the button itself when the wrapper reports no height", async () => {
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)
		const block = container.firstChild as HTMLElement
		block.getBoundingClientRect = () => rect(100, 130)
		const { wrapper, button } = elements()
		wrapper.getBoundingClientRect = () => rect(0, 0, 0)
		button.getBoundingClientRect = () => rect(0, 10, 10)

		fireEvent.mouseOver(wrapper)

		// 10px button + 12px padding top and bottom = 34px, so the button sits 34+12 above the bottom.
		expect(block.style.getPropertyValue("--copy-button-top")).toBe("84px")
	})

	it("estimates a height from the font size when there is no wrapper to measure", async () => {
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)
		const block = container.firstChild as HTMLElement
		block.getBoundingClientRect = () => rect(100, 130)
		const pre = block.firstChild as HTMLElement

		// The first press starts a selection, which unmounts the button wrapper; the second one
		// therefore has nothing to measure and has to fall back to the font size.
		fireEvent.mouseDown(pre)
		fireEvent.mouseDown(pre)

		expect(block.style.getPropertyValue("--copy-button-top")).toBe("88px")
	})

	it("marks a block that scrolled out of view as not visible", async () => {
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)
		const block = container.firstChild as HTMLElement
		block.getBoundingClientRect = () => rect(-200, -100)

		fireEvent.mouseOver(elements().wrapper)

		expect(block.getAttribute("data-partially-visible")).toBe("false")
		expect(block.style.getPropertyValue("--copy-button-opacity")).toBe("0")
		expect(block.style.getPropertyValue("--copy-button-top")).toBe("")
	})

	it("repositions the buttons when the chat scrolls or the window resizes", async () => {
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)
		const block = container.firstChild as HTMLElement
		block.getBoundingClientRect = () => rect(100, 130)

		fireEvent.scroll(scroller)
		expect(block.getAttribute("data-partially-visible")).toBe("true")

		block.getBoundingClientRect = () => rect(-200, -100)
		fireEvent.resize(window)
		expect(block.getAttribute("data-partially-visible")).toBe("false")
	})
})

describe("CodeBlock — copying", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		clipboardState.showCopyFeedback = false
		document.body.innerHTML = ""
		codeToHast.mockImplementation(async (code: string, options: any) => hastFor(code, options))
		vi.mocked(getHighlighter).mockResolvedValue({ codeToHast } as never)
		vi.mocked(isLanguageLoaded).mockReturnValue(true)
		toJsxRuntime.mockImplementation((hast: any) => (
			<pre data-testid="highlighted">{hast.children[0].children[0].value}</pre>
		))
		addScroller()
	})

	const copyButton = () => screen.getAllByRole("button").at(-1)!

	it("refuses to copy a block that is not on screen", async () => {
		await renderBlock(<CodeBlock source="const a = 1" language="typescript" />)

		fireEvent.click(copyButton())

		expect(copyWithFeedback).not.toHaveBeenCalled()
	})

	it("copies the displayed source once the block is on screen", async () => {
		const { container } = await renderBlock(<CodeBlock source="const a = 1" language="typescript" />)
		;(container.firstChild as HTMLElement).setAttribute("data-partially-visible", "true")

		fireEvent.click(copyButton())

		expect(copyWithFeedback).toHaveBeenCalledWith("const a = 1", expect.anything())
	})

	it("prefers the raw source over the rendered one", async () => {
		const { container } = await renderBlock(
			<CodeBlock source="const a = 1" rawSource="const a = 1 // raw" language="typescript" />,
		)
		;(container.firstChild as HTMLElement).setAttribute("data-partially-visible", "true")

		fireEvent.click(copyButton())

		expect(copyWithFeedback).toHaveBeenCalledWith("const a = 1 // raw", expect.anything())
	})

	it("copies nothing when there is nothing to copy", async () => {
		const { container } = await renderBlock(<CodeBlock source="x" rawSource="" language="typescript" />)
		;(container.firstChild as HTMLElement).setAttribute("data-partially-visible", "true")

		fireEvent.click(copyButton())

		expect(copyWithFeedback).not.toHaveBeenCalled()
	})

	it("acknowledges a copy with a check mark", async () => {
		clipboardState.showCopyFeedback = true

		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)

		expect(container.querySelector(".lucide-check")).toBeInTheDocument()
	})
})

describe("CodeBlock — scroll chaining and collapsing", () => {
	let scroller: HTMLElement

	const setup = async (props: Record<string, unknown> = {}) => {
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" {...props} />)
		const block = container.firstChild as HTMLElement
		const pre = block.firstChild as HTMLElement
		return { container, block, pre }
	}

	const sizePre = (pre: HTMLElement, { scrollHeight = 100, clientHeight = 100, scrollTop = 0 } = {}) => {
		Object.defineProperty(pre, "scrollHeight", { value: scrollHeight, configurable: true })
		Object.defineProperty(pre, "clientHeight", { value: clientHeight, configurable: true })
		Object.defineProperty(pre, "scrollTop", { value: scrollTop, writable: true, configurable: true })
	}

	const wheel = (element: HTMLElement, init: WheelEventInit) => {
		const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init })
		element.dispatchEvent(event)
		return event
	}

	beforeEach(() => {
		vi.clearAllMocks()
		clipboardState.showCopyFeedback = false
		document.body.innerHTML = ""
		codeToHast.mockImplementation(async (code: string, options: any) => hastFor(code, options))
		vi.mocked(getHighlighter).mockResolvedValue({ codeToHast } as never)
		vi.mocked(isLanguageLoaded).mockReturnValue(true)
		toJsxRuntime.mockImplementation((hast: any) => (
			<pre data-testid="highlighted">{hast.children[0].children[0].value}</pre>
		))
		scroller = addScroller()
	})

	it("hands the scroll to the chat once the block is scrolled to its bottom", async () => {
		const { pre } = await setup()
		sizePre(pre, { scrollHeight: 300, clientHeight: 100, scrollTop: 200 })

		const event = wheel(pre, { deltaY: 40 })

		expect(event.defaultPrevented).toBe(true)
		await waitFor(() => expect(scroller.scrollBy).toHaveBeenCalled())
	})

	it("hands the scroll to the chat once the block is scrolled to its top", async () => {
		const { pre } = await setup()
		sizePre(pre, { scrollHeight: 300, clientHeight: 100, scrollTop: 0 })

		const event = wheel(pre, { deltaY: -40 })

		expect(event.defaultPrevented).toBe(true)
		await waitFor(() => expect(scroller.scrollBy).toHaveBeenCalled())
	})

	it("keeps scrolling the block itself while it still has room", async () => {
		const { pre } = await setup()
		sizePre(pre, { scrollHeight: 300, clientHeight: 100, scrollTop: 50 })

		const event = wheel(pre, { deltaY: 40 })

		expect(event.defaultPrevented).toBe(false)
		expect(scroller.scrollBy).not.toHaveBeenCalled()
	})

	it("leaves horizontal (shift) scrolling to the browser", async () => {
		const { pre } = await setup()
		sizePre(pre, { scrollHeight: 300, clientHeight: 100, scrollTop: 200 })

		const event = wheel(pre, { deltaY: 40, shiftKey: true })

		expect(event.defaultPrevented).toBe(false)
	})

	it("ignores the wheel when the block has no scrollbar of its own", async () => {
		const { pre } = await setup()
		sizePre(pre, { scrollHeight: 100, clientHeight: 100 })

		const event = wheel(pre, { deltaY: 40 })

		expect(event.defaultPrevented).toBe(false)
	})

	it("does nothing at the boundary when the chat has no scroll container", async () => {
		document.body.removeChild(scroller)
		const { pre } = await setup()
		sizePre(pre, { scrollHeight: 300, clientHeight: 100, scrollTop: 200 })

		const event = wheel(pre, { deltaY: 40 })

		expect(event.defaultPrevented).toBe(false)
	})

	it("stops the inertial scroll when it slows down", async () => {
		const { pre } = await setup()
		sizePre(pre, { scrollHeight: 300, clientHeight: 100, scrollTop: 200 })

		// 実時間の rAF に任せると、負荷の高い環境では減速しきる前にテストが終わり、
		// 「自分で止まる」ところまで到達しないことがある。フレームは手で進める。
		const frames: FrameRequestCallback[] = []
		const originalRaf = window.requestAnimationFrame
		window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
			frames.push(callback)) as typeof window.requestAnimationFrame

		try {
			wheel(pre, { deltaY: 40 })

			let advanced = 0
			while (frames.length > 0 && advanced < 500) {
				advanced++
				frames.shift()!(0)
			}

			expect(scroller.scrollBy).toHaveBeenCalled()
			// 摩擦で閾値を下回り、次のフレームを要求しなくなる = 自分で止まった。
			expect(frames).toHaveLength(0)
			expect(advanced).toBeLessThan(500)
		} finally {
			window.requestAnimationFrame = originalRaf
		}
	})

	it("hides the buttons while text is being selected", async () => {
		const { pre } = await setup()

		expect(screen.getAllByRole("button").length).toBeGreaterThan(0)

		fireEvent.mouseDown(pre)
		expect(screen.queryAllByRole("button")).toHaveLength(0)

		fireEvent.mouseUp(document)
		expect(screen.getAllByRole("button").length).toBeGreaterThan(0)
	})

	it("starts a selection from a press inside the highlighted code too", async () => {
		const { pre } = await setup()

		fireEvent.mouseDown(pre.firstChild!)

		expect(screen.queryAllByRole("button")).toHaveLength(0)
	})

	it("offers the collapse control only for blocks tall enough to need it", async () => {
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", { value: 10, configurable: true })
		await setup()

		expect(screen.getAllByRole("button")).toHaveLength(1)

		Object.defineProperty(HTMLElement.prototype, "scrollHeight", { value: 600, configurable: true })
		document.body.innerHTML = ""
		addScroller()
		await setup()

		expect(screen.getAllByRole("button")).toHaveLength(2)
	})

	it("toggles the window shade and brings the block back into view", async () => {
		vi.useFakeTimers()
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", { value: 600, configurable: true })
		const scrollIntoView = vi.fn()
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true })

		const { container } = render(<CodeBlock source="a" language="typescript" />)
		await act(async () => {
			await Promise.resolve()
		})

		const collapseButton = screen.getAllByRole("button")[0]
		expect(container.querySelector(".lucide-chevron-down")).toBeInTheDocument()

		fireEvent.click(collapseButton)
		expect(container.querySelector(".lucide-chevron-up")).toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(300)
		})
		expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" })

		act(() => {
			vi.advanceTimersByTime(100)
		})

		// A second toggle must not leave the first one's timers behind.
		fireEvent.click(screen.getAllByRole("button")[0])
		fireEvent.click(screen.getAllByRole("button")[0])
		act(() => {
			vi.advanceTimersByTime(400)
		})

		vi.useRealTimers()
	})
})

describe("CodeBlock — timers, styling and edge cases", () => {
	const originalGetComputedStyle = window.getComputedStyle

	beforeEach(() => {
		vi.clearAllMocks()
		clipboardState.showCopyFeedback = false
		document.body.innerHTML = ""
		codeToHast.mockImplementation(async (code: string, options: any) => hastFor(code, options))
		vi.mocked(getHighlighter).mockResolvedValue({ codeToHast } as never)
		vi.mocked(isLanguageLoaded).mockReturnValue(true)
		toJsxRuntime.mockImplementation((hast: any) => (
			<pre data-testid="highlighted">{hast.children[0].children[0].value}</pre>
		))
		addScroller()
	})

	afterEach(() => {
		window.getComputedStyle = originalGetComputedStyle
		vi.useRealTimers()
	})

	it("renders without word wrap when asked", async () => {
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" initialWordWrap={false} />)

		expect(container.firstChild).toBeInTheDocument()
	})

	it("accepts a custom collapsed height and extra styling", async () => {
		const { container } = await renderBlock(
			<CodeBlock
				source="a"
				language="typescript"
				collapsedHeight={120}
				preStyle={{ backgroundColor: "red" }}
				initialWindowShade
			/>,
		)

		expect(container.firstChild).toBeInTheDocument()
	})

	it("copies nothing when neither source nor raw source has content", async () => {
		const { container } = await renderBlock(<CodeBlock source={undefined} language="typescript" />)
		;(container.firstChild as HTMLElement).setAttribute("data-partially-visible", "true")

		fireEvent.click(screen.getAllByRole("button").at(-1)!)

		expect(copyWithFeedback).not.toHaveBeenCalled()
	})

	it("treats missing padding values as zero", async () => {
		window.getComputedStyle = vi.fn().mockImplementation((element: Element) => ({
			...originalGetComputedStyle(element),
			getPropertyValue: (property: string) => (property === "font-size" ? "12px" : ""),
		})) as never

		const scroller = document.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement
		scroller.getBoundingClientRect = () => rect(0, 500)
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)
		const block = container.firstChild as HTMLElement
		block.getBoundingClientRect = () => rect(100, 130)
		const wrapper = screen.getAllByRole("button")[0].parentElement as HTMLElement
		wrapper.getBoundingClientRect = () => rect(0, 0, 0)

		fireEvent.mouseOver(wrapper)

		// No padding anywhere: the button height collapses to 0 and the margin to 0.
		expect(block.style.getPropertyValue("--copy-button-top")).toBe("100px")
	})

	it("replaces the pending reposition when the plain-text fallback is followed by the real thing", async () => {
		// Only the component's own timers are frozen; React's scheduler keeps running.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		vi.mocked(isLanguageLoaded).mockReturnValue(false)

		render(<CodeBlock source="const a = 1" language="typescript" />)
		await flushHighlighting()

		// Two renders: the plain fallback, then the highlighted version. Only one reposition
		// timer may survive.
		expect(screen.getByTestId("highlighted")).toBeInTheDocument()
		expect(() =>
			act(() => {
				vi.runAllTimers()
			}),
		).not.toThrow()
	})

	it("cancels the pending reposition when it unmounts mid-update", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		vi.mocked(isLanguageLoaded).mockReturnValue(false)
		const { unmount } = render(<CodeBlock source="const a = 1" language="typescript" />)
		await flushHighlighting()

		expect(() => unmount()).not.toThrow()
		expect(() =>
			act(() => {
				vi.runAllTimers()
			}),
		).not.toThrow()
	})

	it("does not position anything when there is nothing rendered to position", async () => {
		const { container } = await renderBlock(<CodeBlock source="" language="typescript" />)

		expect(container).toBeEmptyDOMElement()
	})

	it("stops highlighting when the block is unmounted while Shiki is working", async () => {
		let resolveHast: (value: unknown) => void = () => {}
		codeToHast.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveHast = resolve
				}) as never,
		)

		const { unmount } = render(<CodeBlock source="a" language="typescript" />)
		await flushHighlighting()
		unmount()

		await act(async () => {
			resolveHast(hastFor("a", {}))
			await Promise.resolve()
		})

		expect(toJsxRuntime).not.toHaveBeenCalled()
	})

	it("cancels its pending timers when it unmounts mid-collapse", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", { value: 600, configurable: true })
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: vi.fn(), configurable: true })

		const { unmount } = render(<CodeBlock source="a" language="typescript" />)
		await flushHighlighting()

		fireEvent.click(screen.getAllByRole("button")[0])
		unmount()

		expect(() =>
			act(() => {
				vi.runAllTimers()
			}),
		).not.toThrow()
	})

	it("clears a pending follow-up when the block is collapsed again", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", { value: 600, configurable: true })
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: vi.fn(), configurable: true })

		render(<CodeBlock source="a" language="typescript" />)
		await flushHighlighting()

		fireEvent.click(screen.getAllByRole("button")[0])
		act(() => {
			// The first step has run and scheduled the second one, which is still pending.
			vi.advanceTimersByTime(260)
		})
		fireEvent.click(screen.getAllByRole("button")[0])

		expect(() =>
			act(() => {
				vi.runAllTimers()
			}),
		).not.toThrow()
	})

	it("cancels the follow-up timer when it unmounts between the two collapse steps", async () => {
		vi.useFakeTimers()
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", { value: 600, configurable: true })
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: vi.fn(), configurable: true })

		const { unmount } = render(<CodeBlock source="a" language="typescript" />)
		await act(async () => {
			await Promise.resolve()
		})

		fireEvent.click(screen.getAllByRole("button")[0])
		act(() => {
			// The second step is scheduled but has not run yet.
			vi.advanceTimersByTime(260)
		})
		unmount()

		expect(() =>
			act(() => {
				vi.runAllTimers()
			}),
		).not.toThrow()
	})

	it("stops the inertial animation when the chat container disappears mid-flight", async () => {
		const { container } = await renderBlock(<CodeBlock source="a" language="typescript" />)
		const pre = container.firstChild!.firstChild as HTMLElement
		Object.defineProperty(pre, "scrollHeight", { value: 300, configurable: true })
		Object.defineProperty(pre, "clientHeight", { value: 100, configurable: true })
		Object.defineProperty(pre, "scrollTop", { value: 200, writable: true, configurable: true })

		const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 })
		pre.dispatchEvent(event)
		document.querySelector('[data-virtuoso-scroller="true"]')!.remove()

		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(event.defaultPrevented).toBe(true)
	})
})
