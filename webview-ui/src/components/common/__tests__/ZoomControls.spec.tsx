// npx vitest run src/components/common/__tests__/ZoomControls.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"
import { ZoomControls } from "../ZoomControls"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("ZoomControls", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("displays zoom level as percentage", () => {
		render(<ZoomControls zoomLevel={1.5} />)
		expect(screen.getByText("150%")).toBeInTheDocument()
	})

	it("rounds zoom level percentage", () => {
		render(<ZoomControls zoomLevel={0.333} />)
		expect(screen.getByText("33%")).toBeInTheDocument()
	})

	it("renders zoom-in and zoom-out buttons", () => {
		const { container } = render(<ZoomControls zoomLevel={1} />)
		expect(container.querySelector(".codicon-zoom-in")).toBeInTheDocument()
		expect(container.querySelector(".codicon-zoom-out")).toBeInTheDocument()
	})

	describe("discrete zoom mode (default)", () => {
		it("calls onZoomIn when zoom-in button is clicked", () => {
			const onZoomIn = vi.fn()
			const { container } = render(<ZoomControls zoomLevel={1} onZoomIn={onZoomIn} />)

			const zoomInBtn = container.querySelector(".codicon-zoom-in")!.closest("button")!
			fireEvent.click(zoomInBtn)
			expect(onZoomIn).toHaveBeenCalledTimes(1)
		})

		it("calls onZoomOut when zoom-out button is clicked", () => {
			const onZoomOut = vi.fn()
			const { container } = render(<ZoomControls zoomLevel={1} onZoomOut={onZoomOut} />)

			const zoomOutBtn = container.querySelector(".codicon-zoom-out")!.closest("button")!
			fireEvent.click(zoomOutBtn)
			expect(onZoomOut).toHaveBeenCalledTimes(1)
		})

		it("falls back to adjustZoom with default step when onZoomIn is not provided", () => {
			const adjustZoom = vi.fn()
			const { container } = render(<ZoomControls zoomLevel={1} adjustZoom={adjustZoom} />)

			const zoomInBtn = container.querySelector(".codicon-zoom-in")!.closest("button")!
			fireEvent.click(zoomInBtn)
			expect(adjustZoom).toHaveBeenCalledWith(0.1) // default zoomInStep
		})

		it("falls back to adjustZoom with default step when onZoomOut is not provided", () => {
			const adjustZoom = vi.fn()
			const { container } = render(<ZoomControls zoomLevel={1} adjustZoom={adjustZoom} />)

			const zoomOutBtn = container.querySelector(".codicon-zoom-out")!.closest("button")!
			fireEvent.click(zoomOutBtn)
			expect(adjustZoom).toHaveBeenCalledWith(-0.1) // default zoomOutStep
		})
	})

	describe("continuous zoom mode", () => {
		it("starts continuous zoom on mouseDown and calls adjustZoom immediately", () => {
			const adjustZoom = vi.fn()
			const { container } = render(
				<ZoomControls
					zoomLevel={1}
					useContinuousZoom={true}
					adjustZoom={adjustZoom}
					zoomInStep={0.2}
					zoomOutStep={-0.2}
				/>,
			)

			const zoomInBtn = container.querySelector(".codicon-zoom-in")!.closest("button")!
			fireEvent.mouseDown(zoomInBtn)

			// First immediate call
			expect(adjustZoom).toHaveBeenCalledWith(0.2)
			expect(adjustZoom).toHaveBeenCalledTimes(1)

			// After interval (150ms)
			act(() => {
				vi.advanceTimersByTime(150)
			})
			expect(adjustZoom).toHaveBeenCalledTimes(2)
		})

		it("stops continuous zoom on mouseUp", () => {
			const adjustZoom = vi.fn()
			const { container } = render(
				<ZoomControls zoomLevel={1} useContinuousZoom={true} adjustZoom={adjustZoom} zoomInStep={0.2} />,
			)

			const zoomInBtn = container.querySelector(".codicon-zoom-in")!.closest("button")!
			fireEvent.mouseDown(zoomInBtn)
			expect(adjustZoom).toHaveBeenCalledTimes(1)

			fireEvent.mouseUp(zoomInBtn)

			// Should not continue zooming
			act(() => {
				vi.advanceTimersByTime(300)
			})
			expect(adjustZoom).toHaveBeenCalledTimes(1)
		})

		it("stops continuous zoom on mouseLeave", () => {
			const adjustZoom = vi.fn()
			const { container } = render(
				<ZoomControls zoomLevel={1} useContinuousZoom={true} adjustZoom={adjustZoom} zoomOutStep={-0.2} />,
			)

			const zoomOutBtn = container.querySelector(".codicon-zoom-out")!.closest("button")!
			fireEvent.mouseDown(zoomOutBtn)
			expect(adjustZoom).toHaveBeenCalledTimes(1)

			fireEvent.mouseLeave(zoomOutBtn)

			act(() => {
				vi.advanceTimersByTime(300)
			})
			expect(adjustZoom).toHaveBeenCalledTimes(1)
		})

		it("does not start continuous zoom if useContinuousZoom is false", () => {
			const adjustZoom = vi.fn()
			const { container } = render(
				<ZoomControls zoomLevel={1} useContinuousZoom={false} adjustZoom={adjustZoom} />,
			)

			const zoomInBtn = container.querySelector(".codicon-zoom-in")!.closest("button")!
			fireEvent.mouseDown(zoomInBtn)

			// adjustZoom should not be called via mouseDown in non-continuous mode
			expect(adjustZoom).not.toHaveBeenCalled()
		})

		it("does not start continuous zoom when adjustZoom is not provided", () => {
			const { container } = render(<ZoomControls zoomLevel={1} useContinuousZoom={true} />)

			const zoomInBtn = container.querySelector(".codicon-zoom-in")!.closest("button")!
			// Should not throw
			fireEvent.mouseDown(zoomInBtn)
		})

		it("clears existing interval before starting a new one", () => {
			const adjustZoom = vi.fn()
			const { container } = render(
				<ZoomControls
					zoomLevel={1}
					useContinuousZoom={true}
					adjustZoom={adjustZoom}
					zoomInStep={0.2}
					zoomOutStep={-0.2}
				/>,
			)

			const zoomInBtn = container.querySelector(".codicon-zoom-in")!.closest("button")!
			const zoomOutBtn = container.querySelector(".codicon-zoom-out")!.closest("button")!

			// Start zooming in
			fireEvent.mouseDown(zoomInBtn)
			expect(adjustZoom).toHaveBeenCalledWith(0.2)

			// Switch to zooming out without releasing
			fireEvent.mouseDown(zoomOutBtn)
			expect(adjustZoom).toHaveBeenCalledWith(-0.2)

			// Only one interval should be active
			adjustZoom.mockClear()
			act(() => {
				vi.advanceTimersByTime(150)
			})
			expect(adjustZoom).toHaveBeenCalledTimes(1)
			expect(adjustZoom).toHaveBeenCalledWith(-0.2)
		})
	})

	it("cleans up interval on unmount", () => {
		const adjustZoom = vi.fn()
		const { container, unmount } = render(
			<ZoomControls zoomLevel={1} useContinuousZoom={true} adjustZoom={adjustZoom} zoomInStep={0.2} />,
		)

		const zoomInBtn = container.querySelector(".codicon-zoom-in")!.closest("button")!
		fireEvent.mouseDown(zoomInBtn)

		unmount()

		// Should not continue calling adjustZoom after unmount
		adjustZoom.mockClear()
		act(() => {
			vi.advanceTimersByTime(500)
		})
		expect(adjustZoom).not.toHaveBeenCalled()
	})

	// Mutation: zoom level display reflects actual number
	it("100% for zoom 1.0, 200% for zoom 2.0", () => {
		const { rerender } = render(<ZoomControls zoomLevel={1} />)
		expect(screen.getByText("100%")).toBeInTheDocument()

		rerender(<ZoomControls zoomLevel={2} />)
		expect(screen.getByText("200%")).toBeInTheDocument()
	})

	// Mutation: custom steps are forwarded correctly
	it("uses custom zoomInStep and zoomOutStep", () => {
		const adjustZoom = vi.fn()
		const { container } = render(
			<ZoomControls zoomLevel={1} adjustZoom={adjustZoom} zoomInStep={0.5} zoomOutStep={-0.5} />,
		)

		const zoomInBtn = container.querySelector(".codicon-zoom-in")!.closest("button")!
		const zoomOutBtn = container.querySelector(".codicon-zoom-out")!.closest("button")!

		fireEvent.click(zoomInBtn)
		expect(adjustZoom).toHaveBeenCalledWith(0.5)

		fireEvent.click(zoomOutBtn)
		expect(adjustZoom).toHaveBeenCalledWith(-0.5)
	})
})
