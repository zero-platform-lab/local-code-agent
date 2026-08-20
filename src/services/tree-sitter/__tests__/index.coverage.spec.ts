// parseSourceCodeDefinitionsForFile / parseFile / processCaptures の分岐を、
// 本物の tree-sitter wasm を起動せずに検証する。
// languageParser は丸ごとモックし、パーサ/クエリは「消費側が参照するプロパティだけ持つ」
// フェイクを注入する。これで AST 生成・パースの実処理を走らせずに processCaptures の
// 各分岐（行数不足スキップ・出力ゼロ・パース例外など）へ到達できる。

import type { QueryCapture } from "web-tree-sitter"

const { mockFileExists, mockReadFile, mockLoadParsers } = vi.hoisted(() => ({
	mockFileExists: vi.fn(),
	mockReadFile: vi.fn(),
	mockLoadParsers: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	readFile: mockReadFile,
	default: { readFile: mockReadFile },
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: mockFileExists,
}))

vi.mock("../languageParser", () => ({
	loadRequiredLanguageParsers: mockLoadParsers,
}))

// 型注釈でのみ使う重いモジュールを実ロードしないための保険。
vi.mock("../../../core/ignore/AgentIgnoreController", () => ({
	AgentIgnoreController: class {},
}))

import { parseSourceCodeDefinitionsForFile, setMinComponentLines } from ".."

// 消費側（processCaptures / parseFile）が参照する最小フェイクを作るヘルパ群。
const fakeController = (allow: boolean) => ({ validateAccess: vi.fn().mockReturnValue(allow) }) as any

const makeCapture = (name: string, startRow: number, endRow: number, parent?: any): QueryCapture =>
	({
		node: { startPosition: { row: startRow }, endPosition: { row: endRow }, text: "X", parent },
		name,
	}) as unknown as QueryCapture

// captures を返すフェイク query と、tree の有無を制御できるフェイク parser。
const fakeParsers = (captures: QueryCapture[], opts: { tree?: unknown; parseThrows?: boolean } = {}) => ({
	ts: {
		parser: {
			parse: vi.fn(() => {
				if (opts.parseThrows) throw new Error("parse boom")
				return "tree" in opts ? opts.tree : { rootNode: {} }
			}),
		},
		query: { captures: vi.fn(() => captures) },
	},
})

describe("parseSourceCodeDefinitionsForFile 分岐", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockFileExists.mockResolvedValue(true)
		setMinComponentLines(4)
	})

	it("ファイルが存在しなければ案内文を返す（92-94 行）", async () => {
		mockFileExists.mockResolvedValue(false)
		const result = await parseSourceCodeDefinitionsForFile("/x/missing.ts")
		expect(result).toBe("This file does not exist or you do not have permission to access it.")
	})

	it("未対応拡張子は undefined（99-101 行）", async () => {
		const result = await parseSourceCodeDefinitionsForFile("/x/file.unknownext")
		expect(result).toBeUndefined()
	})

	it("markdown で ignore に弾かれると undefined（106-108 行）", async () => {
		const result = await parseSourceCodeDefinitionsForFile("/x/readme.md", fakeController(false))
		expect(result).toBeUndefined()
		// 弾かれたので読みに行かない
		expect(mockReadFile).not.toHaveBeenCalled()
	})

	it("markdown の定義を抽出して見出し付きで返す", async () => {
		setMinComponentLines(0)
		mockReadFile.mockResolvedValue("# Title\ncontent\n\n## Section\nmore\n")
		const result = await parseSourceCodeDefinitionsForFile("/x/doc.md")
		expect(result).toContain("# doc.md")
		expect(result).toContain("Title")
	})

	it("markdown で定義が無ければ undefined（122 分岐の偽側 → 125 行）", async () => {
		mockReadFile.mockResolvedValue("") // 空 → parseMarkdown が [] → 定義なし
		const result = await parseSourceCodeDefinitionsForFile("/x/empty.md")
		expect(result).toBeUndefined()
	})

	it("パーサのロードに失敗したら握りつぶして undefined（135-140 行）", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		mockReadFile.mockResolvedValue("const a = 1")
		mockLoadParsers.mockRejectedValue(new Error("wasm load failed"))
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts")
		expect(result).toBeUndefined()
	})

	it("パーサのロードが非 Error で失敗しても握りつぶして undefined（137 行の : error 側）", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		mockReadFile.mockResolvedValue("const a = 1")
		mockLoadParsers.mockRejectedValue("plain-string-failure")
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts")
		expect(result).toBeUndefined()
	})

	it("parseFile が ignore で弾かれると undefined（300-302 行 → 146-149 行）", async () => {
		mockReadFile.mockResolvedValue("const a = 1")
		mockLoadParsers.mockResolvedValue(fakeParsers([]))
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts", fakeController(false))
		expect(result).toBeUndefined()
	})

	it("パーサ/クエリが無ければ Unsupported file type を返す（309-312 行, !parser 側）", async () => {
		mockReadFile.mockResolvedValue("const a = 1")
		mockLoadParsers.mockResolvedValue({}) // ts エントリ無し
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts")
		expect(result).toContain("Unsupported file type")
	})

	it("query だけ無い場合も Unsupported file type（309-312 行, !query 側）", async () => {
		mockReadFile.mockResolvedValue("const a = 1")
		mockLoadParsers.mockResolvedValue({ ts: { parser: { parse: vi.fn() } } }) // query undefined
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts")
		expect(result).toContain("Unsupported file type")
	})

	it("行数が最小未満の定義はスキップされ、出力ゼロなら undefined（229-231, 281-284 行）", async () => {
		mockReadFile.mockResolvedValue("only-one-line")
		// 1 行 span の definition capture。min=4 未満なのでスキップ → 出力空 → null → undefined
		mockLoadParsers.mockResolvedValue(fakeParsers([makeCapture("definition.function", 0, 0)]))
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts")
		expect(result).toBeUndefined()
	})

	it("tree が null のときは空 captures 経由で undefined（319 行の : [] 側）", async () => {
		mockReadFile.mockResolvedValue("const a = 1")
		mockLoadParsers.mockResolvedValue(fakeParsers([], { tree: null }))
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts")
		expect(result).toBeUndefined()
	})

	it("parse が例外を投げたら握りつぶして undefined（326-330 行）", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {})
		mockReadFile.mockResolvedValue("const a = 1")
		mockLoadParsers.mockResolvedValue(fakeParsers([], { parseThrows: true }))
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts")
		expect(result).toBeUndefined()
	})

	it("name.definition キャプチャはコンポーネント名を出力する（246-255 行）", async () => {
		setMinComponentLines(2)
		mockReadFile.mockResolvedValue("function Comp() {\n  return null\n}\n")
		// name を含むので definitionNode = node.parent。親の行範囲でスパンを判定する。
		const capture = {
			node: {
				startPosition: { row: 0 },
				endPosition: { row: 0 },
				text: "Comp",
				parent: { startPosition: { row: 0 }, endPosition: { row: 2 } },
			},
			name: "name.definition.function",
		} as unknown as QueryCapture
		mockLoadParsers.mockResolvedValue(fakeParsers([capture]))
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts")
		expect(result).toContain("# file.ts")
		expect(result).toContain("function Comp()")
	})

	it("十分な行数の定義があれば見出し付きで返す（happy path, 144-145 行）", async () => {
		setMinComponentLines(2)
		mockReadFile.mockResolvedValue("function big() {\n  return 1\n}\n")
		mockLoadParsers.mockResolvedValue(fakeParsers([makeCapture("definition.function", 0, 2)]))
		const result = await parseSourceCodeDefinitionsForFile("/x/file.ts")
		expect(result).toContain("# file.ts")
		expect(result).toContain("function big()")
	})
})
