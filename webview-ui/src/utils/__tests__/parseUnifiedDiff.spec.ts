import { describe, it, expect } from "vitest"

import { parseUnifiedDiff } from "../parseUnifiedDiff"

describe("parseUnifiedDiff", () => {
	it("returns empty array for empty input", () => {
		expect(parseUnifiedDiff("")).toEqual([])
	})

	it("returns empty array for null/undefined input", () => {
		expect(parseUnifiedDiff(null as any)).toEqual([])
		expect(parseUnifiedDiff(undefined as any)).toEqual([])
	})

	it("parses a simple addition", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3
`
		const result = parseUnifiedDiff(diff)

		expect(result.length).toBe(4)
		expect(result[0]).toEqual({ oldLineNum: 1, newLineNum: 1, type: "context", content: "line1" })
		expect(result[1]).toEqual({ oldLineNum: null, newLineNum: 2, type: "addition", content: "added line" })
		expect(result[2]).toEqual({ oldLineNum: 2, newLineNum: 3, type: "context", content: "line2" })
		expect(result[3]).toEqual({ oldLineNum: 3, newLineNum: 4, type: "context", content: "line3" })
	})

	it("parses a simple deletion", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,2 @@
 line1
-removed line
 line3
`
		const result = parseUnifiedDiff(diff)

		expect(result.length).toBe(3)
		expect(result[0]).toEqual({ oldLineNum: 1, newLineNum: 1, type: "context", content: "line1" })
		expect(result[1]).toEqual({ oldLineNum: 2, newLineNum: null, type: "deletion", content: "removed line" })
		expect(result[2]).toEqual({ oldLineNum: 3, newLineNum: 2, type: "context", content: "line3" })
	})

	it("parses additions and deletions together", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3
`
		const result = parseUnifiedDiff(diff)

		expect(result.length).toBe(4)
		expect(result[1]).toEqual({ oldLineNum: 2, newLineNum: null, type: "deletion", content: "old line" })
		expect(result[2]).toEqual({ oldLineNum: null, newLineNum: 2, type: "addition", content: "new line" })
	})

	it("inserts gap separator between hunks", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
 line1
-old1
+new1
@@ -10,2 +10,2 @@
 line10
-old10
+new10
`
		const result = parseUnifiedDiff(diff)

		// Find the gap separator
		const gaps = result.filter((l) => l.type === "gap")
		expect(gaps.length).toBe(1)
		expect(gaps[0].oldLineNum).toBeNull()
		expect(gaps[0].newLineNum).toBeNull()
		expect(gaps[0].content).toBe("")
		expect(gaps[0].hiddenCount).toBeGreaterThan(0)
	})

	it("finds the correct patch by filePath", () => {
		const diff = `--- a/first.ts
+++ b/first.ts
@@ -1,1 +1,1 @@
-old1
+new1
--- a/second.ts
+++ b/second.ts
@@ -1,1 +1,1 @@
-old2
+new2
`
		const result = parseUnifiedDiff(diff, "second.ts")

		expect(result.length).toBe(2)
		expect(result[0].content).toBe("old2")
		expect(result[1].content).toBe("new2")
	})

	it("falls back to first patch when filePath does not match", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,1 +1,1 @@
-old
+new
`
		const result = parseUnifiedDiff(diff, "nonexistent.ts")
		expect(result.length).toBe(2)
	})

	it("returns empty array for unparseable input", () => {
		const result = parseUnifiedDiff("not a valid diff at all")
		expect(result).toEqual([])
	})

	it("swallows parse errors instead of throwing at the caller", () => {
		// parsePatch は壊れたハンク見出しで例外を投げる。UI を落とさず空配列に倒す。
		const broken = `--- a/file.ts
+++ b/file.ts
@@ bogus @@
+added
`
		expect(() => parseUnifiedDiff(broken)).not.toThrow()
		expect(parseUnifiedDiff(broken)).toEqual([])
	})

	it("returns empty array when parsePatch returns empty", () => {
		// A string that parsePatch can parse but has no hunks
		const diff = `--- a/file.ts
+++ b/file.ts
`
		const result = parseUnifiedDiff(diff)
		expect(result).toEqual([])
	})

	// --- Mutation kills ---
	it("correctly assigns deletion to oldLineNum and null to newLineNum", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,1 +1,0 @@
-deleted
`
		const result = parseUnifiedDiff(diff)
		expect(result[0].oldLineNum).toBe(1)
		expect(result[0].newLineNum).toBeNull()
		expect(result[0].type).toBe("deletion")
	})

	it("correctly assigns addition to newLineNum and null to oldLineNum", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,0 +1,1 @@
+added
`
		const result = parseUnifiedDiff(diff)
		expect(result[0].oldLineNum).toBeNull()
		expect(result[0].newLineNum).toBe(1)
		expect(result[0].type).toBe("addition")
	})

	it("increments line numbers correctly through mixed changes", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 ctx1
-del
+add
 ctx2
`
		const result = parseUnifiedDiff(diff)
		// ctx1: old=1, new=1
		expect(result[0]).toMatchObject({ oldLineNum: 1, newLineNum: 1, type: "context" })
		// del: old=2, new=null
		expect(result[1]).toMatchObject({ oldLineNum: 2, newLineNum: null, type: "deletion" })
		// add: old=null, new=2
		expect(result[2]).toMatchObject({ oldLineNum: null, newLineNum: 2, type: "addition" })
		// ctx2: old=3, new=3
		expect(result[3]).toMatchObject({ oldLineNum: 3, newLineNum: 3, type: "context" })
	})
})
