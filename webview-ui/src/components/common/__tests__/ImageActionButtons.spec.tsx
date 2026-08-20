import { render, screen, fireEvent } from "@/utils/test-utils"

import { ImageActionButtons } from "../ImageActionButtons"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

const icons = (container: HTMLElement) =>
	Array.from(container.querySelectorAll("span.codicon")).map((span) =>
		span.className.replace("codicon codicon-", "").trim(),
	)

describe("ImageActionButtons", () => {
	const required = {
		onCopy: vi.fn(),
		onViewCode: vi.fn(),
		copyFeedback: false,
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("always offers view-code and copy", () => {
		const { container } = render(<ImageActionButtons {...required} />)

		expect(icons(container)).toEqual(["code", "copy"])
	})

	it("shows each optional action only when its handler is supplied", () => {
		const { container } = render(
			<ImageActionButtons {...required} onZoom={vi.fn()} onSave={vi.fn()} onClose={vi.fn()} />,
		)

		expect(icons(container)).toEqual(["zoom-in", "code", "copy", "save", "close"])
	})

	it("acknowledges a completed copy with a check mark", () => {
		const { container } = render(<ImageActionButtons {...required} copyFeedback />)

		expect(icons(container)).toContain("check")
		expect(icons(container)).not.toContain("copy")
	})

	it("keeps the click on the button instead of the image underneath", () => {
		const onViewCode = vi.fn()
		const { container } = render(<ImageActionButtons {...required} onViewCode={onViewCode} />)

		const viewCode = container.querySelector("span.codicon-code")!.closest("button")!
		const event = new MouseEvent("click", { bubbles: true, cancelable: true })
		const stopPropagation = vi.spyOn(event, "stopPropagation")
		fireEvent(viewCode, event)

		expect(onViewCode).toHaveBeenCalledTimes(1)
		expect(stopPropagation).toHaveBeenCalled()
	})

	it("forwards the copy click untouched", () => {
		const onCopy = vi.fn()
		const { container } = render(<ImageActionButtons {...required} onCopy={onCopy} />)

		fireEvent.click(container.querySelector("span.codicon-copy")!.closest("button")!)

		expect(onCopy).toHaveBeenCalledTimes(1)
	})

	it("switches to zoom controls when zooming is fully wired up", () => {
		const { container } = render(
			<ImageActionButtons
				{...required}
				showZoomControls
				zoomLevel={1}
				onZoomIn={vi.fn()}
				onZoomOut={vi.fn()}
				onSave={vi.fn()}
				onClose={vi.fn()}
			/>,
		)

		// Zoom mode is a different, compact toolbar: no save/close there.
		expect(icons(container)).toEqual(["zoom-out", "zoom-in", "code", "copy"])
	})

	it("treats a zoom level of 0 as a real level", () => {
		const { container } = render(
			<ImageActionButtons {...required} showZoomControls zoomLevel={0} onZoomIn={vi.fn()} onZoomOut={vi.fn()} />,
		)

		expect(icons(container)).toContain("zoom-out")
	})

	it("falls back to the plain toolbar when a zoom handler is missing", () => {
		const { container } = render(
			<ImageActionButtons {...required} showZoomControls zoomLevel={1} onZoomIn={vi.fn()} />,
		)

		expect(icons(container)).toEqual(["code", "copy"])
	})

	it("falls back to the plain toolbar when the zoom level is unknown", () => {
		const { container } = render(
			<ImageActionButtons {...required} showZoomControls onZoomIn={vi.fn()} onZoomOut={vi.fn()} />,
		)

		expect(icons(container)).toEqual(["code", "copy"])
	})

	it("keeps the click on the button in zoom mode too", () => {
		const onViewCode = vi.fn()
		const { container } = render(
			<ImageActionButtons
				{...required}
				onViewCode={onViewCode}
				showZoomControls
				zoomLevel={1}
				onZoomIn={vi.fn()}
				onZoomOut={vi.fn()}
			/>,
		)

		const viewCode = container.querySelector("span.codicon-code")!.closest("button")!
		const event = new MouseEvent("click", { bubbles: true, cancelable: true })
		const stopPropagation = vi.spyOn(event, "stopPropagation")
		fireEvent(viewCode, event)

		expect(onViewCode).toHaveBeenCalledTimes(1)
		expect(stopPropagation).toHaveBeenCalled()
	})

	it("shows the copy acknowledgement in zoom mode as well", () => {
		const { container } = render(
			<ImageActionButtons
				{...required}
				copyFeedback
				showZoomControls
				zoomLevel={1}
				onZoomIn={vi.fn()}
				onZoomOut={vi.fn()}
			/>,
		)

		expect(icons(container)).toContain("check")
	})

	it("labels every button so the toolbar is usable without sight", () => {
		render(<ImageActionButtons {...required} onZoom={vi.fn()} onSave={vi.fn()} onClose={vi.fn()} />)

		expect(screen.getAllByRole("button")).toHaveLength(5)
	})
})
