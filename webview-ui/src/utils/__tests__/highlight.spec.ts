import { describe, it, expect } from "vitest"

import { highlightFzfMatch } from "../highlight"

describe("highlightFzfMatch", () => {
	it("returns plain text when positions array is empty", () => {
		expect(highlightFzfMatch("hello", [])).toBe("hello")
	})

	// 返り値は dangerouslySetInnerHTML に渡るので、ハイライトが 1 件も無い経路でも
	// 生の HTML を素通しさせない（これを外すと履歴一覧に任意の HTML が挿入できる）。
	it("escapes HTML even when positions array is empty", () => {
		expect(highlightFzfMatch('<img src=x onerror="alert(1)">', [])).toBe(
			"&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
		)
	})

	it("highlights a single character", () => {
		const result = highlightFzfMatch("hello", [0])
		expect(result).toBe('<span class="history-item-highlight">h</span>ello')
	})

	it("highlights multiple characters", () => {
		const result = highlightFzfMatch("hello", [1, 3])
		expect(result).toBe(
			'h<span class="history-item-highlight">e</span>l<span class="history-item-highlight">l</span>o',
		)
	})

	it("highlights the last character", () => {
		const result = highlightFzfMatch("abc", [2])
		expect(result).toBe('ab<span class="history-item-highlight">c</span>')
	})

	it("highlights all characters", () => {
		const result = highlightFzfMatch("ab", [0, 1])
		expect(result).toBe(
			'<span class="history-item-highlight">a</span><span class="history-item-highlight">b</span>',
		)
	})

	it("sorts positions before processing", () => {
		const result = highlightFzfMatch("abc", [2, 0])
		expect(result).toBe(
			'<span class="history-item-highlight">a</span>b<span class="history-item-highlight">c</span>',
		)
	})

	it("uses custom highlight class name", () => {
		const result = highlightFzfMatch("hi", [0], "custom-class")
		expect(result).toBe('<span class="custom-class">h</span>i')
	})

	it("escapes HTML in non-highlighted text", () => {
		const result = highlightFzfMatch("<b>bold</b>", [0])
		expect(result).toBe('<span class="history-item-highlight">&lt;</span>b&gt;bold&lt;/b&gt;')
	})

	it("escapes HTML in highlighted text", () => {
		const result = highlightFzfMatch("a&b", [1])
		expect(result).toBe('a<span class="history-item-highlight">&amp;</span>b')
	})

	it("escapes quotes in text", () => {
		const result = highlightFzfMatch("a\"b'c", [])
		expect(result).toBe("a&quot;b&#39;c")
	})

	// --- Mutation kills ---
	it("uses escapeHtml caching (calling twice with same text returns consistent results)", () => {
		const first = highlightFzfMatch("test&escape", [0])
		const second = highlightFzfMatch("test&escape", [0])
		expect(first).toBe(second)
	})

	it("places non-highlighted text before highlighted at correct boundary", () => {
		const result = highlightFzfMatch("abcde", [2])
		// "ab" should be non-highlighted, "c" highlighted, "de" non-highlighted
		expect(result).toBe('ab<span class="history-item-highlight">c</span>de')
	})
})
