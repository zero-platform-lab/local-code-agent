// npx vitest run core/diff/__tests__/stats.spec.ts

import { sanitizeUnifiedDiff, computeUnifiedDiffStats, computeDiffStats, convertNewFileToUnifiedDiff } from "../stats"

describe("sanitizeUnifiedDiff", () => {
	it("空文字はそのまま返す（!diff の早期リターン）", () => {
		expect(sanitizeUnifiedDiff("")).toBe("")
	})

	it("CRLF を LF に正規化する", () => {
		expect(sanitizeUnifiedDiff("a\r\nb\r\n")).toBe("a\nb\n")
	})

	it('"No newline at end of file" 行を（バックスラッシュ有無どちらも）取り除く', () => {
		const input = "line1\n\\ No newline at end of file\nline2"
		const out = sanitizeUnifiedDiff(input)
		expect(out).not.toContain("No newline at end of file")
		expect(out).toContain("line1")
		expect(out).toContain("line2")
	})

	it("先頭行の No newline 記法も除去する", () => {
		const input = "No newline at end of file\nkept"
		const out = sanitizeUnifiedDiff(input)
		expect(out).not.toContain("No newline at end of file")
		expect(out).toContain("kept")
	})
})

describe("computeUnifiedDiffStats", () => {
	it("undefined は null（!diff）", () => {
		expect(computeUnifiedDiffStats(undefined)).toBeNull()
	})

	it("空文字は null（!diff）", () => {
		expect(computeUnifiedDiffStats("")).toBeNull()
	})

	it("追加・削除行を正しく数える", () => {
		const diff = ["--- a", "+++ b", "@@ -1,2 +1,3 @@", " ctx", "-removed", "+added", "+added2"].join("\n") + "\n"
		expect(computeUnifiedDiffStats(diff)).toEqual({ added: 2, removed: 1 })
	})

	it("コンテキスト行だけなら {added:0, removed:0}（added>0||removed>0 の else 側）", () => {
		const diff = ["--- a", "+++ b", "@@ -1,1 +1,1 @@", " unchanged"].join("\n") + "\n"
		expect(computeUnifiedDiffStats(diff)).toEqual({ added: 0, removed: 0 })
	})

	it("parsePatch が投げる壊れた入力では null を返す（catch 側・不変条件: 例外を漏らさない）", () => {
		// "@@" ヘッダに対して不正な本文行があると diff ライブラリが throw する
		const broken = "--- a\n+++ b\n@@ -1,5 +1,5 @@\n+only one line\n"
		expect(computeUnifiedDiffStats(broken)).toBeNull()
	})
})

describe("computeDiffStats", () => {
	it("undefined は null（!diff）", () => {
		expect(computeDiffStats(undefined)).toBeNull()
	})

	it("有効な unified diff は集計結果を返す（unified へ委譲）", () => {
		const diff = ["--- a", "+++ b", "@@ -0,0 +1,1 @@", "+new line"].join("\n") + "\n"
		expect(computeDiffStats(diff)).toEqual({ added: 1, removed: 0 })
	})
})

describe("convertNewFileToUnifiedDiff", () => {
	it("新規ファイルの全行が追加として現れ、指定ファイル名を使う", () => {
		const out = convertNewFileToUnifiedDiff("line1\nline2\n", "src/foo.ts")
		expect(out).toContain("+++ src/foo.ts")
		expect(out).toContain("--- /dev/null")
		expect(out).toContain("+line1")
		expect(out).toContain("+line2")
		// 追加として数えられること
		expect(computeUnifiedDiffStats(out)).toEqual({ added: 2, removed: 0 })
	})

	it("filePath 省略時は既定名 'file' を使う（filePath || \"file\" の false 側）", () => {
		const out = convertNewFileToUnifiedDiff("x\n")
		expect(out).toContain("+++ file")
	})

	it('content 省略時は空文字として扱い、差分は生じない（content || "" の false 側）', () => {
		const out = convertNewFileToUnifiedDiff(undefined as unknown as string, "empty.ts")
		// 旧側も新側も空なので追加・削除ゼロ
		expect(computeUnifiedDiffStats(out)).toEqual({ added: 0, removed: 0 })
	})

	it("CRLF は LF に正規化されてから差分化される", () => {
		const out = convertNewFileToUnifiedDiff("a\r\nb\r\n", "f.ts")
		expect(out).not.toContain("\r")
		expect(out).toContain("+a")
		expect(out).toContain("+b")
	})
})
