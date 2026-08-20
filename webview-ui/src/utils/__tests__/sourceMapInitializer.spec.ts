import { initializeSourceMaps, exposeSourceMapsForDebugging } from "../sourceMapInitializer"
import { enhanceErrorWithSourceMaps } from "../sourceMapUtils"

vi.mock("../sourceMapUtils", () => ({
	enhanceErrorWithSourceMaps: vi.fn(async (error: Error) => error),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const addScript = (src?: string) => {
	const script = document.createElement("script")

	if (src) {
		script.src = src
	}

	document.head.appendChild(script)
	return script
}

const preloadHrefs = () =>
	Array.from(document.head.querySelectorAll("link[rel=preload]")).map((el) => el.getAttribute("href"))

describe("initializeSourceMaps", () => {
	beforeEach(() => {
		document.head.innerHTML = ""
		vi.clearAllMocks()
		vi.spyOn(console, "debug").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ text: async () => "" })),
		)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it("does nothing outside production builds", () => {
		const addEventListener = vi.spyOn(window, "addEventListener")
		addScript("http://localhost/assets/index.js")

		initializeSourceMaps()

		expect(addEventListener).not.toHaveBeenCalled()
		expect(preloadHrefs()).toEqual([])
	})

	it("preloads every candidate source map location for each script with a src", () => {
		vi.stubEnv("NODE_ENV", "production")
		addScript("http://localhost/assets/index.js")
		addScript()

		initializeSourceMaps()

		expect(preloadHrefs()).toEqual([
			"http://localhost/assets/index.js.map",
			"http://localhost/assets/index.js?source-map=true",
			"http://localhost/assets/index.js.map",
			"http://localhost/assets/index.map.json",
			"http://localhost/assets/index.sourcemap",
		])
	})

	it("preloads the source map named by an inline sourceMappingURL comment", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ text: async () => "code();\n//# sourceMappingURL=index-abc.js.map\n" })),
		)
		addScript("http://localhost/assets/index.js")

		initializeSourceMaps()
		await flush()

		expect(preloadHrefs()).toContain("http://localhost/assets/index-abc.js.map")
	})

	it("does not preload a data: source map, which is already inline", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ text: async () => "//# sourceMappingURL=data:application/json;base64,e30=" })),
		)
		addScript("http://localhost/assets/index.js")

		initializeSourceMaps()
		await flush()

		expect(preloadHrefs().filter((href) => href?.startsWith("data:"))).toEqual([])
		expect(preloadHrefs()).toHaveLength(5)
	})

	it("adds nothing extra when the script has no sourceMappingURL comment", async () => {
		vi.stubEnv("NODE_ENV", "production")
		addScript("http://localhost/assets/index.js")

		initializeSourceMaps()
		await flush()

		expect(preloadHrefs()).toHaveLength(5)
	})

	it("survives a failed script fetch", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("blocked by CSP"))),
		)
		addScript("http://localhost/assets/index.js")

		initializeSourceMaps()
		await flush()

		expect(console.debug).toHaveBeenCalledWith("Error checking for inline sourceMappingURL:", expect.any(Error))
	})

	it("survives the DOM refusing to enumerate scripts", () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.spyOn(document, "getElementsByTagName").mockImplementation(() => {
			throw new Error("no DOM")
		})

		expect(() => initializeSourceMaps()).not.toThrow()
		expect(console.error).toHaveBeenCalledWith("Error preloading source maps:", expect.any(Error))
	})

	it("source maps uncaught errors without swallowing them", async () => {
		vi.stubEnv("NODE_ENV", "production")
		initializeSourceMaps()

		const error = new Error("boom")
		const event = new Event("error") as Event & { error?: unknown }
		event.error = error
		window.dispatchEvent(event)
		await flush()

		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledWith(error)
		expect(console.error).toHaveBeenCalledWith("Source mapped error:", error)
	})

	it("ignores error events that carry no Error", async () => {
		vi.stubEnv("NODE_ENV", "production")
		initializeSourceMaps()

		const event = new Event("error") as Event & { error?: unknown }
		event.error = "just a string"
		window.dispatchEvent(event)
		await flush()

		expect(enhanceErrorWithSourceMaps).not.toHaveBeenCalled()
	})

	it("reports a failure to source map an uncaught error", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.mocked(enhanceErrorWithSourceMaps).mockRejectedValueOnce(new Error("mapping failed"))
		initializeSourceMaps()

		const event = new Event("error") as Event & { error?: unknown }
		event.error = new Error("boom")
		window.dispatchEvent(event)
		await flush()

		expect(console.error).toHaveBeenCalledWith("Error enhancing error with source maps:", expect.any(Error))
	})

	it("source maps unhandled rejections", async () => {
		vi.stubEnv("NODE_ENV", "production")
		initializeSourceMaps()

		const reason = new Error("rejected")
		const event = new Event("unhandledrejection") as Event & { reason?: unknown }
		event.reason = reason
		window.dispatchEvent(event)
		await flush()

		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledWith(reason)
		expect(console.error).toHaveBeenCalledWith("Source mapped rejection:", reason)
	})

	it("ignores rejections that carry no Error", async () => {
		vi.stubEnv("NODE_ENV", "production")
		initializeSourceMaps()

		const event = new Event("unhandledrejection") as Event & { reason?: unknown }
		event.reason = { message: "not an Error" }
		window.dispatchEvent(event)
		await flush()

		expect(enhanceErrorWithSourceMaps).not.toHaveBeenCalled()
	})

	it("reports a failure to source map a rejection", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.mocked(enhanceErrorWithSourceMaps).mockRejectedValueOnce(new Error("mapping failed"))
		initializeSourceMaps()

		const event = new Event("unhandledrejection") as Event & { reason?: unknown }
		event.reason = new Error("rejected")
		window.dispatchEvent(event)
		await flush()

		expect(console.error).toHaveBeenCalledWith("Error enhancing rejection with source maps:", expect.any(Error))
	})
})

describe("exposeSourceMapsForDebugging", () => {
	const globals = ["__applySourceMaps", "__testSourceMaps", "__checkSourceMap"] as const

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "debug").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "log").mockImplementation(() => {})

		for (const name of globals) {
			delete (window as unknown as Record<string, unknown>)[name]
		}
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	const win = () => window as unknown as Record<string, any>

	it("exposes nothing outside production builds", () => {
		exposeSourceMapsForDebugging()

		for (const name of globals) {
			expect(win()[name]).toBeUndefined()
		}
	})

	it("exposes the debugging helpers in production builds", () => {
		vi.stubEnv("NODE_ENV", "production")

		exposeSourceMapsForDebugging()

		for (const name of globals) {
			expect(typeof win()[name]).toBe("function")
		}
	})

	it("__applySourceMaps source maps an Error and rejects anything else", async () => {
		vi.stubEnv("NODE_ENV", "production")
		exposeSourceMapsForDebugging()

		const error = new Error("boom")
		await expect(win().__applySourceMaps(error)).resolves.toBe(error)
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledWith(error)

		vi.mocked(enhanceErrorWithSourceMaps).mockClear()
		await expect(win().__applySourceMaps("not an error")).resolves.toBe("not an error")
		expect(enhanceErrorWithSourceMaps).not.toHaveBeenCalled()
		expect(console.error).toHaveBeenCalledWith("Not an Error object:", "not an error")
	})

	it("__testSourceMaps reports the enhanced stacks of a deliberately thrown error", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.mocked(enhanceErrorWithSourceMaps).mockImplementationOnce(async (error: Error) =>
			Object.assign(error, {
				sourceMappedStack: "mapped stack",
				sourceMappedComponentStack: "mapped component stack",
			}),
		)
		exposeSourceMapsForDebugging()

		win().__testSourceMaps()
		await flush()

		expect(console.log).toHaveBeenCalledWith("Original error:", expect.any(TypeError))
		expect(console.log).toHaveBeenCalledWith("Source mapped stack:", "mapped stack")
		expect(console.log).toHaveBeenCalledWith("Source mapped component stack:", "mapped component stack")
	})

	it("__testSourceMaps stays quiet about stacks the mapper did not produce", async () => {
		vi.stubEnv("NODE_ENV", "production")
		exposeSourceMapsForDebugging()

		win().__testSourceMaps()
		await flush()

		const logged = vi.mocked(console.log).mock.calls.map((call) => call[0])
		expect(logged).toContain("Enhanced error:")
		expect(logged).not.toContain("Source mapped stack:")
		expect(logged).not.toContain("Source mapped component stack:")
	})

	it("__checkSourceMap reports the original file when a map exists", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ sources: ["src/App.tsx"] }) })),
		)
		exposeSourceMapsForDebugging()

		await expect(win().__checkSourceMap("http://localhost/assets/index.js")).resolves.toBe(true)
		expect(fetch).toHaveBeenCalledWith("http://localhost/assets/index.js.map")
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("src/App.tsx"))
	})

	it("__checkSourceMap falls back to 'unknown' for a map without sources", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ sources: [] }) })),
		)
		exposeSourceMapsForDebugging()

		await expect(win().__checkSourceMap("http://localhost/assets/index.js")).resolves.toBe(true)
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("unknown"))
	})

	it("__checkSourceMap reports a missing map without throwing", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false })),
		)
		exposeSourceMapsForDebugging()

		await expect(win().__checkSourceMap("http://localhost/assets/index.js")).resolves.toBe(false)
	})

	it("__checkSourceMap reports a failed request without throwing", async () => {
		vi.stubEnv("NODE_ENV", "production")
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("offline"))),
		)
		exposeSourceMapsForDebugging()

		await expect(win().__checkSourceMap("http://localhost/assets/index.js")).resolves.toBe(false)
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Error checking source map"),
			expect.any(Error),
		)
	})

	it("reports, rather than throws, when the globals cannot be installed", () => {
		vi.stubEnv("NODE_ENV", "production")
		Object.defineProperty(window, "__applySourceMaps", { value: undefined, writable: false, configurable: true })

		expect(() => exposeSourceMapsForDebugging()).not.toThrow()
		expect(console.error).toHaveBeenCalledWith("Error exposing source maps for debugging:", expect.any(Error))
	})
})
