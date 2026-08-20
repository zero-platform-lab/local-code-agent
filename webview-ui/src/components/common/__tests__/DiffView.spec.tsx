import { render, screen, waitFor } from "@/utils/test-utils"

import type { DiffLine } from "@src/utils/parseUnifiedDiff"
import { parseUnifiedDiff } from "@src/utils/parseUnifiedDiff"
import { highlightHunks } from "@src/utils/highlightDiff"

import DiffView from "../DiffView"

vi.mock("@src/utils/parseUnifiedDiff", () => ({ parseUnifiedDiff: vi.fn() }))
vi.mock("@src/utils/highlightDiff", () => ({ highlightHunks: vi.fn() }))

const line = (partial: Partial<DiffLine> & Pick<DiffLine, "type" | "content">): DiffLine => ({
	oldLineNum: null,
	newLineNum: null,
	...partial,
})

const rows = () => Array.from(document.querySelectorAll("tbody tr"))

const cellsOf = (row: Element) => Array.from(row.querySelectorAll("td")).map((td) => td.textContent)

describe("DiffView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		document.body.className = ""
		vi.mocked(highlightHunks).mockResolvedValue({ oldLines: [], newLines: [] })
	})

	it("renders one row per diff line with its numbers and sign", async () => {
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "context", content: "keep", oldLineNum: 1, newLineNum: 1 }),
			line({ type: "deletion", content: "gone", oldLineNum: 2 }),
			line({ type: "addition", content: "new", newLineNum: 2 }),
		])

		render(<DiffView source="diff" />)

		await waitFor(() => expect(rows()).toHaveLength(3))
		expect(cellsOf(rows()[0])).toEqual(["1", "1", "", "", "keep"])
		expect(cellsOf(rows()[1])).toEqual(["2", "", "", "-", "gone"])
		expect(cellsOf(rows()[2])).toEqual(["", "2", "", "+", "new"])
	})

	it("marks additions and deletions with the diff editor colours", async () => {
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "deletion", content: "gone", oldLineNum: 1 }),
			line({ type: "addition", content: "new", newLineNum: 1 }),
			line({ type: "context", content: "same", oldLineNum: 2, newLineNum: 2 }),
		])

		render(<DiffView source="diff" />)

		await waitFor(() => expect(rows()).toHaveLength(3))
		expect(rows()[0].querySelector("td")!.className).toContain("removedTextBackground")
		expect(rows()[1].querySelector("td")!.className).toContain("insertedTextBackground")
		expect(rows()[2].querySelector("td")!.className).toContain("editorGroup-border")
		expect(rows()[0].querySelectorAll("td")[4].className).toContain("diff-content-removed")
		expect(rows()[1].querySelectorAll("td")[4].className).toContain("diff-content-inserted")
		expect(rows()[2].querySelectorAll("td")[4].className).toContain("diff-content-context")
	})

	it("summarises skipped lines at a gap", async () => {
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "context", content: "a", oldLineNum: 1, newLineNum: 1 }),
			line({ type: "gap", content: "", hiddenCount: 12 }),
			line({ type: "context", content: "b", oldLineNum: 20, newLineNum: 20 }),
		])

		render(<DiffView source="diff" />)

		expect(await screen.findByText("12 hidden lines")).toBeInTheDocument()
	})

	it("says zero rather than nothing when the gap size is unknown", async () => {
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "context", content: "a", oldLineNum: 1, newLineNum: 1 }),
			line({ type: "gap", content: "" }),
			line({ type: "context", content: "b", oldLineNum: 20, newLineNum: 20 }),
		])

		render(<DiffView source="diff" />)

		expect(await screen.findByText("0 hidden lines")).toBeInTheDocument()
	})

	it("highlights each hunk separately, splitting on gaps", async () => {
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "context", content: "a", oldLineNum: 1, newLineNum: 1 }),
			line({ type: "deletion", content: "b", oldLineNum: 2 }),
			line({ type: "gap", content: "", hiddenCount: 5 }),
			line({ type: "addition", content: "c", newLineNum: 8 }),
		])

		render(<DiffView source="diff" filePath="src/app.ts" />)

		await waitFor(() => expect(highlightHunks).toHaveBeenCalledTimes(2))
		expect(vi.mocked(highlightHunks).mock.calls[0].slice(0, 4)).toEqual(["a\nb", "a", "typescript", "dark"])
		expect(vi.mocked(highlightHunks).mock.calls[1].slice(0, 4)).toEqual(["", "c", "typescript", "dark"])
	})

	it("does not emit a hunk for a trailing gap on its own", async () => {
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "context", content: "a", oldLineNum: 1, newLineNum: 1 }),
			line({ type: "gap", content: "", hiddenCount: 3 }),
		])

		render(<DiffView source="diff" />)

		await waitFor(() => expect(highlightHunks).toHaveBeenCalledTimes(1))
		expect(rows()).toHaveLength(1)
	})

	it("asks for the light theme when the webview is in a light VS Code theme", async () => {
		document.body.className = "vscode-high-contrast-light"
		vi.mocked(parseUnifiedDiff).mockReturnValue([line({ type: "addition", content: "a", newLineNum: 1 })])

		render(<DiffView source="diff" />)

		await waitFor(() => expect(highlightHunks).toHaveBeenCalled())
		expect(vi.mocked(highlightHunks).mock.calls[0][3]).toBe("light")
	})

	it("skips highlighting altogether for very large diffs", async () => {
		vi.mocked(parseUnifiedDiff).mockReturnValue([line({ type: "addition", content: "a", newLineNum: 1 })])

		render(<DiffView source={"x\n".repeat(1001)} />)

		await waitFor(() => expect(rows()).toHaveLength(1))
		expect(highlightHunks).not.toHaveBeenCalled()
		expect(screen.getByText("a")).toBeInTheDocument()
	})

	it("shows plain text when highlighting a hunk fails", async () => {
		vi.mocked(highlightHunks).mockRejectedValue(new Error("shiki exploded"))
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "addition", content: "still visible", newLineNum: 1 }),
		])

		render(<DiffView source="diff" />)

		expect(await screen.findByText("still visible")).toBeInTheDocument()
	})

	it("shows the highlighted node for each kind of line", async () => {
		vi.mocked(highlightHunks).mockResolvedValue({
			oldLines: [<span key="o0">old-0</span>, <span key="o1">old-1</span>],
			newLines: [<span key="n0">new-0</span>, <span key="n1">new-1</span>],
		})
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "context", content: "ctx", oldLineNum: 1, newLineNum: 1 }),
			line({ type: "deletion", content: "del", oldLineNum: 2 }),
			line({ type: "addition", content: "add", newLineNum: 2 }),
		])

		render(<DiffView source="diff" />)

		// Context prefers the new side; the deletion and addition each take their own side.
		expect(await screen.findByText("new-0")).toBeInTheDocument()
		expect(screen.getByText("old-1")).toBeInTheDocument()
		expect(screen.getByText("new-1")).toBeInTheDocument()
	})

	it("falls back to the raw text when a highlighted line is missing", async () => {
		vi.mocked(highlightHunks).mockResolvedValue({ oldLines: [], newLines: [] })
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "context", content: "ctx", oldLineNum: 1, newLineNum: 1 }),
			line({ type: "deletion", content: "del", oldLineNum: 2 }),
			line({ type: "addition", content: "add", newLineNum: 2 }),
		])

		render(<DiffView source="diff" />)

		await waitFor(() => expect(highlightHunks).toHaveBeenCalled())
		expect(screen.getByText("ctx")).toBeInTheDocument()
		expect(screen.getByText("del")).toBeInTheDocument()
		expect(screen.getByText("add")).toBeInTheDocument()
	})

	it("falls back to the old side for context lines the new side does not cover", async () => {
		vi.mocked(highlightHunks).mockResolvedValue({ oldLines: [<span key="o0">old-ctx</span>], newLines: [] })
		vi.mocked(parseUnifiedDiff).mockReturnValue([
			line({ type: "context", content: "ctx", oldLineNum: 1, newLineNum: 1 }),
		])

		render(<DiffView source="diff" />)

		expect(await screen.findByText("old-ctx")).toBeInTheDocument()
	})
})
