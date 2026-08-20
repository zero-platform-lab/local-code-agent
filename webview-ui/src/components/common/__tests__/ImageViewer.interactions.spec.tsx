import { render, screen, fireEvent, act, within } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import { ImageViewer } from "../ImageViewer"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const copyWithFeedback = vi.hoisted(() => vi.fn(async () => true))

vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ copyWithFeedback, showCopyFeedback: false }),
}))

const iconButton = (icon: string) => document.querySelector(`span.codicon-${icon}`)!.closest("button")!
const icons = () => Array.from(document.querySelectorAll("span.codicon")).map((s) => s.className)

const hoverImage = (container: HTMLElement) => fireEvent.mouseEnter(container.firstChild as HTMLElement)

// The modal shows the zoom level twice: a badge over the image and the ZoomControls readout.
const zoomBadgeElement = () => document.querySelector(".pointer-events-none") as HTMLElement
const zoomBadge = () => zoomBadgeElement().textContent
const stage = () => screen.getAllByRole("img")[1].parentElement!
const wheelSurface = () => stage().parentElement!
const modalFooter = () => document.querySelector("div.absolute.bottom-0")!

// jsdom's MouseEvent constructor drops movementX/movementY, so they are attached by hand.
const dragBy = (element: Element, movementX: number, movementY: number) => {
	const event = new MouseEvent("mousemove", { bubbles: true })
	Object.defineProperty(event, "movementX", { value: movementX })
	Object.defineProperty(event, "movementY", { value: movementY })
	fireEvent(element, event)
}

describe("ImageViewer — controls", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		copyWithFeedback.mockResolvedValue(true)
	})

	it("reveals the controls only while the pointer is over the image", () => {
		const { container } = render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)

		expect(icons()).toHaveLength(0)

		hoverImage(container)
		expect(icons().length).toBeGreaterThan(0)

		fireEvent.mouseLeave(container.firstChild as HTMLElement)
		expect(icons()).toHaveLength(0)
	})

	it("hides the controls entirely when they are switched off", () => {
		const { container } = render(<ImageViewer imageUri="img.png" showControls={false} />)

		hoverImage(container)

		expect(icons()).toHaveLength(0)
	})

	it("copies the file path and acknowledges it for a while", async () => {
		vi.useFakeTimers()
		const { container } = render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)
		hoverImage(container)

		await act(async () => {
			fireEvent.click(iconButton("copy"))
		})

		expect(copyWithFeedback).toHaveBeenCalledWith("/w/p/a.png", expect.anything())
		expect(document.querySelector("span.codicon-check")).toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(2000)
		})

		expect(document.querySelector("span.codicon-check")).not.toBeInTheDocument()
		vi.useRealTimers()
	})

	it("copies nothing when there is no file path", async () => {
		const { container } = render(<ImageViewer imageUri="data:image/png;base64,AA" />)
		hoverImage(container)

		await act(async () => {
			fireEvent.click(iconButton("copy"))
		})

		expect(copyWithFeedback).not.toHaveBeenCalled()
	})

	it("reports a failed copy instead of throwing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		copyWithFeedback.mockRejectedValueOnce(new Error("clipboard blocked"))
		const { container } = render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)
		hoverImage(container)

		await act(async () => {
			fireEvent.click(iconButton("copy"))
		})

		expect(error).toHaveBeenCalledWith("Error copying:", "clipboard blocked")
		expect(document.querySelector("span.codicon-check")).not.toBeInTheDocument()
		error.mockRestore()
	})

	it("reports a non-Error copy failure too", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		copyWithFeedback.mockRejectedValueOnce("clipboard is gone")
		const { container } = render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)
		hoverImage(container)

		await act(async () => {
			fireEvent.click(iconButton("copy"))
		})

		expect(error).toHaveBeenCalledWith("Error copying:", "clipboard is gone")
		error.mockRestore()
	})

	it("asks the extension to save the image it is showing", () => {
		const { container } = render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)
		hoverImage(container)

		fireEvent.click(iconButton("save"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "saveImage", dataUri: "img.png" })
	})

	it("opens the file in the editor when the image itself is clicked", () => {
		render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)

		fireEvent.click(screen.getByRole("img"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openImage", text: "/w/p/a.png" })
	})

	it("falls back to the URI when there is no file path", () => {
		render(<ImageViewer imageUri="data:image/png;base64,AA" />)

		fireEvent.click(screen.getByRole("img"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openImage", text: "data:image/png;base64,AA" })
	})

	it("shows a placeholder instead of a broken image when loading fails", () => {
		render(<ImageViewer imageUri="img.png" />)

		fireEvent.error(screen.getByRole("img"))

		expect(screen.getByText(/Failed to load image/)).toBeInTheDocument()
		expect(screen.queryByRole("img")).not.toBeInTheDocument()
	})

	it("keeps showing the image when it loads successfully", () => {
		render(<ImageViewer imageUri="img.png" />)

		fireEvent.load(screen.getByRole("img"))

		expect(screen.getByRole("img")).toBeInTheDocument()
		expect(screen.queryByText(/Failed to load image/)).not.toBeInTheDocument()
	})
})

describe("ImageViewer — displayed path", () => {
	it.each([
		["./already/relative.png", "./already/relative.png"],
		["/workspace/src/a.png", "./src/a.png"],
		["a.png", "a.png"],
		["dir/", "dir/"],
	])("shows %s as %s", (imagePath, expected) => {
		render(<ImageViewer imageUri="img.png" imagePath={imagePath} />)

		expect(screen.getByText(expected)).toBeInTheDocument()
	})

	it("shows no path line when there is no path", () => {
		const { container } = render(<ImageViewer imageUri="img.png" />)

		expect(container.querySelector(".text-vscode-descriptionForeground")).not.toBeInTheDocument()
	})
})

describe("ImageViewer — zoom modal", () => {
	const openModal = () => {
		const { container } = render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)
		hoverImage(container)
		fireEvent.click(iconButton("zoom-in"))
		return container
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("opens at 100% with no offset", () => {
		openModal()

		expect(zoomBadge()).toBe("100%")
		expect(stage().style.transform).toBe("scale(1) translate(0px, 0px)")
	})

	it("zooms in and out with the wheel, and clamps at the limits", () => {
		openModal()

		fireEvent.wheel(wheelSurface(), { deltaY: -1 })
		expect(zoomBadge()).toBe("120%")

		fireEvent.wheel(wheelSurface(), { deltaY: 1 })
		expect(zoomBadge()).toBe("100%")

		for (let i = 0; i < 5; i++) {
			fireEvent.wheel(wheelSurface(), { deltaY: 1 })
		}
		// MIN_ZOOM is 50%.
		expect(zoomBadge()).toBe("50%")
	})

	// ホイール 1 回で +0.2、上限 20（2000%）なので 96 回で到達する。
	// 上限を越えて回しても止まることを見たいので、少し多めに回す。
	// 200 回まで回すと jsdom の再描画だけで既定の 5 秒を超えることがあり、
	// 負荷の高い環境でのみ落ちていた。
	it("clamps zooming in at the maximum", () => {
		openModal()

		for (let i = 0; i < 105; i++) {
			fireEvent.wheel(wheelSurface(), { deltaY: -1 })
		}

		expect(zoomBadge()).toBe("2000%")
	}, 15_000)

	it("pans the image only while the pointer is held down", () => {
		openModal()

		dragBy(stage(), 10, 10)
		expect(stage().style.transform).toContain("translate(0px, 0px)")

		fireEvent.mouseDown(stage())
		expect(stage().style.cursor).toBe("grabbing")

		dragBy(stage(), 10, 20)
		expect(stage().style.transform).toContain("translate(10px, 20px)")

		fireEvent.mouseUp(stage())
		expect(stage().style.cursor).toBe("grab")

		dragBy(stage(), 5, 5)
		expect(stage().style.transform).toContain("translate(10px, 20px)")
	})

	it("stops panning when the pointer leaves the image", () => {
		openModal()

		fireEvent.mouseDown(stage())
		fireEvent.mouseLeave(stage())

		expect(stage().style.cursor).toBe("grab")
	})

	it("scales panning by the zoom level so dragging feels the same at any zoom", () => {
		openModal()

		fireEvent.wheel(wheelSurface(), { deltaY: -1 })
		fireEvent.mouseDown(stage())
		dragBy(stage(), 12, 0)

		expect(stage().style.transform).toContain("translate(10px, 0px)")
	})

	it("zooms with the toolbar buttons too", () => {
		openModal()

		fireEvent.mouseDown(
			within(modalFooter() as HTMLElement)
				.getAllByRole("button")
				.find((button) => button.querySelector(".codicon-zoom-in"))!,
		)

		expect(zoomBadge()).toBe("120%")
	})

	it("closes from the close button", () => {
		openModal()

		fireEvent.click(iconButton("close"))

		expect(document.querySelector(".pointer-events-none")).not.toBeInTheDocument()
	})

	it("offers copy in the modal only when there is a path to copy", () => {
		const { container } = render(<ImageViewer imageUri="img.png" />)
		hoverImage(container)
		fireEvent.click(iconButton("zoom-in"))

		expect(modalFooter().querySelector(".codicon-copy")).not.toBeInTheDocument()
		expect(modalFooter().querySelector(".codicon-save")).toBeInTheDocument()
	})
	it("reports a failed save instead of throwing", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(vscode.postMessage).mockImplementationOnce(() => {
			throw new Error("host gone")
		})
		const { container } = render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)
		hoverImage(container)

		expect(() => fireEvent.click(iconButton("save"))).not.toThrow()
		expect(error).toHaveBeenCalledWith("Error saving image:", expect.any(Error))
		error.mockRestore()
	})

	it("does nothing when the view-code button is pressed, since images have no code", () => {
		const { container } = render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)
		hoverImage(container)

		fireEvent.click(iconButton("code"))

		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})

describe("ImageViewer — modal chrome", () => {
	const openModal = () => {
		const { container } = render(<ImageViewer imageUri="img.png" imagePath="/w/p/a.png" />)
		hoverImage(container)
		fireEvent.click(iconButton("zoom-in"))
		return container
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("keeps the view tab selected when it is clicked again", () => {
		openModal()

		fireEvent.click(screen.getByText("common:image.tabs.view"))

		expect(zoomBadge()).toBe("100%")
	})

	it("closes when the backdrop is clicked", () => {
		openModal()

		fireEvent.click(document.querySelector(".fixed.inset-0")!)

		expect(document.querySelector(".pointer-events-none")).not.toBeInTheDocument()
	})

	it("stays open when the dialog body is clicked", () => {
		openModal()

		fireEvent.click(zoomBadgeElement())

		expect(document.querySelector(".pointer-events-none")).toBeInTheDocument()
	})
})
