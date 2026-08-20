import { describe, it, expect } from "vitest"
import { formatToolInvocation } from "../toolResultFormatting"

describe("toolResultFormatting", () => {
	describe("formatToolInvocation", () => {
		it("should format", () => {
			const result = formatToolInvocation("read_file", { path: "test.ts" })

			expect(result).toBe("Called read_file with path: test.ts")
			expect(result).not.toContain("<")
		})

		it("should handle multiple parameters", () => {
			const result = formatToolInvocation("read_file", { path: "test.ts", start_line: "1" })

			expect(result).toContain("Called read_file with")
			expect(result).toContain("path: test.ts")
			expect(result).toContain("start_line: 1")
		})

		it("should handle empty parameters", () => {
			const result = formatToolInvocation("list_files", {})
			expect(result).toBe("Called list_files")
		})

		// 文字列以外の値は JSON.stringify で整形する（三項演算子の else 側）。
		it("JSON-stringifies non-string values (numbers, booleans, objects, arrays)", () => {
			const result = formatToolInvocation("edit", {
				count: 3,
				replace_all: true,
				options: { deep: 1 },
				lines: [1, 2],
			})

			expect(result).toContain("count: 3")
			expect(result).toContain("replace_all: true")
			expect(result).toContain('options: {"deep":1}')
			expect(result).toContain("lines: [1,2]")
		})
	})
})
