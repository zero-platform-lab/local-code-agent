import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import Thumbnails from "../Thumbnails"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

describe("Thumbnails", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders one thumbnail per image with a numbered label", () => {
		render(<Thumbnails images={["data:image/png;base64,AA", "data:image/png;base64,BB"]} />)

		expect(screen.getByAltText("Thumbnail 1")).toHaveAttribute("src", "data:image/png;base64,AA")
		expect(screen.getByAltText("Thumbnail 2")).toHaveAttribute("src", "data:image/png;base64,BB")
	})

	it("renders nothing for an empty list", () => {
		render(<Thumbnails images={[]} />)

		expect(screen.queryByRole("img")).not.toBeInTheDocument()
	})

	it("asks the extension to open the image that was clicked", () => {
		render(<Thumbnails images={["a.png", "b.png"]} />)

		fireEvent.click(screen.getByAltText("Thumbnail 2"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openImage", text: "b.png" })
	})

	it("offers no delete affordance when the list is read-only", () => {
		const { container } = render(<Thumbnails images={["a.png"]} />)

		fireEvent.mouseEnter(container.querySelector("div[style*='position: relative']")!)

		expect(container.querySelector(".codicon-close")).not.toBeInTheDocument()
	})

	it("reveals the delete affordance only for the hovered thumbnail", () => {
		const { container } = render(<Thumbnails images={["a.png", "b.png"]} setImages={vi.fn()} />)
		const wrappers = container.querySelectorAll("div[style*='position: relative']")

		fireEvent.mouseEnter(wrappers[1])

		expect(container.querySelectorAll(".codicon-close")).toHaveLength(1)
		expect(wrappers[1].querySelector(".codicon-close")).toBeInTheDocument()

		fireEvent.mouseLeave(wrappers[1])

		expect(container.querySelector(".codicon-close")).not.toBeInTheDocument()
	})

	it("removes exactly the deleted image and keeps the rest in order", () => {
		let images = ["a.png", "b.png", "c.png"]
		const setImages = vi.fn((update: any) => {
			images = typeof update === "function" ? update(images) : update
		})

		const { container } = render(<Thumbnails images={images} setImages={setImages} />)
		fireEvent.mouseEnter(container.querySelectorAll("div[style*='position: relative']")[1])
		fireEvent.click(container.querySelector(".codicon-close")!.parentElement!)

		expect(images).toEqual(["a.png", "c.png"])
	})

	it("reports its height so the composer can make room for it", () => {
		const onHeightChange = vi.fn()

		render(<Thumbnails images={["a.png"]} onHeightChange={onHeightChange} />)

		expect(onHeightChange).toHaveBeenCalledWith(expect.any(Number))
	})

	it("measures the box when the browser reports no client height", () => {
		const onHeightChange = vi.fn()
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 42 } as DOMRect)

		render(<Thumbnails images={["a.png"]} onHeightChange={onHeightChange} />)

		expect(onHeightChange).toHaveBeenCalledWith(42)

		vi.restoreAllMocks()
	})

	it("prefers the reported client height when there is one", () => {
		const onHeightChange = vi.fn()
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(17)

		render(<Thumbnails images={["a.png"]} onHeightChange={onHeightChange} />)

		expect(onHeightChange).toHaveBeenCalledWith(17)

		vi.restoreAllMocks()
	})

	it("drops the hover state when the images change, so no stale delete button is left", () => {
		const { container, rerender } = render(<Thumbnails images={["a.png"]} setImages={vi.fn()} />)
		fireEvent.mouseEnter(container.querySelector("div[style*='position: relative']")!)
		expect(container.querySelector(".codicon-close")).toBeInTheDocument()

		rerender(<Thumbnails images={["a.png", "b.png"]} setImages={vi.fn()} />)

		expect(container.querySelector(".codicon-close")).not.toBeInTheDocument()
	})

	it("survives having no height listener at all", () => {
		expect(() => render(<Thumbnails images={["a.png"]} />)).not.toThrow()
	})

	it("merges caller styles into the container", () => {
		const { container } = render(<Thumbnails images={[]} style={{ marginTop: 8 }} />)

		expect((container.firstChild as HTMLElement).style.marginTop).toBe("8px")
		expect((container.firstChild as HTMLElement).style.display).toBe("flex")
	})
})
