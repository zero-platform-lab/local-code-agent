import { describe, it, expect, vi, beforeEach } from "vitest"

// バイナリ抽出・ファイル読み取り経路（fs / 外部パーサに依存する部分）を
// すべてモックして検証する。pure 関数のテストは extract-text.spec.ts 側。

vi.mock("fs/promises", () => {
	const api = {
		access: vi.fn(async () => undefined),
		readFile: vi.fn(async () => ""),
	}
	return { ...api, default: api }
})

// pdf-parse は default import（subpath）。pdf(buffer) → { text }
vi.mock("pdf-parse/lib/pdf-parse", () => ({
	default: vi.fn(async () => ({ text: "" })),
}))

vi.mock("mammoth", () => {
	const api = { extractRawText: vi.fn(async () => ({ value: "" })) }
	return { ...api, default: api }
})

vi.mock("isbinaryfile", () => ({
	isBinaryFile: vi.fn(async () => false),
}))

vi.mock("../extract-text-from-xlsx", () => ({
	extractTextFromXLSX: vi.fn(async () => ""),
}))

import fs from "fs/promises"
// @ts-expect-error - pdf-parse は subpath export の型定義を持たない（本体 extract-text.ts と同様）
import pdf from "pdf-parse/lib/pdf-parse"
import mammoth from "mammoth"
import { isBinaryFile } from "isbinaryfile"
import { extractTextFromXLSX } from "../extract-text-from-xlsx"
import { extractTextFromFile, extractTextFromFileWithMetadata, getSupportedBinaryFormats } from "../extract-text"

const mockAccess = vi.mocked(fs.access)
const mockReadFile = vi.mocked(fs.readFile)
const mockPdf = vi.mocked(pdf as unknown as (b: Buffer) => Promise<{ text: string }>)
const mockMammoth = vi.mocked(mammoth.extractRawText)
const mockIsBinary = vi.mocked(isBinaryFile)
const mockXlsx = vi.mocked(extractTextFromXLSX)

beforeEach(() => {
	vi.clearAllMocks()
	mockAccess.mockResolvedValue(undefined)
	mockReadFile.mockResolvedValue("")
	mockIsBinary.mockResolvedValue(false as never)
})

describe("getSupportedBinaryFormats", () => {
	it("対応する拡張子一覧を返す", () => {
		expect(getSupportedBinaryFormats()).toEqual([".pdf", ".docx", ".ipynb", ".xlsx"])
	})
})

describe("extractTextFromFileWithMetadata", () => {
	it("ファイルが無ければ File not found を投げる", async () => {
		mockAccess.mockRejectedValue(new Error("ENOENT"))
		await expect(extractTextFromFileWithMetadata("/nope.txt")).rejects.toThrow("File not found: /nope.txt")
	})

	it("PDF は pdf-parse で抽出し行番号を付ける", async () => {
		mockPdf.mockResolvedValue({ text: "hello\nworld" })
		const result = await extractTextFromFileWithMetadata("/doc.pdf")
		expect(mockPdf).toHaveBeenCalled()
		expect(result.content).toBe("1 | hello\n2 | world\n")
		expect(result.wasTruncated).toBe(false)
		expect(result.totalLines).toBe(result.returnedLines)
	})

	it("DOCX は mammoth で抽出する", async () => {
		mockMammoth.mockResolvedValue({ value: "doc text" } as never)
		const result = await extractTextFromFileWithMetadata("/doc.docx")
		expect(mockMammoth).toHaveBeenCalledWith({ path: "/doc.docx" })
		expect(result.content).toBe("1 | doc text\n")
	})

	it("IPYNB は markdown/code セルだけ連結する（他タイプは無視）", async () => {
		const notebook = {
			cells: [
				{ cell_type: "markdown", source: ["# Title"] },
				{ cell_type: "code", source: ["print(1)"] },
				{ cell_type: "raw", source: ["ignored"] }, // 対象外
				{ cell_type: "code" }, // source なし → 無視
			],
		}
		mockReadFile.mockResolvedValue(JSON.stringify(notebook))
		const result = await extractTextFromFileWithMetadata("/nb.ipynb")
		expect(result.content).toContain("# Title")
		expect(result.content).toContain("print(1)")
		expect(result.content).not.toContain("ignored")
	})

	it("XLSX は extractTextFromXLSX に委譲する", async () => {
		mockXlsx.mockResolvedValue("--- Sheet: S ---\nA\tB")
		const result = await extractTextFromFileWithMetadata("/book.xlsx")
		expect(mockXlsx).toHaveBeenCalledWith("/book.xlsx")
		expect(result.content).toContain("--- Sheet: S ---")
	})

	it("テキストファイルは readWithSlice で切り出し linesShown を付ける", async () => {
		mockIsBinary.mockResolvedValue(false as never)
		mockReadFile.mockResolvedValue("a\nb\nc")
		const result = await extractTextFromFileWithMetadata("/plain.txt", 2)
		expect(result.returnedLines).toBe(2)
		expect(result.wasTruncated).toBe(true)
		expect(result.linesShown).toEqual([1, 2])
	})

	it("isBinaryFile が失敗しても非バイナリ扱いで読む", async () => {
		mockIsBinary.mockRejectedValue(new Error("stat error"))
		mockReadFile.mockResolvedValue("x")
		const result = await extractTextFromFileWithMetadata("/weird")
		// テキスト経路は readWithSlice/formatWithLineNumbers 由来なので末尾改行は付かない
		expect(result.content).toBe("1 | x")
	})

	it("未対応のバイナリは読めない旨を投げる", async () => {
		mockIsBinary.mockResolvedValue(true as never)
		await expect(extractTextFromFileWithMetadata("/image.bin")).rejects.toThrow("Cannot read text for file type: ")
	})
})

describe("extractTextFromFile", () => {
	it("メタデータ無しで content 文字列を返す", async () => {
		mockIsBinary.mockResolvedValue(false as never)
		mockReadFile.mockResolvedValue("only line")
		const content = await extractTextFromFile("/plain.txt")
		expect(content).toBe("1 | only line")
	})
})
