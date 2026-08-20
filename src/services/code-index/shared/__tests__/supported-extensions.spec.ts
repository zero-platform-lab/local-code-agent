// tree-sitter 本体は重い依存（web-tree-sitter/wasm ローダ等）を巻き込むため、
// ここでは拡張子一覧だけを差し替えたモックに置き換える。
// supported-extensions.ts の scannerExtensions は tree-sitter の extensions を
// そのまま再輸出しているだけなので、この差し替えで挙動は変わらない。
vitest.mock("../../../tree-sitter", () => ({
	extensions: [".ts", ".vb", ".scala", ".swift"],
}))

import { scannerExtensions, fallbackExtensions, shouldUseFallbackChunking } from "../supported-extensions"

describe("supported-extensions", () => {
	describe("モジュールの再輸出", () => {
		it("scannerExtensions は tree-sitter の extensions をそのまま再輸出する", () => {
			expect(scannerExtensions).toEqual([".ts", ".vb", ".scala", ".swift"])
		})

		it("fallbackExtensions は既定の 3 種を含む", () => {
			expect(fallbackExtensions).toEqual([".vb", ".scala", ".swift"])
		})
	})

	describe("shouldUseFallbackChunking", () => {
		it("fallback 対象の拡張子は true を返す", () => {
			expect(shouldUseFallbackChunking(".vb")).toBe(true)
			expect(shouldUseFallbackChunking(".scala")).toBe(true)
			expect(shouldUseFallbackChunking(".swift")).toBe(true)
		})

		it("大文字の拡張子でも小文字化して判定する", () => {
			expect(shouldUseFallbackChunking(".VB")).toBe(true)
			expect(shouldUseFallbackChunking(".Scala")).toBe(true)
		})

		it("fallback 対象外の拡張子は false を返す", () => {
			expect(shouldUseFallbackChunking(".ts")).toBe(false)
			expect(shouldUseFallbackChunking(".py")).toBe(false)
		})

		it("空文字など想定外入力でも例外を投げず false を返す", () => {
			expect(shouldUseFallbackChunking("")).toBe(false)
		})
	})
})
