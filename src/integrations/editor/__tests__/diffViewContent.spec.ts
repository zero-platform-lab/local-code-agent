// npx vitest run integrations/editor/__tests__/diffViewContent.spec.ts

import * as diff from "diff"

import {
	buildWriteResultPayload,
	compareSavedContent,
	findFirstDiffLine,
	formatNewProblemsMessage,
	preserveTrailingNewline,
	stripAllBoms,
} from "../diffViewContent"

// `diff` は基本そのまま通し、1 テストだけ diffLines の戻り値を差し替えられるようにする。
vi.mock("diff", async (importOriginal) => {
	const actual = await importOriginal<typeof import("diff")>()
	return {
		...actual,
		diffLines: vi.fn((...args: Parameters<typeof actual.diffLines>) => actual.diffLines(...args)),
	}
})

const BOM = "﻿"

describe("stripAllBoms", () => {
	it("leaves content without a BOM alone", () => {
		expect(stripAllBoms("hello")).toBe("hello")
	})

	it("removes a single BOM", () => {
		expect(stripAllBoms(`${BOM}hello`)).toBe("hello")
	})

	it("removes stacked BOMs, which strip-bom alone would not", () => {
		expect(stripAllBoms(`${BOM}${BOM}${BOM}hello`)).toBe("hello")
	})

	it("leaves a BOM that is not at the start", () => {
		expect(stripAllBoms(`a${BOM}b`)).toBe(`a${BOM}b`)
	})

	it("handles an empty string", () => {
		expect(stripAllBoms("")).toBe("")
	})
})

describe("preserveTrailingNewline", () => {
	it("re-adds the trailing newline the original had", () => {
		expect(preserveTrailingNewline("a\nb\n", "a\nb")).toBe("a\nb\n")
	})

	it("does not double up when the new content already ends with one", () => {
		expect(preserveTrailingNewline("a\nb\n", "a\nb\n")).toBe("a\nb\n")
	})

	it("does not add one when the original had none", () => {
		expect(preserveTrailingNewline("a\nb", "a\nb")).toBe("a\nb")
	})

	it("does nothing when the original content is unknown", () => {
		expect(preserveTrailingNewline(undefined, "a\nb")).toBe("a\nb")
	})

	it("treats an empty original as having no trailing newline", () => {
		expect(preserveTrailingNewline("", "a")).toBe("a")
	})
})

describe("compareSavedContent", () => {
	it("reports no user edit when the content matches", () => {
		const result = compareSavedContent("a\nb\n", "a\nb\n")

		expect(result.userEdited).toBe(false)
		expect(result.eol).toBe("\n")
	})

	it("reports a user edit when the editor content differs", () => {
		expect(compareSavedContent("a\nb\n", "a\nCHANGED\n").userEdited).toBe(true)
	})

	it("ignores pure EOL differences by normalizing to the agent's EOL", () => {
		// エージェントが CRLF で書いた → エディタ側が LF でも「編集された」とはしない。
		const result = compareSavedContent("a\r\nb\r\n", "a\nb\n")

		expect(result.eol).toBe("\r\n")
		expect(result.userEdited).toBe(false)
		expect(result.normalizedEditedContent).toBe("a\r\nb\r\n")
	})

	it("normalizes toward LF when the agent used LF", () => {
		const result = compareSavedContent("a\nb\n", "a\r\nb\r\n")

		expect(result.eol).toBe("\n")
		expect(result.userEdited).toBe(false)
		expect(result.normalizedEditedContent).toBe("a\nb\n")
	})

	it("normalizes mixed EOLs on the agent side too", () => {
		const result = compareSavedContent("a\r\nb\nc", "a\r\nb\r\nc")

		expect(result.normalizedNewContent).toBe("a\r\nb\r\nc")
		expect(result.userEdited).toBe(false)
	})

	it("does not trim, so trailing whitespace still counts as an edit", () => {
		expect(compareSavedContent("a\n", "a \n").userEdited).toBe(true)
	})
})

describe("findFirstDiffLine", () => {
	it("returns undefined when the content is identical", () => {
		expect(findFirstDiffLine("a\nb\nc\n", "a\nb\nc\n")).toBeUndefined()
	})

	it("finds a change on the first line", () => {
		expect(findFirstDiffLine("a\nb\n", "X\nb\n")).toBe(0)
	})

	it("counts unchanged lines before the first change", () => {
		expect(findFirstDiffLine("a\nb\nc\n", "a\nb\nX\n")).toBe(2)
	})

	it("finds an insertion", () => {
		expect(findFirstDiffLine("a\nc\n", "a\nb\nc\n")).toBe(1)
	})

	it("finds a deletion without counting the removed lines", () => {
		expect(findFirstDiffLine("a\nb\nc\n", "a\nc\n")).toBe(1)
	})

	it("treats going from empty to content as a diff at line 0", () => {
		expect(findFirstDiffLine("", "a\n")).toBe(0)
	})

	it("count が欠けた hunk では 0 行として扱い先へ進む（防御的分岐）", () => {
		// 実際の diff.diffLines は必ず count を返すため、この分岐は防御用。
		// count 無し・added/removed 無しの hunk を返させて `part.count || 0` の右側を通す。
		vi.mocked(diff.diffLines).mockReturnValueOnce([{ added: false, removed: false, value: "" } as any])

		expect(findFirstDiffLine("same", "same")).toBeUndefined()
	})
})

describe("buildWriteResultPayload", () => {
	it("reports a created file", () => {
		expect(JSON.parse(buildWriteResultPayload({ relPath: "a.ts", isNewFile: true }))).toEqual({
			path: "a.ts",
			operation: "created",
			notice: "You do not need to re-read the file, as you have seen all changes Proceed with the task using these changes as the new baseline.",
		})
	})

	it("reports a modified file", () => {
		expect(JSON.parse(buildWriteResultPayload({ relPath: "a.ts", isNewFile: false })).operation).toBe("modified")
	})

	it("adds the extra guidance sentence only when the user edited", () => {
		const withEdits = JSON.parse(buildWriteResultPayload({ relPath: "a.ts", isNewFile: false, userEdits: "@@ -1" }))
		const without = JSON.parse(buildWriteResultPayload({ relPath: "a.ts", isNewFile: false }))

		expect(withEdits.notice).toContain("adjust your approach accordingly")
		expect(without.notice).not.toContain("adjust your approach accordingly")
		expect(withEdits.user_edits).toBe("@@ -1")
		expect(without.user_edits).toBeUndefined()
	})

	it("includes problems only when present", () => {
		expect(
			JSON.parse(buildWriteResultPayload({ relPath: "a.ts", isNewFile: false, newProblemsMessage: "boom" }))
				.problems,
		).toBe("boom")
		expect(
			JSON.parse(buildWriteResultPayload({ relPath: "a.ts", isNewFile: false, newProblemsMessage: "" })).problems,
		).toBeUndefined()
	})
})

describe("formatNewProblemsMessage", () => {
	it("returns an empty string when there are no problems", () => {
		expect(formatNewProblemsMessage("")).toBe("")
	})

	it("prefixes a header when there are problems", () => {
		expect(formatNewProblemsMessage("a.ts:1 error")).toBe(
			"\n\nNew problems detected after saving the file:\na.ts:1 error",
		)
	})
})
