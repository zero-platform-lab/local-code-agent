// These cases pin what happens when StackTrace.js cannot resolve a frame: the raw stack must
// always survive, because an unreadable stack is still better than none.
import * as StackTrace from "stacktrace-js"

import {
	applySourceMapsToStack,
	applySourceMapsToComponentStack,
	enhanceErrorWithSourceMaps,
	parseStackTrace,
} from "../sourceMapUtils"

vi.mock("stacktrace-js", () => ({ fromError: vi.fn() }))

const fromError = vi.mocked(StackTrace.fromError)

beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(console, "debug").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("applySourceMapsToStack", () => {
	it("fills in placeholders for frames the mapper could not describe", async () => {
		fromError.mockResolvedValue([{} as StackTrace.StackFrame])

		expect(await applySourceMapsToStack("Error: boom\n    at x")).toBe(
			"Error: boom\n    at <anonymous> (unknown:0:0)",
		)
	})

	it("keeps the resolved frame details when they are present", async () => {
		fromError.mockResolvedValue([
			{
				functionName: "render",
				fileName: "src/App.tsx",
				lineNumber: 12,
				columnNumber: 3,
			} as StackTrace.StackFrame,
		])

		expect(await applySourceMapsToStack("Error: boom\n    at x")).toBe(
			"Error: boom\n    at render (src/App.tsx:12:3)",
		)
	})

	it("returns the original stack when the mapper fails", async () => {
		fromError.mockRejectedValue(new Error("no source maps"))

		const stack = "Error: boom\n    at x"
		expect(await applySourceMapsToStack(stack)).toBe(stack)
		expect(console.error).toHaveBeenCalled()
	})

	it("returns an empty stack untouched", async () => {
		expect(await applySourceMapsToStack("")).toBe("")
		expect(fromError).not.toHaveBeenCalled()
	})
})

describe("applySourceMapsToComponentStack", () => {
	it("returns an empty component stack untouched", async () => {
		expect(await applySourceMapsToComponentStack("")).toBe("")
		expect(fromError).not.toHaveBeenCalled()
	})

	it("leaves blank and unparseable lines exactly as they are", async () => {
		const stack = "\n    some free-form text"

		expect(await applySourceMapsToComponentStack(stack)).toBe(stack)
		expect(fromError).not.toHaveBeenCalled()
	})

	it("rewrites a resolved component line", async () => {
		fromError.mockResolvedValue([
			{ fileName: "src/App.tsx", lineNumber: 5, columnNumber: 9 } as StackTrace.StackFrame,
		])

		expect(await applySourceMapsToComponentStack("at App (bundle.js:1:2)")).toBe("at App (src/App.tsx:5:9)")
	})

	it("keeps the original location parts the mapper left out", async () => {
		fromError.mockResolvedValue([{} as StackTrace.StackFrame])

		expect(await applySourceMapsToComponentStack("at App (bundle.js:1:2)")).toBe("at App (bundle.js:1:2)")
	})

	it("keeps the line when the mapper returns no frames", async () => {
		fromError.mockResolvedValue([])

		expect(await applySourceMapsToComponentStack("at App (bundle.js:1:2)")).toBe("at App (bundle.js:1:2)")
	})

	it("keeps the line when the mapper throws for it", async () => {
		fromError.mockRejectedValue(new Error("no source maps"))

		expect(await applySourceMapsToComponentStack("at App (bundle.js:1:2)")).toBe("at App (bundle.js:1:2)")
	})

	it("returns the input unchanged when it is not a string at all", async () => {
		const notAStack = 42 as unknown as string

		expect(await applySourceMapsToComponentStack(notAStack)).toBe(notAStack)
		expect(console.error).toHaveBeenCalled()
	})
})

describe("enhanceErrorWithSourceMaps", () => {
	it("returns an error that has no stack unchanged", async () => {
		const error = new Error("boom")
		error.stack = undefined

		expect(await enhanceErrorWithSourceMaps(error)).toBe(error)
		expect(fromError).not.toHaveBeenCalled()
	})

	it("attaches both mapped stacks when a component stack is supplied", async () => {
		fromError.mockResolvedValue([
			{
				functionName: "render",
				fileName: "src/App.tsx",
				lineNumber: 5,
				columnNumber: 9,
			} as StackTrace.StackFrame,
		])

		const error = new Error("boom")
		error.stack = "Error: boom\n    at x"

		const enhanced = await enhanceErrorWithSourceMaps(error, "at App (bundle.js:1:2)")

		expect(enhanced.sourceMappedStack).toBe("Error: boom\n    at render (src/App.tsx:5:9)")
		expect(enhanced.sourceMappedComponentStack).toBe("at App (src/App.tsx:5:9)")
	})

	it("leaves the component stack off when none was supplied", async () => {
		fromError.mockResolvedValue([])

		const error = new Error("boom")
		error.stack = "Error: boom\n    at x"

		const enhanced = await enhanceErrorWithSourceMaps(error)

		expect(enhanced.sourceMappedStack).toBeDefined()
		expect("sourceMappedComponentStack" in enhanced).toBe(false)
	})

	it("returns the original error when it cannot be annotated", async () => {
		fromError.mockResolvedValue([])

		const error = new Error("boom")
		error.stack = "Error: boom\n    at x"
		Object.freeze(error)

		expect(await enhanceErrorWithSourceMaps(error)).toBe(error)
		expect(console.error).toHaveBeenCalled()
	})
})

describe("parseStackTrace", () => {
	it("labels frames without a function name", async () => {
		fromError.mockResolvedValue([
			{ fileName: "src/App.tsx", lineNumber: 5, columnNumber: 9 } as StackTrace.StackFrame,
		])

		const [frame] = await parseStackTrace("Error: boom\n    at x")

		expect(frame.functionName).toBe("<anonymous>")
		expect(frame.source).toBe("at <anonymous> (src/App.tsx:5:9)")
	})

	it("returns an empty list when the mapper fails", async () => {
		fromError.mockRejectedValue(new Error("no source maps"))

		expect(await parseStackTrace("Error: boom\n    at x")).toEqual([])
		expect(console.error).toHaveBeenCalled()
	})
})
