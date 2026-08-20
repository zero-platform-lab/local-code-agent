import { formatMarkdownCaptures, parseMarkdown } from "../markdownParser"
import type { QueryCapture } from "web-tree-sitter"

// formatMarkdownCaptures の早期 return 分岐を明示的に埋める。
// 実 wasm は使わず、消費側が参照するプロパティだけ持つ最小 capture を組み立てる。
describe("formatMarkdownCaptures の境界", () => {
	// name/definition のペアを模した最小 capture を作る（consuming code は
	// node.startPosition/endPosition/text と name のみ参照する）。
	const makeCapture = (name: string, startRow: number, endRow: number, text: string): QueryCapture =>
		({
			node: {
				startPosition: { row: startRow },
				endPosition: { row: endRow },
				text,
			},
			name,
		}) as unknown as QueryCapture

	it("空配列は null を返す（195-197 行）", () => {
		expect(formatMarkdownCaptures([])).toBeNull()
	})

	it("どのセクションも minSectionLines に満たない場合は null を返す（226 行）", () => {
		// definition capture（奇数 index）の span が 1 行 < 既定 4 行 → 出力ゼロ → null。
		const captures = [
			makeCapture("name.definition.header.h1", 0, 0, "Title"),
			makeCapture("definition.header.h1", 0, 0, "Title"),
		]
		expect(formatMarkdownCaptures(captures)).toBeNull()
	})

	it("minSectionLines を満たすセクションは出力される（回帰確認）", () => {
		const captures = [
			makeCapture("name.definition.header.h2", 0, 5, "Big"),
			makeCapture("definition.header.h2", 0, 5, "Big"),
		]
		const out = formatMarkdownCaptures(captures, 3)
		expect(out).toContain("## Big")
	})

	it("巨大入力でも parseMarkdown が落ちない", () => {
		const huge = Array.from({ length: 20000 }, (_, i) => `# Header ${i}\ncontent`).join("\n")
		expect(() => parseMarkdown(huge)).not.toThrow()
	})
})
