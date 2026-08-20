// The shell parser is third-party: this file pins what happens when it fails.
import { extractPatternsFromCommand } from "../command-parser"

vi.mock("shell-quote", () => ({
	parse: vi.fn(() => {
		throw new Error("unexpected token")
	}),
}))

describe("extractPatternsFromCommand — when the shell parser throws", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("does not propagate the error to the caller", () => {
		// The command palette renders while typing; a parser crash must not take the UI down.
		expect(() => extractPatternsFromCommand("git push origin main")).not.toThrow()
	})

	it("falls back to the first word only", () => {
		expect(extractPatternsFromCommand("git push origin main")).toEqual(["git"])
	})

	it("never invents a pattern the command does not start with", () => {
		const patterns = extractPatternsFromCommand("  rm   -rf /tmp/x  ")
		expect(patterns).toEqual(["rm"])
	})

	it("returns nothing for a blank command without consulting the parser", () => {
		expect(extractPatternsFromCommand("   ")).toEqual([])
	})
})
