import path from "path"

import { sourcemapPlugin } from "../sourcemapPlugin"

const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}))

vi.mock("fs", () => ({ default: fsMock }))

const runHandler = async () => {
	const plugin = sourcemapPlugin()
	const closeBundle = plugin.closeBundle as { order: string; handler: () => Promise<void> }
	await closeBundle.handler()
	return plugin
}

const outDirFor = (mode?: string) =>
	mode === "nightly"
		? path.resolve("../apps/vscode-nightly/build/webview-ui/build")
		: path.resolve("../src/webview-ui/build")

describe("sourcemapPlugin", () => {
	const originalEnv = { ...process.env }

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		delete process.env.NODE_ENV
		delete process.env.PKG_VERSION
	})

	afterEach(() => {
		vi.restoreAllMocks()
		process.env = { ...originalEnv }
	})

	it("only runs for builds, after everything else has written its output", () => {
		const plugin = sourcemapPlugin()

		expect(plugin.name).toBe("vite-plugin-sourcemap")
		expect(plugin.apply).toBe("build")
		expect((plugin.closeBundle as { order: string }).order).toBe("post")
	})

	it("writes nothing when the build directory is missing", async () => {
		fsMock.existsSync.mockReturnValue(false)

		await runHandler()

		expect(fsMock.writeFileSync).not.toHaveBeenCalled()
		expect(fsMock.readdirSync).not.toHaveBeenCalled()
	})

	it("writes nothing when the assets directory is missing", async () => {
		const outDir = outDirFor()
		fsMock.existsSync.mockImplementation((target: string) => target === outDir)

		await runHandler()

		expect(fsMock.writeFileSync).not.toHaveBeenCalled()
		expect(fsMock.readdirSync).not.toHaveBeenCalled()
	})

	it("looks in the nightly build directory when building nightly", async () => {
		process.env.NODE_ENV = "nightly"
		fsMock.existsSync.mockReturnValue(false)

		await runHandler()

		expect(fsMock.existsSync).toHaveBeenCalledWith(outDirFor("nightly"))
	})

	it("leaves a JS file untouched when it has no source map", async () => {
		const assetsDir = path.join(outDirFor(), "assets")
		fsMock.existsSync.mockImplementation((target: string) => !String(target).endsWith(".map"))
		fsMock.readdirSync.mockReturnValue(["index.js", "styles.css"])

		await runHandler()

		const written = fsMock.writeFileSync.mock.calls.map((call) => call[0])
		expect(written).not.toContain(path.join(assetsDir, "index.js"))
		expect(fsMock.readFileSync).not.toHaveBeenCalled()
	})

	it("adds a missing source map reference and normalises the map itself", async () => {
		const assetsDir = path.join(outDirFor(), "assets")
		const jsPath = path.join(assetsDir, "index.js")

		fsMock.existsSync.mockReturnValue(true)
		fsMock.readdirSync.mockReturnValue(["index.js"])
		fsMock.readFileSync.mockImplementation((target: string) =>
			String(target).endsWith(".map")
				? JSON.stringify({ sources: ["/src/App.tsx", "src/main.tsx"], version: 3 })
				: "console.log(1)",
		)

		await runHandler()

		const jsWrite = fsMock.writeFileSync.mock.calls.find((call) => call[0] === jsPath)
		expect(jsWrite?.[1]).toBe("console.log(1)\n//# sourceMappingURL=index.js.map\n")

		const mapWrite = fsMock.writeFileSync.mock.calls.find((call) => call[0] === `${jsPath}.map`)
		const map = JSON.parse(mapWrite![1] as string)
		// Absolute source paths do not resolve inside a VS Code webview.
		expect(map.sources).toEqual(["src/App.tsx", "src/main.tsx"])
		expect(map.sourceRoot).toBe("")
	})

	it("does not add a second source map reference", async () => {
		const jsPath = path.join(outDirFor(), "assets", "index.js")

		fsMock.existsSync.mockReturnValue(true)
		fsMock.readdirSync.mockReturnValue(["index.js"])
		fsMock.readFileSync.mockImplementation((target: string) =>
			String(target).endsWith(".map")
				? JSON.stringify({ sourceRoot: "/root", version: 3 })
				: "console.log(1)\n//# sourceMappingURL=index.js.map\n",
		)

		await runHandler()

		expect(fsMock.writeFileSync.mock.calls.some((call) => call[0] === jsPath)).toBe(false)
	})

	it("keeps a source map that already declares a sourceRoot", async () => {
		const mapPath = path.join(outDirFor(), "assets", "index.js.map")

		fsMock.existsSync.mockReturnValue(true)
		fsMock.readdirSync.mockReturnValue(["index.js"])
		fsMock.readFileSync.mockImplementation((target: string) =>
			String(target).endsWith(".map")
				? JSON.stringify({ sourceRoot: "/root", version: 3 })
				: "console.log(1)\n//# sourceMappingURL=index.js.map\n",
		)

		await runHandler()

		const mapWrite = fsMock.writeFileSync.mock.calls.find((call) => call[0] === mapPath)
		expect(JSON.parse(mapWrite![1] as string).sourceRoot).toBe("/root")
	})

	it("keeps going when a source map cannot be parsed", async () => {
		fsMock.existsSync.mockReturnValue(true)
		fsMock.readdirSync.mockReturnValue(["index.js"])
		fsMock.readFileSync.mockImplementation((target: string) =>
			String(target).endsWith(".map") ? "not json" : "console.log(1)\n//# sourceMappingURL=index.js.map\n",
		)

		await expect(runHandler()).resolves.toBeDefined()

		expect(console.error).toHaveBeenCalled()
		// The manifest is still written, so a broken map does not abort the build step.
		expect(
			fsMock.writeFileSync.mock.calls.some((call) =>
				String(call[0]).endsWith(path.join("build", "sourcemap-manifest.json")),
			),
		).toBe(true)
	})

	it("records the package version in the manifest, falling back to 'unknown'", async () => {
		fsMock.existsSync.mockReturnValue(true)
		fsMock.readdirSync.mockReturnValue([])

		await runHandler()
		const fallback = JSON.parse(fsMock.writeFileSync.mock.calls.at(-1)![1] as string)
		expect(fallback).toMatchObject({ enabled: true, version: "unknown" })

		process.env.PKG_VERSION = "1.2.3"
		await runHandler()
		const stamped = JSON.parse(fsMock.writeFileSync.mock.calls.at(-1)![1] as string)
		expect(stamped).toMatchObject({ version: "1.2.3" })
		expect(Date.parse(stamped.buildTime)).not.toBeNaN()
	})
})
