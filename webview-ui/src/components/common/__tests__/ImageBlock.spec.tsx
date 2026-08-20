import { render, screen } from "@/utils/test-utils"

import ImageBlock from "../ImageBlock"

vi.mock("../ImageViewer", () => ({
	ImageViewer: (props: Record<string, unknown>) => (
		<div data-testid="image-viewer" data-props={JSON.stringify(props)} />
	),
}))

const viewerProps = () => JSON.parse(screen.getByTestId("image-viewer").getAttribute("data-props")!)

describe("ImageBlock", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the webview URI form with its path", () => {
		render(<ImageBlock imageUri="vscode-webview://x/a.png" imagePath="/tmp/a.png" />)

		expect(viewerProps()).toMatchObject({
			imageUri: "vscode-webview://x/a.png",
			imagePath: "/tmp/a.png",
			showControls: true,
		})
	})

	it("prefers the webview URI over the legacy data form", () => {
		render(
			<ImageBlock
				imageUri="vscode-webview://x/a.png"
				imagePath="/tmp/a.png"
				imageData="data:image/png;base64,AA"
				path="/legacy.png"
			/>,
		)

		expect(viewerProps()).toMatchObject({ imageUri: "vscode-webview://x/a.png", imagePath: "/tmp/a.png" })
	})

	it("falls back to the legacy data form used by diagrams", () => {
		render(<ImageBlock imageData="data:image/png;base64,AA" path="/legacy.png" />)

		expect(viewerProps()).toMatchObject({ imageUri: "data:image/png;base64,AA", imagePath: "/legacy.png" })
	})

	it("renders nothing rather than a broken image when there is no source", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})

		const { container } = render(<ImageBlock />)

		expect(container).toBeEmptyDOMElement()
		expect(error).toHaveBeenCalledWith("ImageBlock: No valid image data provided")

		error.mockRestore()
	})

	it("still renders when only the URI is known", () => {
		render(<ImageBlock imageUri="vscode-webview://x/a.png" />)

		expect(viewerProps().imagePath).toBeUndefined()
	})
})
