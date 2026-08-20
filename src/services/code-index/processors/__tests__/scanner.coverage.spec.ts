// npx vitest services/code-index/processors/__tests__/scanner.coverage.spec.ts
//
// 既存 scanner.spec.ts で未到達だった分岐（バッチ投入・バックプレッシャ・リトライ・
// 削除処理のエラー・中断）を補完する。
// 不変条件:
//  - 走査は想定外パス・巨大バッチ・埋め込み失敗でも落ちず、失敗は onError で通知される
//  - 埋め込み/アップサートは本物のネットワークに出ない（全モック）
//  - 中断(signal)されたら以降の外部操作を行わない

import { DirectoryScanner } from "../scanner"
import { stat } from "fs/promises"

vi.mock("fs/promises", () => ({
	default: { readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), access: vi.fn(), rename: vi.fn(), constants: {} },
	stat: vi.fn(),
}))

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
		getWorkspaceFolder: vi.fn().mockReturnValue({ uri: { fsPath: "/mock/workspace" } }),
		fs: { readFile: vi.fn().mockResolvedValue(Buffer.from("test content")) },
	},
	Uri: { file: vi.fn().mockImplementation((p) => p) },
	window: { activeTextEditor: { document: { uri: { fsPath: "/mock/workspace" } } } },
}))

vi.mock("../../../../core/ignore/AgentIgnoreController")
vi.mock("ignore")
vi.mock("../../../glob/list-files", () => ({ listFiles: vi.fn() }))

// "test content" の実 sha256（未変更スキップ判定に使う）
const CONTENT_HASH = "6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72"

function makeStats(size: number): any {
	return { size, isFile: () => true, isDirectory: () => false }
}

function block(overrides: Partial<any> = {}): any {
	return {
		file_path: "src/a.js",
		content: "function a() { return 1 }",
		start_line: 1,
		end_line: 3,
		identifier: "a",
		type: "function",
		fileHash: "fh",
		segmentHash: "seg-" + Math.random(),
		...overrides,
	}
}

describe("DirectoryScanner (coverage 補完)", () => {
	let embedder: any
	let qdrant: any
	let codeParser: any
	let cache: any
	let ignoreInstance: any

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.spyOn(console, "error").mockImplementation(() => {})
		embedder = { createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2]] }) }
		qdrant = {
			upsertPoints: vi.fn().mockResolvedValue(undefined),
			deletePointsByFilePath: vi.fn().mockResolvedValue(undefined),
			deletePointsByMultipleFilePaths: vi.fn().mockResolvedValue(undefined),
		}
		codeParser = { parseFile: vi.fn().mockResolvedValue([]) }
		cache = {
			getHash: vi.fn().mockReturnValue(undefined),
			getAllHashes: vi.fn().mockReturnValue({}),
			updateHash: vi.fn().mockResolvedValue(undefined),
			deleteHash: vi.fn().mockResolvedValue(undefined),
		}
		ignoreInstance = { ignores: vi.fn().mockReturnValue(false) }
		vi.mocked(stat).mockResolvedValue(makeStats(1024))
		const { listFiles } = await import("../../../glob/list-files")
		vi.mocked(listFiles).mockResolvedValue([["src/a.js"], false])
	})

	function makeScanner(threshold?: number) {
		return new DirectoryScanner(embedder, qdrant, codeParser, cache, ignoreInstance, threshold)
	}

	describe("コンストラクタ", () => {
		it("batchSegmentThreshold を引数で受け取ればそれを使う", () => {
			const s = makeScanner(7)
			expect((s as any).batchSegmentThreshold).toBe(7)
		})
	})

	describe("未変更ファイルのスキップ", () => {
		it("キャッシュのハッシュが一致すればスキップする（パースしない）", async () => {
			cache.getHash.mockReturnValue(CONTENT_HASH)
			const s = makeScanner()
			const result = await s.scanDirectory("/test")
			expect(result.stats.skipped).toBe(1)
			expect(codeParser.parseFile).not.toHaveBeenCalled()
		})
	})

	describe("ファイル処理中の例外は onError で通知", () => {
		it("stat が Error を投げたら onError に workspace/file 付きで通知", async () => {
			vi.mocked(stat).mockRejectedValue(new Error("stat failed"))
			const onError = vi.fn()
			const s = makeScanner()
			await s.scanDirectory("/test", onError)
			expect(onError).toHaveBeenCalledTimes(1)
			expect(onError.mock.calls[0][0].message).toContain("stat failed")
		})

		it("Error 以外を投げても onError に既定メッセージで通知（落ちない）", async () => {
			vi.mocked(stat).mockRejectedValue("weird non-error")
			const onError = vi.fn()
			const s = makeScanner()
			await expect(s.scanDirectory("/test", onError)).resolves.toBeDefined()
			expect(onError).toHaveBeenCalledTimes(1)
		})
	})

	describe("バッチ投入（閾値到達）", () => {
		it("threshold=1 で各ブロックがバッチ投入され、コールバックが呼ばれる", async () => {
			codeParser.parseFile.mockResolvedValue([block(), block()])
			const onFileParsed = vi.fn()
			const onBlocksIndexed = vi.fn()
			const s = makeScanner(1)

			await s.scanDirectory("/test", undefined, onBlocksIndexed, onFileParsed)

			expect(onFileParsed).toHaveBeenCalledWith(2)
			expect(embedder.createEmbeddings).toHaveBeenCalled()
			expect(qdrant.upsertPoints).toHaveBeenCalled()
			expect(onBlocksIndexed).toHaveBeenCalled()
		})
	})

	describe("バックプレッシャ（MAX_PENDING_BATCHES 到達で待機）", () => {
		it("threshold=1 で大量ブロックを投入すると待機ループを通過して完了する", async () => {
			// 25 ブロック・埋め込みは少し遅延させ、保留バッチが上限(20)に達して待機ループへ入る。
			// 中断されていない signal を渡し、待機ループ内 signal?.aborted の「signal あり」経路も通す。
			const controller = new AbortController()
			const blocks = Array.from({ length: 25 }, () => block())
			codeParser.parseFile.mockResolvedValue(blocks)
			embedder.createEmbeddings.mockImplementation(
				() => new Promise((res) => setTimeout(() => res({ embeddings: [[0.1, 0.2]] }), 5)),
			)
			const s = makeScanner(1)

			const result = await s.scanDirectory("/test", undefined, undefined, undefined, controller.signal)

			expect(result.stats.processed).toBe(1)
			// 25 ブロック分の埋め込みが行われた
			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(25)
		}, 15000)
	})

	describe("削除処理", () => {
		it("qdrantClient が無ければ削除済みファイルの処理をスキップ", async () => {
			// embedder/qdrant なしの scanner（qdrantClient falsy 分岐）
			const s = new DirectoryScanner(null as any, null as any, codeParser, cache, ignoreInstance)
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([[], false])
			cache.getAllHashes.mockReturnValue({ "old/file.js": "h" })

			await expect(s.scanDirectory("/test")).resolves.toBeDefined()
			expect(qdrant.deletePointsByFilePath).not.toHaveBeenCalled()
		})

		it("削除の失敗は onError で通知して走査は継続", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([[], false])
			cache.getAllHashes.mockReturnValue({ "old/file.js": "h" })
			qdrant.deletePointsByFilePath.mockRejectedValue(new Error("delete failed"))
			const onError = vi.fn()
			const s = makeScanner()

			await s.scanDirectory("/test", onError)

			expect(qdrant.deletePointsByFilePath).toHaveBeenCalledWith("old/file.js")
			expect(onError).toHaveBeenCalledTimes(1)
			expect(onError.mock.calls[0][0].message).toContain("delete failed")
		})

		it("削除が Error 以外で失敗しても onError で通知（落ちない）", async () => {
			const { listFiles } = await import("../../../glob/list-files")
			vi.mocked(listFiles).mockResolvedValue([[], false])
			cache.getAllHashes.mockReturnValue({ "old/file.js": "h" })
			qdrant.deletePointsByFilePath.mockRejectedValue("string delete failure")
			const onError = vi.fn()
			const s = makeScanner()

			await expect(s.scanDirectory("/test", onError)).resolves.toBeDefined()
			expect(onError).toHaveBeenCalledTimes(1)
		})
	})

	describe("中断（signal）: バッチ処理後に中断されたら削除処理を行わない", () => {
		it("埋め込み中に中断されると削除済みファイル処理へ進まず即 return", async () => {
			const controller = new AbortController()
			codeParser.parseFile.mockResolvedValue([block()])
			cache.getAllHashes.mockReturnValue({ "old/file.js": "h" })
			// 埋め込み中に中断（268 の時点では未中断・313 の時点で中断済み）
			embedder.createEmbeddings.mockImplementation(async () => {
				controller.abort()
				return { embeddings: [[0.1, 0.2]] }
			})
			const s = makeScanner() // 既定 threshold（残バッチ経路）

			const result = await s.scanDirectory("/test", undefined, undefined, undefined, controller.signal)

			expect(result.stats.processed).toBe(1)
			// 中断済みなので削除処理は行われない
			expect(qdrant.deletePointsByFilePath).not.toHaveBeenCalled()
		})
	})

	describe("processBatch を直接検証", () => {
		it("空バッチは即 return（外部呼び出しなし）", async () => {
			const s = makeScanner()
			await (s as any).processBatch([], [], [], "/test")
			expect(embedder.createEmbeddings).not.toHaveBeenCalled()
			expect(qdrant.upsertPoints).not.toHaveBeenCalled()
		})

		it("変更ファイル(isNew=false)は先に削除してから埋め込み・アップサート・ハッシュ更新", async () => {
			const s = makeScanner()
			const onBlocksIndexed = vi.fn()
			await (s as any).processBatch(
				[block({ file_path: "src/mod.js" })],
				["function a() { return 1 }"],
				[{ filePath: "src/mod.js", fileHash: "newhash", isNew: false }],
				"/test",
				undefined,
				onBlocksIndexed,
			)
			expect(qdrant.deletePointsByMultipleFilePaths).toHaveBeenCalledWith(["src/mod.js"])
			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(1)
			expect(qdrant.upsertPoints).toHaveBeenCalledTimes(1)
			expect(cache.updateHash).toHaveBeenCalledWith("src/mod.js", "newhash")
			expect(onBlocksIndexed).toHaveBeenCalledWith(1)
		})

		it("削除の失敗はリトライ上限まで試行し、最終的に onError で通知", async () => {
			qdrant.deletePointsByMultipleFilePaths.mockRejectedValue(new Error("del boom"))
			const onError = vi.fn()
			const s = makeScanner()

			await (s as any).processBatch(
				[block({ file_path: "src/mod.js" })],
				["text"],
				[{ filePath: "src/mod.js", fileHash: "h", isNew: false }],
				"/test",
				onError,
			)

			// MAX_BATCH_RETRIES(3) 回試行
			expect(qdrant.deletePointsByMultipleFilePaths).toHaveBeenCalledTimes(3)
			expect(embedder.createEmbeddings).not.toHaveBeenCalled()
			expect(onError).toHaveBeenCalledTimes(1)
		}, 15000)

		it("削除が Error 以外で失敗しても String 化してリトライ・最終的に onError", async () => {
			qdrant.deletePointsByMultipleFilePaths.mockRejectedValue("string del failure")
			const onError = vi.fn()
			const s = makeScanner()

			await (s as any).processBatch(
				[block({ file_path: "src/mod.js" })],
				["text"],
				[{ filePath: "src/mod.js", fileHash: "h", isNew: false }],
				"/test",
				onError,
			)

			expect(qdrant.deletePointsByMultipleFilePaths).toHaveBeenCalledTimes(3)
			expect(onError).toHaveBeenCalledTimes(1)
		}, 15000)

		it("message を持たない失敗では 'Unknown error' として onError に渡す", async () => {
			// message が空の Error → lastError.message || 'Unknown error' の else 側
			embedder.createEmbeddings.mockRejectedValue(new Error(""))
			const onError = vi.fn()
			const s = makeScanner()

			await (s as any).processBatch(
				[block()],
				["text"],
				[{ filePath: "src/a.js", fileHash: "h", isNew: true }],
				"/test",
				onError,
			)

			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(3)
			expect(onError).toHaveBeenCalledTimes(1)
		}, 15000)

		it("埋め込みの失敗は onError 未指定でもリトライ上限まで試行して静かに諦める", async () => {
			embedder.createEmbeddings.mockRejectedValue(new Error("embed boom"))
			const s = makeScanner()

			// onError を渡さない（if(onError) の false 分岐）
			await (s as any).processBatch(
				[block()],
				["text"],
				[{ filePath: "src/a.js", fileHash: "h", isNew: true }],
				"/test",
			)

			expect(embedder.createEmbeddings).toHaveBeenCalledTimes(3)
			expect(qdrant.upsertPoints).not.toHaveBeenCalled()
		}, 15000)
	})
})
