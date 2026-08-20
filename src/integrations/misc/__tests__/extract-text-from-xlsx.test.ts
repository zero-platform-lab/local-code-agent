import { promises as fs } from "fs"
import os from "os"
import path from "path"
import ExcelJS from "exceljs"
import { extractTextFromXLSX } from "../extract-text-from-xlsx"

describe("extractTextFromXLSX", () => {
	describe("basic functionality", () => {
		it("should extract text with proper formatting", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = "Hello"
			worksheet.getCell("B1").value = "World"
			worksheet.getCell("A2").value = "Test"
			worksheet.getCell("B2").value = 123

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Sheet1 ---")
			expect(result).toContain("Hello\tWorld")
			expect(result).toContain("Test\t123")
		})

		it("should skip rows with no content", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = "Row 1"
			// Row 2 is completely empty
			worksheet.getCell("A3").value = "Row 3"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Row 1")
			expect(result).toContain("Row 3")
			// Should not contain empty rows
			expect(result).not.toMatch(/\n\t*\n/)
		})
	})

	describe("sheet handling", () => {
		it("should process multiple sheets", async () => {
			const workbook = new ExcelJS.Workbook()

			const sheet1 = workbook.addWorksheet("First Sheet")
			sheet1.getCell("A1").value = "Sheet 1 Data"

			const sheet2 = workbook.addWorksheet("Second Sheet")
			sheet2.getCell("A1").value = "Sheet 2 Data"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: First Sheet ---")
			expect(result).toContain("Sheet 1 Data")
			expect(result).toContain("--- Sheet: Second Sheet ---")
			expect(result).toContain("Sheet 2 Data")
		})

		it("should skip hidden sheets", async () => {
			const workbook = new ExcelJS.Workbook()

			const visibleSheet = workbook.addWorksheet("Visible Sheet")
			visibleSheet.getCell("A1").value = "Visible Data"

			const hiddenSheet = workbook.addWorksheet("Hidden Sheet")
			hiddenSheet.getCell("A1").value = "Hidden Data"
			hiddenSheet.state = "hidden"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Visible Sheet ---")
			expect(result).toContain("Visible Data")
			expect(result).not.toContain("--- Sheet: Hidden Sheet ---")
			expect(result).not.toContain("Hidden Data")
		})

		it("should skip very hidden sheets", async () => {
			const workbook = new ExcelJS.Workbook()

			const visibleSheet = workbook.addWorksheet("Visible Sheet")
			visibleSheet.getCell("A1").value = "Visible Data"

			const veryHiddenSheet = workbook.addWorksheet("Very Hidden Sheet")
			veryHiddenSheet.getCell("A1").value = "Very Hidden Data"
			veryHiddenSheet.state = "veryHidden"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Visible Sheet ---")
			expect(result).toContain("Visible Data")
			expect(result).not.toContain("--- Sheet: Very Hidden Sheet ---")
			expect(result).not.toContain("Very Hidden Data")
		})
	})

	describe("formatCellValue logic", () => {
		it("should handle null and undefined values", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = "Before"
			worksheet.getCell("A2").value = null
			worksheet.getCell("A3").value = undefined
			worksheet.getCell("A4").value = "After"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Before")
			expect(result).toContain("After")
			// Should handle null/undefined as empty strings
			const lines = result.split("\n")
			const dataLines = lines.filter((line) => !line.startsWith("---") && line.trim())
			expect(dataLines).toHaveLength(2) // Only 'Before' and 'After' should create content
		})

		it("内容のある行にまじった null セルは空文字として出力される", async () => {
			// 行が空でないと eachRow に載らず formatCellValue(null) が呼ばれない。
			// 両端に値を置いて中央セルを null にし、null→"" の分岐を通す。
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")
			worksheet.getCell("A1").value = "left"
			worksheet.getCell("C1").value = "right"
			// B1 は未設定なので value は null

			const result = await extractTextFromXLSX(workbook)

			// null セルは "" になり、タブ区切りで left <tab> "" <tab> right
			expect(result).toContain("left\t\tright")
		})

		it("上限行数を超えた行は打ち切り、以降を出力しない", async () => {
			// ROW_LIMIT(=50000) 超えの分岐。スパースな高位セルで実 ExcelJS のまま再現する
			// （物理的に 5 万行を作らない）。
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Big")
			worksheet.getCell("A1").value = "top"
			worksheet.getCell("A50001").value = "overflow"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("top")
			expect(result).toContain("[... truncated at row 50001 ...]")
			expect(result).not.toContain("overflow")
		})

		it("should format dates correctly", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			const testDate = new Date("2023-12-25")
			worksheet.getCell("A1").value = testDate

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("2023-12-25")
		})

		it("should handle error values", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = { error: "#DIV/0!" }

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("[Error: #DIV/0!]")
		})

		it("should handle rich text", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = {
				richText: [{ text: "Hello " }, { text: "World", font: { bold: true } }],
			}

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Hello World")
		})

		it("should handle hyperlinks", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = {
				text: "Agent",
				hyperlink: "https://github.com/example-org/local-agent/",
			}

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Agent (https://github.com/example-org/local-agent/)")
		})

		it("should handle formulas with and without results", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = { formula: "A2+A3", result: 30 }
			worksheet.getCell("A2").value = { formula: "SUM(B1:B10)" }

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("30") // Formula with result
			expect(result).toContain("[Formula: SUM(B1:B10)]") // Formula without result
		})
	})

	describe("edge cases", () => {
		it("should handle empty workbook", async () => {
			const workbook = new ExcelJS.Workbook()
			workbook.addWorksheet("Empty Sheet")

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Empty Sheet ---")
			expect(result.trim()).toBe("--- Sheet: Empty Sheet ---")
		})

		it("should handle workbook with only empty cells", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			// Set cells but leave them empty
			worksheet.getCell("A1").value = ""
			worksheet.getCell("B1").value = ""

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Sheet1 ---")
			// Should not contain any data rows since empty strings don't count as content
			const lines = result.split("\n").filter((line) => line.trim() && !line.startsWith("---"))
			expect(lines).toHaveLength(0)
		})
	})

	describe("function overloads", () => {
		it("should work with workbook objects", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Test")
			worksheet.getCell("A1").value = "Test Data"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Test Data")
		})

		it("should reject invalid file paths", async () => {
			await expect(extractTextFromXLSX("/non/existent/file.xlsx")).rejects.toThrow()
		})

		it("ファイルパス文字列を渡すと readFile 経由で読める", async () => {
			// string 分岐（new Workbook + xlsx.readFile）を実ファイルで通す。
			// 書き込み先はテンポラリ領域に限定し、成功・失敗どちらでも finally で必ず消す。
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("FromFile")
			worksheet.getCell("A1").value = "persisted"

			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xlsx-spec-"))
			const filePath = path.join(dir, "book.xlsx")
			// 不変条件: 生成パスがテンポラリ配下から出ていないこと
			expect(filePath.startsWith(os.tmpdir())).toBe(true)
			try {
				await workbook.xlsx.writeFile(filePath)

				const result = await extractTextFromXLSX(filePath)

				expect(result).toContain("--- Sheet: FromFile ---")
				expect(result).toContain("persisted")
			} finally {
				await fs.rm(dir, { recursive: true, force: true })
			}
		})
	})
})
