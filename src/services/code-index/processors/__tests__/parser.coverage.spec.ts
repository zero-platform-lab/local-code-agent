// npx vitest services/code-index/processors/__tests__/parser.coverage.spec.ts
//
// 既存 parser.spec.ts / parser.vb.spec.ts で未到達だった分岐を補完する。
// 不変条件:
//  - パーサのロード失敗・パース失敗（tree=null）・未対応でも落ちず [] か fallback を返す
//  - 巨大ノード（子あり/葉）や識別子解決、markdown の欠損キャプチャでも安全に処理する

import { CodeParser } from "../parser"
import { loadRequiredLanguageParsers } from "../../../tree-sitter/languageParser"
import { parseMarkdown } from "../../../tree-sitter/markdownParser"

vi.mock("../../../tree-sitter/languageParser")
vi.mock("../../../tree-sitter/markdownParser")

// tree-sitter ノード風のオブジェクトを作るヘルパ
function makeNode(opts: {
	text: string
	children?: any[]
	nameField?: { text: string } | null
	type?: string
	startRow?: number
	endRow?: number
}): any {
	return {
		text: opts.text,
		children: opts.children ?? [],
		childForFieldName: vi.fn().mockReturnValue(opts.nameField ?? null),
		type: opts.type ?? "node",
		startPosition: { row: opts.startRow ?? 0 },
		endPosition: { row: opts.endRow ?? 0 },
	}
}

// loadedParsers に注入する擬似 language
function injectLanguage(parser: CodeParser, ext: string, captures: any[], treeIsNull = false) {
	;(parser as any).loadedParsers[ext] = {
		parser: { parse: vi.fn().mockReturnValue(treeIsNull ? null : { rootNode: makeNode({ text: "root" }) }) },
		query: { captures: vi.fn().mockReturnValue(captures) },
	}
}

describe("CodeParser (coverage 補完)", () => {
	let parser: CodeParser

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "warn").mockImplementation(() => {})
		parser = new CodeParser()
	})

	describe("parseContent: パーサのロード（pendingLoads）", () => {
		it("保留中ロードが成功すればそれを待つ（loadRequiredLanguageParsers を再実行しない）", async () => {
			// pendingLoads に解決済み Promise をセット（成功だが loadedParsers はマージされない経路）
			;(parser as any).pendingLoads.set("js", Promise.resolve({}))
			const result = await (parser as any).parseContent("test.js", "short", "hash")
			expect(result).toEqual([]) // language 未解決 → []
			expect(loadRequiredLanguageParsers).not.toHaveBeenCalled()
		})

		it("保留中ロードが失敗したら [] を返して落ちない", async () => {
			;(parser as any).pendingLoads.set("js", Promise.reject(new Error("pending load failed")))
			const result = await (parser as any).parseContent("test.js", "short", "hash")
			expect(result).toEqual([])
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("pending parser load"),
				expect.anything(),
			)
		})
	})

	describe("parseContent: tree=null でも fallback へ", () => {
		it("parser.parse が null を返しても captures 空扱いで fallback chunking する", async () => {
			const bigContent = Array(20).fill("this line has enough characters to matter in fallback").join("\n")
			injectLanguage(parser, "js", [], /* treeIsNull */ true)
			const result = await (parser as any).parseContent("test.js", bigContent, "hash")
			expect(result.length).toBeGreaterThan(0)
			expect(result[0].type).toBe("fallback_chunk")
		})
	})

	describe("parseContent: 巨大ノードと識別子解決", () => {
		it("MAX を超えるノードは子があれば子を、葉なら行チャンクに分解し、識別子を解決する", async () => {
			const huge = "x".repeat(1200) // > MAX_BLOCK_CHARS(1000)*1.15

			// 1) 子ありの巨大ノード（子を queue に積む）。子は通常ブロック（childForFieldName で識別子解決）
			const childWithName = makeNode({
				text: "function named() { return 42; } // padding to exceed fifty characters!!",
				nameField: { text: "named" },
				type: "function_declaration",
			})
			const bigWithChildren = makeNode({ text: huge, children: [childWithName], type: "program" })

			// 2) 子なしの巨大ノード（葉 → 行チャンク）。各行は短く、総量で 1150 超（type=big_leaf のチャンク）
			const leafText = Array(30).fill("some code line content used as padding here").join("\n")
			const bigLeaf = makeNode({ text: leafText, children: [], type: "big_leaf", endRow: 29 })

			// 3) children.find(identifier) 経由で識別子解決する通常ノード
			const idChild = makeNode({ text: "id", type: "identifier" })
			const nodeWithIdentifierChild = makeNode({
				text: "const value = computeSomethingImportant(); // ensure over fifty chars here!!",
				children: [idChild],
				nameField: null,
				type: "lexical_declaration",
			})

			injectLanguage(parser, "js", [
				{ node: bigWithChildren },
				{ node: bigLeaf },
				{ node: nodeWithIdentifierChild },
			])

			const result = await (parser as any).parseContent("test.js", "irrelevant", "hash")

			// 子ノードの識別子が解決されている
			expect(result.some((b: any) => b.identifier === "named")).toBe(true)
			// children.find 経由の識別子
			expect(result.some((b: any) => b.identifier === "id")).toBe(true)
			// 葉の巨大ノードは行チャンク（type = ノードの type）に分解
			expect(result.some((b: any) => b.type === "big_leaf")).toBe(true)
		})
	})

	describe("processMarkdownSection: 同一ハッシュは重複排除して []", () => {
		it("同じ内容で二度呼ぶと二度目は空配列", () => {
			const lines = [
				"This is a markdown section with more than fifty characters of content here.",
				"Second line adds more content to comfortably exceed the minimum threshold.",
			]
			const seen = new Set<string>()
			const first = (parser as any).processMarkdownSection(lines, "test.md", "hash", "markdown_content", seen, 1)
			expect(first).toHaveLength(1)
			// 同一引数の二度目は seenSegmentHashes により重複排除 → []
			const second = (parser as any).processMarkdownSection(lines, "test.md", "hash", "markdown_content", seen, 1)
			expect(second).toEqual([])
		})
	})

	describe("parseMarkdownContent: 欠損・不定形キャプチャ", () => {
		it("parseMarkdown が null を返しても全体を 1 セクションとして処理する", async () => {
			const content = Array(6).fill("A markdown paragraph line with sufficient length to be indexed.").join("\n")
			vi.mocked(parseMarkdown).mockReturnValue(null as any)
			const result = await parser.parseFile("test.md", { content })
			expect(result.length).toBeGreaterThan(0)
			expect(result[0].type).toBe("markdown_content")
		})

		it("キャプチャ数が奇数だと最後のペア欠損で break する", async () => {
			const content = `# H1
Section one content that is definitely longer than fifty characters for indexing.
More content here to be safe about the minimum block size threshold requirement.`
			// 3 件（奇数）: 最後の name に対応する definition が無く i+1>=length で break
			vi.mocked(parseMarkdown).mockReturnValue([
				{
					node: { startPosition: { row: 0 }, endPosition: { row: 2 }, text: "H1" },
					name: "name.definition.header.h1",
					patternIndex: 0,
				},
				{
					node: { startPosition: { row: 0 }, endPosition: { row: 2 }, text: "H1" },
					name: "definition.header.h1",
					patternIndex: 0,
				},
				{
					node: { startPosition: { row: 0 }, endPosition: { row: 0 }, text: "dangling" },
					name: "name.definition.header.h2",
					patternIndex: 0,
				},
			] as any)
			const result = await parser.parseFile("test.md", { content })
			expect(Array.isArray(result)).toBe(true)
		})

		it("definition キャプチャが falsy なら continue し、ヘッダ名に .hN が無ければ level=1 として扱う", async () => {
			const content = `intro line long enough to be considered a valid pre-header block for indexing.
another intro line to comfortably exceed the fifty character minimum threshold.
# NoLevelHeader
Body content under a header whose name does not end with a .hN suffix pattern here.
More body content to make sure this section clears the minimum size requirement.`
			// index1(definition) を null にして continue、その後 .hN を持たない name で level=1 経路を通す
			vi.mocked(parseMarkdown).mockReturnValue([
				{
					node: { startPosition: { row: 2 }, endPosition: { row: 4 }, text: "NoLevelHeader" },
					name: "name.definition.header.h1",
					patternIndex: 0,
				},
				null,
				{
					node: { startPosition: { row: 2 }, endPosition: { row: 4 }, text: "NoLevelHeader" },
					name: "name.definition.section",
					patternIndex: 0,
				},
				{
					node: { startPosition: { row: 2 }, endPosition: { row: 4 }, text: "NoLevelHeader" },
					name: "definition.section",
					patternIndex: 0,
				},
			] as any)
			const result = await parser.parseFile("test.md", { content })
			// level=1 経路（.hN 無し）で markdown_header_h1 のブロックが生成される
			expect(result.some((b: any) => b.type === "markdown_header_h1")).toBe(true)
		})
	})
})
