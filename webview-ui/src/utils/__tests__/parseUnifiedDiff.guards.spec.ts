// npx vitest run src/utils/__tests__/parseUnifiedDiff.guards.spec.ts
//
// parseUnifiedDiff は `diff` の parsePatch が返す形をそのまま信用せず、
// 欠けたフィールドに出会っても「何も描かない」で済ませる。実物の parsePatch では
// 踏めない防御経路なので、ここだけライブラリを差し替えて固定する。

import { parseUnifiedDiff } from "../parseUnifiedDiff"

const parsePatch = vi.hoisted(() => vi.fn())

vi.mock("diff", () => ({ parsePatch }))

const DIFF = "--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n"

describe("parseUnifiedDiff (defensive paths)", () => {
	beforeEach(() => {
		parsePatch.mockReset()
	})

	it("returns nothing when parsePatch yields no patch at all", () => {
		parsePatch.mockReturnValue([])
		expect(parseUnifiedDiff(DIFF)).toEqual([])
	})

	it("returns nothing when parsePatch yields a nullish patch", () => {
		parsePatch.mockReturnValue(undefined)
		expect(parseUnifiedDiff(DIFF)).toEqual([])
	})

	it("returns nothing when the selected patch is empty", () => {
		parsePatch.mockReturnValue([undefined])
		expect(parseUnifiedDiff(DIFF)).toEqual([])
	})

	it("returns nothing when the patch carries no hunks", () => {
		parsePatch.mockReturnValue([{ newFileName: "b/file.ts", oldFileName: "a/file.ts" }])
		expect(parseUnifiedDiff(DIFF)).toEqual([])
	})

	it("returns nothing when a hunk carries no lines", () => {
		parsePatch.mockReturnValue([
			{
				newFileName: "b/file.ts",
				oldFileName: "a/file.ts",
				hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0 }],
			},
		])
		expect(parseUnifiedDiff(DIFF)).toEqual([])
	})

	it("ignores patches whose file names are not strings when filtering by path", () => {
		parsePatch.mockReturnValue([
			{ newFileName: 42, oldFileName: null, hunks: [] },
			{ newFileName: "b/file.ts", oldFileName: "a/file.ts", hunks: [] },
		])
		expect(parseUnifiedDiff(DIFF, "file.ts")).toEqual([])
	})
})
