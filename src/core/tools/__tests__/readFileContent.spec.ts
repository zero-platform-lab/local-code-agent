// npx vitest run core/tools/__tests__/readFileContent.spec.ts

import { DEFAULT_LINE_LIMIT } from "../../prompts/tools/native-tools/read_file"
import {
	describeLineSnippet,
	EMPTY_FILE_NOTICE,
	resolveStartLine,
	selectLineRanges,
	shapeFileContent,
	shapeLegacyFileContent,
} from "../readFileContent"

const numberedLines = (count: number) => Array.from({ length: count }, (_, i) => `line${i + 1}`).join("\n")

describe("shapeFileContent — slice mode", () => {
	it("reads from the top by default", () => {
		expect(shapeFileContent("a\nb\nc", { path: "x" })).toContain("a")
	})

	it("reports a genuinely empty file as empty", () => {
		expect(shapeFileContent("", { path: "x" })).toBe(EMPTY_FILE_NOTICE)
	})

	it("treats offset as 1-indexed", () => {
		const output = shapeFileContent("a\nb\nc", { path: "x", offset: 2, limit: 1 })

		expect(output).toContain("b")
		expect(output).not.toContain("| a")
	})

	it("clamps an offset of 0 to the start rather than reading backwards", () => {
		expect(shapeFileContent("a\nb", { path: "x", offset: 0, limit: 1 })).toContain("a")
	})

	it("emits the truncation notice byte-for-byte, with the warning ahead of the content", () => {
		const output = shapeFileContent(numberedLines(10), { path: "x", offset: 1, limit: 3 })

		// タブ位置まで含めて固定する。既存の統合テストは substring しか見ておらず、
		// 空白の変化を検出できなかった。タブが付くのは告知の 3 行と本文の 1 行目だけ。
		expect(output).toBe(
			"IMPORTANT: File content truncated.\n" +
				"\tStatus: Showing lines 1-3 of 10 total lines.\n" +
				"\tTo read more: Use the read_file tool with offset=4 and limit=3.\n" +
				"\t\n" +
				"\t1 | line1\n2 | line2\n3 | line3",
		)
	})

	it("computes the next offset from the last line actually returned", () => {
		const output = shapeFileContent(numberedLines(100), { path: "x", offset: 11, limit: 5 })

		expect(output).toContain("Status: Showing lines 11-15 of 100 total lines.")
		expect(output).toContain("offset=16 and limit=5")
	})

	it("does not add a notice when the whole file fits", () => {
		expect(shapeFileContent("a\nb", { path: "x", limit: 10 })).not.toContain("IMPORTANT")
	})
})

describe("shapeFileContent — indentation mode", () => {
	const source = ["def outer():", "    a = 1", "    b = 2", "", "def other():", "    c = 3"].join("\n")

	it("appends the included ranges summary", () => {
		const output = shapeFileContent(source, { path: "x", mode: "indentation", anchor_line: 2 })

		expect(output).toMatch(/Included ranges: \d+-\d+ \(total: 6 lines\)/)
	})

	it("falls back to offset for the anchor when anchor_line is absent", () => {
		const viaAnchor = shapeFileContent(source, { path: "x", mode: "indentation", anchor_line: 5 })
		const viaOffset = shapeFileContent(source, { path: "x", mode: "indentation", offset: 5 })

		expect(viaOffset).toBe(viaAnchor)
	})

	it("falls back to line 1 when neither anchor_line nor offset is given", () => {
		const implicit = shapeFileContent(source, { path: "x", mode: "indentation" })
		const explicit = shapeFileContent(source, { path: "x", mode: "indentation", anchor_line: 1 })

		expect(implicit).toBe(explicit)
	})

	it("puts the truncation notice ahead of the content when indentation output is truncated", () => {
		// max_lines=1 で reader を finalLimit=1 に落とし、複数行ファイルを切り詰めさせる。
		// slice モードと同じ「警告を内容の前に置く」告知になること（末尾の
		// Included ranges 要約ではなく truncationNotice が返ること）を固定する。
		const output = shapeFileContent(numberedLines(5), {
			path: "x",
			mode: "indentation",
			anchor_line: 1,
			max_lines: 1,
		})

		expect(output).toBe(
			"IMPORTANT: File content truncated.\n" +
				`\tStatus: Showing lines 1-1 of 5 total lines.\n` +
				`\tTo read more: Use the read_file tool with offset=2 and limit=${DEFAULT_LINE_LIMIT}.\n` +
				"\t\n" +
				"\t1 | line1",
		)
		expect(output).not.toContain("Included ranges")
	})
})

describe("resolveStartLine", () => {
	it("offers no jump target when reading a slice from the top", () => {
		expect(resolveStartLine({ path: "x" })).toBeUndefined()
		expect(resolveStartLine({ path: "x", offset: 1 })).toBeUndefined()
	})

	it("returns the offset when reading from further down", () => {
		expect(resolveStartLine({ path: "x", offset: 42 })).toBe(42)
	})

	it("always returns the effective anchor in indentation mode, including line 1", () => {
		expect(resolveStartLine({ path: "x", mode: "indentation" })).toBe(1)
		expect(resolveStartLine({ path: "x", mode: "indentation", offset: 7 })).toBe(7)
		expect(resolveStartLine({ path: "x", mode: "indentation", anchor_line: 9, offset: 7 })).toBe(9)
	})
})

describe("describeLineSnippet", () => {
	it("shows the default line cap even when the caller did not set one", () => {
		expect(describeLineSnippet({ path: "x" })).toBe(`(up to ${DEFAULT_LINE_LIMIT} lines)`)
	})

	it("shows an explicit cap", () => {
		expect(describeLineSnippet({ path: "x", limit: 50 })).toBe("(up to 50 lines)")
	})

	it("shows the range when starting past line 1", () => {
		expect(describeLineSnippet({ path: "x", offset: 10, limit: 5 })).toBe("(lines 10-14)")
	})

	it("describes indentation mode with its effective anchor", () => {
		expect(describeLineSnippet({ path: "x", mode: "indentation" })).toBe("(indentation mode at line 1)")
		expect(describeLineSnippet({ path: "x", mode: "indentation", anchor_line: 12 })).toBe(
			"(indentation mode at line 12)",
		)
	})
})

describe("selectLineRanges", () => {
	const content = "a\nb\nc\nd\ne"

	it("extracts a 1-indexed inclusive range with line numbers", () => {
		expect(selectLineRanges(content, [{ start: 2, end: 4 }])).toBe("2 | b\n3 | c\n4 | d")
	})

	it("concatenates multiple ranges in the order given", () => {
		expect(
			selectLineRanges(content, [
				{ start: 4, end: 4 },
				{ start: 1, end: 1 },
			]),
		).toBe("4 | d\n1 | a")
	})

	it("clamps a range that runs past the end of the file", () => {
		expect(selectLineRanges(content, [{ start: 4, end: 99 }])).toBe("4 | d\n5 | e")
	})

	it("clamps a start below 1", () => {
		expect(selectLineRanges(content, [{ start: 0, end: 2 }])).toBe("1 | a\n2 | b")
	})

	it("returns an empty string for an inverted range", () => {
		expect(selectLineRanges(content, [{ start: 4, end: 2 }])).toBe("")
	})
})

describe("shapeLegacyFileContent", () => {
	it("uses the ranges when given", () => {
		expect(shapeLegacyFileContent("a\nb\nc", [{ start: 2, end: 2 }])).toBe("2 | b")
	})

	it("reads from the top when no ranges are given", () => {
		expect(shapeLegacyFileContent("a\nb\nc")).toContain("a")
	})

	it("appends its truncation note at the END, unlike the new format", () => {
		// 旧形式の告知は短い一文で末尾。新形式は先頭に置く詳しい案内。
		const output = shapeLegacyFileContent(numberedLines(DEFAULT_LINE_LIMIT + 10))

		expect(output).not.toContain("IMPORTANT: File content truncated.")
		expect(output.trimEnd().endsWith(`total lines]`)).toBe(true)
		expect(output).toContain(
			`[File truncated: showing ${DEFAULT_LINE_LIMIT} of ${DEFAULT_LINE_LIMIT + 10} total lines]`,
		)
	})

	it("adds no note when the file fits", () => {
		expect(shapeLegacyFileContent("a\nb")).not.toContain("File truncated")
	})
})

// 本物の readWithSlice / readWithIndentation を使って端の挙動を固定する。
// 統合 spec 側は indentation-reader をモジュールごと mock しており、その mock は
// 空ファイルに対して returnedLines:0 を返す **実物と食い違う** 形になっていた。
// その食い違いが「offset 超過を空ファイルと誤報する」バグを覆い隠していたので、
// ここは必ず実物で確かめる。
describe("shapeFileContent — boundaries, against the real reader", () => {
	describe("empty file", () => {
		it("says the file is empty in slice mode", () => {
			expect(shapeFileContent("", { path: "x" })).toBe(EMPTY_FILE_NOTICE)
		})

		it("says the file is empty in indentation mode too", () => {
			expect(shapeFileContent("", { path: "x", mode: "indentation" })).toBe(EMPTY_FILE_NOTICE)
		})

		it("says the file is empty regardless of offset or limit", () => {
			expect(shapeFileContent("", { path: "x", offset: 5, limit: 1 })).toBe(EMPTY_FILE_NOTICE)
		})

		it("does NOT call a file holding a single newline empty", () => {
			// 0 バイトのファイルだけが空。改行 1 個は「空行が 1 行ある」ファイル。
			expect(shapeFileContent("\n", { path: "x" })).toBe("1 | \n2 | ")
		})

		it("does NOT call a whitespace-only file empty", () => {
			expect(shapeFileContent("   ", { path: "x" })).toBe("1 |    ")
		})
	})

	describe("offset beyond the end of the file", () => {
		it("explains the offset is out of range instead of claiming the file is empty", () => {
			expect(shapeFileContent("a\nb", { path: "x", offset: 100 })).toBe(
				"Error: offset 100 is beyond file end (2 lines)",
			)
		})

		it("reports the offset in the caller's 1-indexed units, not the reader's 0-indexed one", () => {
			// 素通しにすると reader は 0 起点に変換済みの値 (99) を報告してしまい、
			// モデルが「99 を送った」と誤解する。
			const output = shapeFileContent("a\nb", { path: "x", offset: 100 })

			expect(output).toContain("offset 100")
			expect(output).not.toContain("offset 99")
		})

		it("treats one past the last line as out of range", () => {
			expect(shapeFileContent("a\nb", { path: "x", offset: 3 })).toBe(
				"Error: offset 3 is beyond file end (2 lines)",
			)
		})

		it("still reads the last line when the offset is exactly the line count", () => {
			expect(shapeFileContent("a\nb", { path: "x", offset: 2 })).toBe("2 | b")
		})
	})

	describe("out-of-range anchor in indentation mode", () => {
		it("keeps surfacing the reader's own message, which is already 1-indexed", () => {
			expect(shapeFileContent("a\nb", { path: "x", mode: "indentation", anchor_line: 99 })).toBe(
				"Error: anchor_line 99 is out of range (1-2)",
			)
		})
	})

	describe("limit is validated before it ever reaches here", () => {
		// ReadFileTool.executeNew が limit < 1 を弾くようになったので、この関数へ 0 や
		// 負値が渡ることはない。到達しない入力に対する出力は仕様として保証しないが、
		// 「素通しすると壊れる」ことは記録しておく（ガードを外したら何が起きるか）。
		it("would produce a nonsensical notice if a non-positive limit ever got through", () => {
			const output = shapeFileContent("a\nb", { path: "x", limit: 0 })

			expect(output).toContain("Status: Showing lines 1-0 of 2 total lines.")
		})

		it("would silently drop trailing lines for a negative limit", () => {
			// slice(offset, offset + limit) が末尾から削るため、一部だけ返って成功に見える。
			// 弾かずにクランプしていたら気づけない類の壊れ方。
			const output = shapeFileContent("a\nb\nc", { path: "x", limit: -1 })

			expect(output).toContain("1 | a")
			expect(output).toContain("2 | b")
			expect(output).not.toContain("3 | c")
		})
	})
})
