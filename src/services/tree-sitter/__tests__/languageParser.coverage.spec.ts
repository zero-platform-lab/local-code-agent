import * as path from "path"

import { extensions } from "../index"
import { loadRequiredLanguageParsers } from "../languageParser"

/**
 * 対応拡張子が実際にパースできることを保証する回帰テスト。
 *
 * 過去に2種類の壊れ方をしている:
 *   1. 同梱していない wasm を読もうとして ENOENT（削除済み言語の拡張子マッピングが残っていた）
 *   2. 文法と噛み合わないクエリを渡して Query 構築で例外（scala に lua のクエリを流用していた）
 *
 * どちらも「対応しているはずの拡張子のファイルを開くと落ちる」形で表面化する。
 * extensions / languageParser の switch / 同梱 wasm の3つが揃っていれば、ここは緑になる。
 */

// tree-sitter を通らない拡張子。
// md / markdown は index.ts が switch の手前で parseMarkdown に流す。
// vb は tree-sitter パーサを持たず、code-index の fallback chunking 専用で extensions に入っている。
const NOT_PARSED_BY_TREE_SITTER = new Set([".md", ".markdown", ".vb"])

describe("loadRequiredLanguageParsers", () => {
	// テストは src ディレクトリから実行される。wasm は bundle が src/dist に配置する。
	const wasmDirectory = path.join(process.cwd(), "dist")
	const parsableExtensions = extensions.filter((ext) => !NOT_PARSED_BY_TREE_SITTER.has(ext))

	it("対象の拡張子が1つ以上ある", () => {
		expect(parsableExtensions.length).toBeGreaterThan(0)
	})

	it.each(parsableExtensions)("%s のパーサとクエリを構築できる", async (ext) => {
		const parsers = await loadRequiredLanguageParsers([`sample${ext}`], wasmDirectory)

		expect(Object.keys(parsers).length).toBeGreaterThan(0)
		for (const { parser, query } of Object.values(parsers)) {
			expect(parser).toBeDefined()
			expect(query).toBeDefined()
		}
	})
})
