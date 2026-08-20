import { CODEBASE_INDEX_DEFAULTS } from "@openai-agent/types"

import {
	MAX_BLOCK_CHARS,
	MIN_BLOCK_CHARS,
	MIN_CHUNK_REMAINDER_CHARS,
	MAX_CHARS_TOLERANCE_FACTOR,
	DEFAULT_SEARCH_MIN_SCORE,
	DEFAULT_MAX_SEARCH_RESULTS,
	QDRANT_CODE_BLOCK_NAMESPACE,
	MAX_FILE_SIZE_BYTES,
	MAX_LIST_FILES_LIMIT_CODE_INDEX,
	BATCH_SEGMENT_THRESHOLD,
	MAX_BATCH_RETRIES,
	INITIAL_RETRY_DELAY_MS,
	PARSING_CONCURRENCY,
	MAX_PENDING_BATCHES,
	MAX_BATCH_TOKENS,
	MAX_ITEM_TOKENS,
	BATCH_PROCESSING_CONCURRENCY,
	GEMINI_MAX_ITEM_TOKENS,
} from "../index"

// 定数モジュールは実行時に export 文をすべて評価するため、
// import して値を突き合わせるだけでモジュール本体の網羅ができる。
describe("code-index constants", () => {
	it("パーサ関連の定数が想定値であること", () => {
		expect(MAX_BLOCK_CHARS).toBe(1000)
		expect(MIN_BLOCK_CHARS).toBe(50)
		expect(MIN_CHUNK_REMAINDER_CHARS).toBe(200)
		expect(MAX_CHARS_TOLERANCE_FACTOR).toBe(1.15)
	})

	it("検索既定値が @openai-agent/types の既定と一致すること", () => {
		// ハードコードの重複ではなく出所（types パッケージ）との一致を検証する
		expect(DEFAULT_SEARCH_MIN_SCORE).toBe(CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE)
		expect(DEFAULT_MAX_SEARCH_RESULTS).toBe(CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS)
	})

	it("ファイルウォッチャ関連の定数が想定値であること", () => {
		expect(QDRANT_CODE_BLOCK_NAMESPACE).toBe("f47ac10b-58cc-4372-a567-0e02b2c3d479")
		expect(MAX_FILE_SIZE_BYTES).toBe(1 * 1024 * 1024)
	})

	it("ディレクトリスキャナ関連の定数が想定値であること", () => {
		expect(MAX_LIST_FILES_LIMIT_CODE_INDEX).toBe(50_000)
		expect(BATCH_SEGMENT_THRESHOLD).toBe(60)
		expect(MAX_BATCH_RETRIES).toBe(3)
		expect(INITIAL_RETRY_DELAY_MS).toBe(500)
		expect(PARSING_CONCURRENCY).toBe(10)
		expect(MAX_PENDING_BATCHES).toBe(20)
	})

	it("埋め込み関連の定数が想定値であること", () => {
		expect(MAX_BATCH_TOKENS).toBe(100000)
		expect(MAX_ITEM_TOKENS).toBe(8191)
		expect(BATCH_PROCESSING_CONCURRENCY).toBe(10)
		expect(GEMINI_MAX_ITEM_TOKENS).toBe(2048)
	})
})
