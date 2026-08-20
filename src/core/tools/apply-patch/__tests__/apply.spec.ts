import { applyChunksToContent, ApplyPatchError, processHunk, processAllHunks } from "../apply"
import type { Hunk, UpdateFileChunk } from "../parser"

describe("apply-patch apply", () => {
	describe("applyChunksToContent", () => {
		it("should apply simple replacement", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo", "bar"],
					newLines: ["foo", "baz"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nbaz\n")
		})

		it("should apply insertion", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo"],
					newLines: ["foo", "inserted"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\ninserted\nbar\n")
		})

		it("should apply deletion", () => {
			const original = "foo\nbar\nbaz\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo", "bar"],
					newLines: ["foo"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nbaz\n")
		})

		it("should apply multiple chunks", () => {
			const original = "foo\nbar\nbaz\nqux\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo", "bar"],
					newLines: ["foo", "BAR"],
					isEndOfFile: false,
				},
				{
					changeContext: null,
					oldLines: ["baz", "qux"],
					newLines: ["baz", "QUX"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nBAR\nbaz\nQUX\n")
		})

		it("should use context to find location", () => {
			const original = "class Foo:\n    def bar(self):\n        pass\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: "def bar(self):",
					oldLines: ["        pass"],
					newLines: ["        return 123"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.py", chunks)
			expect(result).toBe("class Foo:\n    def bar(self):\n        return 123\n")
		})

		it("should throw when context not found", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: "nonexistent",
					oldLines: ["foo"],
					newLines: ["baz"],
					isEndOfFile: false,
				},
			]
			expect(() => applyChunksToContent(original, "test.txt", chunks)).toThrow(ApplyPatchError)
			expect(() => applyChunksToContent(original, "test.txt", chunks)).toThrow("Failed to find context")
		})

		it("should throw when old lines not found", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["nonexistent"],
					newLines: ["baz"],
					isEndOfFile: false,
				},
			]
			expect(() => applyChunksToContent(original, "test.txt", chunks)).toThrow(ApplyPatchError)
			expect(() => applyChunksToContent(original, "test.txt", chunks)).toThrow("Failed to find expected lines")
		})

		it("should handle pure addition (empty oldLines)", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: [],
					newLines: ["added"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			// Pure addition goes at the end
			expect(result).toBe("foo\nbar\nadded\n")
		})

		it("should handle isEndOfFile flag", () => {
			const original = "foo\nbar\nbaz\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["baz"],
					newLines: ["BAZ", "qux"],
					isEndOfFile: true,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nbar\nBAZ\nqux\n")
		})

		it("should handle interleaved changes", () => {
			const original = "a\nb\nc\nd\ne\nf\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["a", "b"],
					newLines: ["a", "B"],
					isEndOfFile: false,
				},
				{
					changeContext: null,
					oldLines: ["d", "e"],
					newLines: ["d", "E"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("a\nB\nc\nd\nE\nf\n")
		})

		it("should preserve trailing newline in result", () => {
			const original = "foo\nbar"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["bar"],
					newLines: ["baz"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			// Should add trailing newline
			expect(result).toBe("foo\nbaz\n")
		})

		it("should handle trailing empty line in pattern", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo", "bar", ""],
					newLines: ["foo", "baz", ""],
					isEndOfFile: false,
				},
			]
			// Should still work by stripping trailing empty
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nbaz\n")
		})

		it("should insert a pure addition before a trailing blank line", () => {
			// 末尾に空行が残るファイル(\n\n)への純粋追加は、最終空行の手前へ挿入する。
			// これで挿入結果が末尾空行より前に来ることを固定する(範囲外に出ない不変条件)。
			const original = "foo\n\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: [],
					newLines: ["added"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nadded\n")
		})

		it("should truncate very long old-line context in the not-found error", () => {
			// old_lines が 200 文字を超える場合、エラーメッセージは 200 文字で切り詰め '...' を付す。
			const longOld = Array.from({ length: 10 }, () => "x".repeat(30)) // join 後 309 文字
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: longOld,
					newLines: ["replacement"],
					isEndOfFile: false,
				},
			]
			expect(() => applyChunksToContent("different\n", "test.txt", chunks)).toThrow(ApplyPatchError)
			expect(() => applyChunksToContent("different\n", "test.txt", chunks)).toThrow(/\.\.\.$/)
		})
	})

	describe("processHunk", () => {
		it("should map an AddFile hunk to an add change without reading the file", async () => {
			const hunk: Hunk = { type: "AddFile", path: "new.txt", contents: "hello\n" }
			const readFile = vi.fn(async () => "should-not-be-read")
			const change = await processHunk(hunk, readFile)
			expect(change).toEqual({ type: "add", path: "new.txt", newContent: "hello\n" })
			expect(readFile).not.toHaveBeenCalled()
		})

		it("should map a DeleteFile hunk to a delete change carrying the original content", async () => {
			const hunk: Hunk = { type: "DeleteFile", path: "gone.txt" }
			const readFile = vi.fn(async (p: string) => `content-of-${p}`)
			const change = await processHunk(hunk, readFile)
			expect(change).toEqual({
				type: "delete",
				path: "gone.txt",
				originalContent: "content-of-gone.txt",
			})
			expect(readFile).toHaveBeenCalledWith("gone.txt")
		})

		it("should map an UpdateFile hunk to an update change with new content", async () => {
			const hunk: Hunk = {
				type: "UpdateFile",
				path: "u.txt",
				movePath: null,
				chunks: [
					{
						changeContext: null,
						oldLines: ["foo", "bar"],
						newLines: ["foo", "baz"],
						isEndOfFile: false,
					},
				],
			}
			const readFile = vi.fn(async () => "foo\nbar\n")
			const change = await processHunk(hunk, readFile)
			expect(change).toEqual({
				type: "update",
				path: "u.txt",
				movePath: undefined, // movePath が null のときは undefined へ落とす
				originalContent: "foo\nbar\n",
				newContent: "foo\nbaz\n",
			})
		})

		it("should carry movePath through an UpdateFile hunk when present", async () => {
			const hunk: Hunk = {
				type: "UpdateFile",
				path: "u.txt",
				movePath: "moved.txt",
				chunks: [
					{
						changeContext: null,
						oldLines: ["foo"],
						newLines: ["FOO"],
						isEndOfFile: false,
					},
				],
			}
			const readFile = vi.fn(async () => "foo\n")
			const change = await processHunk(hunk, readFile)
			expect(change.movePath).toBe("moved.txt")
			expect(change.newContent).toBe("FOO\n")
		})
	})

	describe("processAllHunks", () => {
		it("should process every hunk in order", async () => {
			const hunks: Hunk[] = [
				{ type: "AddFile", path: "a.txt", contents: "a\n" },
				{ type: "DeleteFile", path: "b.txt" },
			]
			const readFile = vi.fn(async (p: string) => `orig-${p}`)
			const changes = await processAllHunks(hunks, readFile)
			expect(changes).toEqual([
				{ type: "add", path: "a.txt", newContent: "a\n" },
				{ type: "delete", path: "b.txt", originalContent: "orig-b.txt" },
			])
		})

		it("should return an empty array for no hunks", async () => {
			const changes = await processAllHunks(
				[],
				vi.fn(async () => ""),
			)
			expect(changes).toEqual([])
		})
	})
})
