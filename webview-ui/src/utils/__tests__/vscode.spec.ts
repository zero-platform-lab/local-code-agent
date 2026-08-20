// The wrapper is a module-level singleton created at import time, so each scenario has to
// reset the module registry and re-import it with the desired global in place.
const importVscode = async () => (await import("../vscode")).vscode

describe("VSCodeAPIWrapper — inside the VS Code webview", () => {
	const api = {
		postMessage: vi.fn(),
		getState: vi.fn(),
		setState: vi.fn((state: unknown) => state),
	}

	beforeEach(async () => {
		vi.resetModules()
		api.postMessage.mockClear()
		api.getState.mockClear()
		api.setState.mockClear()
		vi.stubGlobal("acquireVsCodeApi", () => api)
		localStorage.clear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("hands messages to the host instead of dropping them", async () => {
		const vscode = await importVscode()
		vscode.postMessage({ type: "webviewDidLaunch" })

		expect(api.postMessage).toHaveBeenCalledWith({ type: "webviewDidLaunch" })
	})

	it("reads state from the host, not from local storage", async () => {
		localStorage.setItem("vscodeState", JSON.stringify({ from: "localStorage" }))
		api.getState.mockReturnValue({ from: "host" })

		const vscode = await importVscode()

		expect(vscode.getState()).toEqual({ from: "host" })
	})

	it("writes state to the host and returns it unchanged", async () => {
		const vscode = await importVscode()
		const state = { taskId: "1" }

		expect(vscode.setState(state)).toBe(state)
		expect(api.setState).toHaveBeenCalledWith(state)
		expect(localStorage.getItem("vscodeState")).toBeNull()
	})

	it("acquires the host API exactly once for the whole module", async () => {
		const acquire = vi.fn(() => api)
		vi.stubGlobal("acquireVsCodeApi", acquire)

		const vscode = await importVscode()
		vscode.postMessage({ type: "webviewDidLaunch" })
		vscode.getState()

		expect(acquire).toHaveBeenCalledTimes(1)
	})
})

describe("VSCodeAPIWrapper — running in a plain browser", () => {
	beforeEach(async () => {
		vi.resetModules()
		vi.stubGlobal("acquireVsCodeApi", undefined)
		localStorage.clear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it("logs messages instead of throwing when there is no host", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const vscode = await importVscode()

		expect(() => vscode.postMessage({ type: "webviewDidLaunch" })).not.toThrow()
		expect(log).toHaveBeenCalledWith({ type: "webviewDidLaunch" })
	})

	it("round-trips state through local storage", async () => {
		const vscode = await importVscode()
		const state = { taskId: "1" }

		expect(vscode.setState(state)).toBe(state)
		expect(JSON.parse(localStorage.getItem("vscodeState")!)).toEqual(state)
		expect(vscode.getState()).toEqual(state)
	})

	it("reports undefined when no state has been stored yet", async () => {
		const vscode = await importVscode()

		expect(vscode.getState()).toBeUndefined()
	})
})
