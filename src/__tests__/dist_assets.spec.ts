// npx vitest __tests__/dist_assets.spec.ts

import * as fs from "fs"
import * as path from "path"

describe("dist assets", () => {
	const distPath = path.join(__dirname, "../dist")

	describe("tiktoken", () => {
		it("should have tiktoken wasm file", () => {
			expect(fs.existsSync(path.join(distPath, "tiktoken_bg.wasm"))).toBe(true)
		})
	})

	describe("tree-sitter", () => {
		// #28 で tree-sitter を主要23言語に絞ったため、配布される wasm は
		// packages/build の SUPPORTED_TREE_SITTER_LANGUAGES と core のみ。
		const treeSitterFiles = [
			"tree-sitter.wasm", // web-tree-sitter core
			"tree-sitter-bash.wasm",
			"tree-sitter-c.wasm",
			"tree-sitter-c_sharp.wasm",
			"tree-sitter-cpp.wasm",
			"tree-sitter-css.wasm",
			"tree-sitter-embedded_template.wasm",
			"tree-sitter-go.wasm",
			"tree-sitter-html.wasm",
			"tree-sitter-java.wasm",
			"tree-sitter-javascript.wasm",
			"tree-sitter-json.wasm",
			"tree-sitter-kotlin.wasm",
			"tree-sitter-php.wasm",
			"tree-sitter-python.wasm",
			"tree-sitter-ruby.wasm",
			"tree-sitter-rust.wasm",
			"tree-sitter-scala.wasm",
			"tree-sitter-swift.wasm",
			"tree-sitter-toml.wasm",
			"tree-sitter-tsx.wasm",
			"tree-sitter-typescript.wasm",
			"tree-sitter-vue.wasm",
			"tree-sitter-yaml.wasm",
		]

		test.each(treeSitterFiles)("should have %s file", (filename) => {
			expect(fs.existsSync(path.join(distPath, filename))).toBe(true)
		})
	})
})
