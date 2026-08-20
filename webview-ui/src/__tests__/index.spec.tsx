import { StrictMode } from "react"

import { getHighlighter } from "../utils/highlighter"

const render = vi.hoisted(() => vi.fn())
const createRoot = vi.hoisted(() => vi.fn(() => ({ render })))

vi.mock("react-dom/client", () => ({ createRoot }))
vi.mock("../App", () => ({
	default: function App() {
		return null
	},
}))
vi.mock("../utils/highlighter", () => ({ getHighlighter: vi.fn(async () => ({})) }))

const bootstrap = async () => {
	vi.resetModules()
	await import("../index")
}

describe("webview entry point", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "error").mockImplementation(() => {})
		document.body.innerHTML = '<div id="root"></div>'
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("mounts the app into the root element in StrictMode", async () => {
		await bootstrap()

		expect(createRoot).toHaveBeenCalledWith(document.getElementById("root"))

		const tree = render.mock.calls[0][0]
		expect(tree.type).toBe(StrictMode)
		expect(typeof tree.props.children.type).toBe("function")
		expect(tree.props.children.type.name).toBe("App")
	})

	it("warms up the syntax highlighter while the app boots", async () => {
		await bootstrap()

		expect(getHighlighter).toHaveBeenCalled()
	})

	it("still mounts the app when the highlighter fails to initialise", async () => {
		vi.mocked(getHighlighter).mockRejectedValueOnce(new Error("wasm blocked"))

		await bootstrap()
		await Promise.resolve()

		expect(render).toHaveBeenCalled()
		expect(console.error).toHaveBeenCalledWith("Failed to initialize Shiki highlighter:", expect.any(Error))
	})
})
