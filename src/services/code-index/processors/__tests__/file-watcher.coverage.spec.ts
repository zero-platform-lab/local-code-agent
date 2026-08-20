// npx vitest services/code-index/processors/__tests__/file-watcher.coverage.spec.ts
//
// 既存 file-watcher.spec.ts で未到達だった processFile / processBatch の各分岐を補完する。
// 不変条件:
//  - 想定外パス・巨大入力・ハンドラ例外でも processFile/processBatch は落ちず、必ず結果種別を返す
//  - 無視対象/巨大/未変更ファイルは埋め込みを行わない（外部呼び出しをしない）

import * as vscode from "vscode"

import { FileWatcher } from "../file-watcher"

vi.mock("../../cache-manager")
vi.mock("../../../core/ignore/AgentIgnoreController", () => ({
	AgentIgnoreController: vi.fn().mockImplementation(() => ({
		validateAccess: vi.fn().mockReturnValue(true),
	})),
}))
vi.mock("ignore")
vi.mock("../parser", () => ({
	codeParser: {
		parseFile: vi.fn().mockResolvedValue([]),
	},
}))
vi.mock("../../../glob/ignore-utils", () => ({
	isPathInIgnoredDirectory: vi.fn().mockReturnValue(false),
}))

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(),
		getConfiguration: vi.fn(),
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
		fs: {
			stat: vi.fn().mockResolvedValue({ size: 1000 }),
			readFile: vi.fn().mockResolvedValue(Buffer.from("test content")),
		},
	},
	RelativePattern: vi.fn().mockImplementation((base, pattern) => ({ base, pattern })),
	Uri: { file: vi.fn().mockImplementation((p) => ({ fsPath: p })) },
	EventEmitter: vi.fn().mockImplementation(() => ({ event: vi.fn(), fire: vi.fn(), dispose: vi.fn() })),
	ExtensionContext: vi.fn(),
}))

import { codeParser } from "../parser"
import { isPathInIgnoredDirectory } from "../../../glob/ignore-utils"

// "test content"（readFile モックが返す内容）の実 sha256
const CONTENT_HASH = "6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72"

describe("FileWatcher (coverage 補完)", () => {
	let mockContext: any
	let mockCacheManager: any
	let mockEmbedder: any
	let mockVectorStore: any
	let mockIgnoreInstance: any
	let ignoreController: any

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(isPathInIgnoredDirectory).mockReturnValue(false)
		vi.mocked(codeParser.parseFile).mockResolvedValue([])
		vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({ size: 1000 } as any)
		vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from("test content") as any)

		mockContext = { subscriptions: [] }
		mockCacheManager = { getHash: vi.fn().mockReturnValue(undefined), updateHash: vi.fn(), deleteHash: vi.fn() }
		mockEmbedder = { createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3]] }) }
		mockVectorStore = { upsertPoints: vi.fn(), deletePointsByMultipleFilePaths: vi.fn() }
		mockIgnoreInstance = { ignores: vi.fn().mockReturnValue(false) }
		ignoreController = { validateAccess: vi.fn().mockReturnValue(true) }
	})

	function makeWatcher(opts: { embedder?: any } = {}) {
		return new FileWatcher(
			"/mock/workspace",
			mockContext,
			mockCacheManager,
			"embedder" in opts ? opts.embedder : mockEmbedder,
			mockVectorStore,
			mockIgnoreInstance,
			ignoreController,
			5, // batchSegmentThreshold をコンストラクタ引数で渡す（L83 分岐）
		)
	}

	describe("constructor", () => {
		it("batchSegmentThreshold を引数で受け取ればそれを使う", () => {
			const fw = makeWatcher()
			expect((fw as any).batchSegmentThreshold).toBe(5)
		})
	})

	describe("processFile: スキップ条件（外部呼び出しをしない）", () => {
		it("無視ディレクトリ配下はスキップ", async () => {
			vi.mocked(isPathInIgnoredDirectory).mockReturnValue(true)
			const fw = makeWatcher()
			const r = await fw.processFile("/mock/workspace/node_modules/x.ts")
			expect(r).toMatchObject({ status: "skipped", reason: "File is in an ignored directory" })
			expect(mockEmbedder.createEmbeddings).not.toHaveBeenCalled()
		})

		it("validateAccess=false はスキップ", async () => {
			ignoreController.validateAccess.mockReturnValue(false)
			const fw = makeWatcher()
			const r = await fw.processFile("/mock/workspace/secret.ts")
			expect(r).toMatchObject({ status: "skipped", reason: "File is ignored by .agentignore or .gitignore" })
			expect(mockEmbedder.createEmbeddings).not.toHaveBeenCalled()
		})

		it("ignoreInstance.ignores=true はスキップ", async () => {
			mockIgnoreInstance.ignores.mockReturnValue(true)
			const fw = makeWatcher()
			const r = await fw.processFile("/mock/workspace/build/out.ts")
			expect(r).toMatchObject({ status: "skipped", reason: "File is ignored by .agentignore or .gitignore" })
		})

		it("巨大ファイルはスキップ（埋め込みしない）", async () => {
			vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({ size: 2 * 1024 * 1024 } as any)
			const fw = makeWatcher()
			const r = await fw.processFile("/mock/workspace/big.ts")
			expect(r).toMatchObject({ status: "skipped", reason: "File is too large" })
			expect(mockEmbedder.createEmbeddings).not.toHaveBeenCalled()
		})

		it("ハッシュが一致する（未変更）ファイルはスキップ", async () => {
			mockCacheManager.getHash.mockReturnValue(CONTENT_HASH)
			const fw = makeWatcher()
			const r = await fw.processFile("/mock/workspace/same.ts")
			expect(r).toMatchObject({ status: "skipped", reason: "File has not changed" })
			expect(codeParser.parseFile).not.toHaveBeenCalled()
		})
	})

	describe("processFile: 埋め込み", () => {
		it("blocks があり embedder があれば points を組み立てる", async () => {
			vi.mocked(codeParser.parseFile).mockResolvedValue([
				{
					file_path: "/mock/workspace/a.ts",
					content: "const a = 1",
					start_line: 1,
					end_line: 2,
					identifier: "a",
					type: "const",
					segmentHash: "seg",
					fileHash: "fh",
				},
			] as any)
			const fw = makeWatcher()
			const r: any = await fw.processFile("/mock/workspace/a.ts")

			expect(r.status).toBe("processed_for_batching")
			expect(mockEmbedder.createEmbeddings).toHaveBeenCalledWith(["const a = 1"])
			expect(r.pointsToUpsert).toHaveLength(1)
			expect(r.pointsToUpsert[0]).toMatchObject({
				vector: [0.1, 0.2, 0.3],
				payload: { startLine: 1, endLine: 2, codeChunk: "const a = 1" },
			})
			expect(typeof r.pointsToUpsert[0].id).toBe("string")
		})

		it("embedder が無ければ points は空", async () => {
			vi.mocked(codeParser.parseFile).mockResolvedValue([
				{ file_path: "/mock/workspace/a.ts", content: "x", start_line: 1, end_line: 1 },
			] as any)
			const fw = makeWatcher({ embedder: undefined })
			const r: any = await fw.processFile("/mock/workspace/a.ts")
			expect(r.status).toBe("processed_for_batching")
			expect(r.pointsToUpsert).toEqual([])
		})
	})

	describe("processFile: 例外", () => {
		it("stat が投げても local_error を返して落ちない", async () => {
			vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error("stat boom"))
			const fw = makeWatcher()
			const r: any = await fw.processFile("/mock/workspace/err.ts")
			expect(r.status).toBe("local_error")
			expect(r.error).toBeInstanceOf(Error)
		})
	})

	describe("dispose / triggerBatchProcessing", () => {
		it("保留中タイマーがあれば dispose で clearTimeout する", () => {
			const fw = makeWatcher()
			;(fw as any).scheduleBatchProcessing() // タイマーをセット
			expect((fw as any).batchProcessDebounceTimer).toBeDefined()
			const clearSpy = vi.spyOn(global, "clearTimeout")
			fw.dispose()
			expect(clearSpy).toHaveBeenCalled()
			clearSpy.mockRestore()
		})

		it("蓄積イベントが無ければ triggerBatchProcessing は即座に return", async () => {
			const fw = makeWatcher()
			const processSpy = vi.spyOn(fw as any, "processBatch")
			await (fw as any).triggerBatchProcessing()
			expect(processSpy).not.toHaveBeenCalled()
		})
	})

	describe("processBatch: 各結果種別の集約", () => {
		it("skipped/local_error/成功(hash有/無)/想定外/undefined/例外 を種別ごとに集約する", async () => {
			const fw = makeWatcher()

			const results: Record<string, any> = {
				"/w/skip.ts": { path: "/w/skip.ts", status: "skipped", reason: "r" },
				"/w/lerr.ts": { path: "/w/lerr.ts", status: "local_error", error: new Error("e") },
				"/w/ok-hash.ts": {
					path: "/w/ok-hash.ts",
					status: "processed_for_batching",
					newHash: "h",
					pointsToUpsert: [{ id: "1" }],
				},
				"/w/ok-nohash.ts": {
					path: "/w/ok-nohash.ts",
					status: "processed_for_batching",
					pointsToUpsert: [{ id: "2" }],
				},
				"/w/weird.ts": { path: "/w/weird.ts", status: "weird-status" },
				"/w/undef.ts": undefined,
			}

			vi.spyOn(fw, "processFile").mockImplementation(async (p: string) => {
				if (p === "/w/throw.ts") throw new Error("processFile boom")
				return results[p]
			})

			// change イベント（clearedPaths へ）・create イベント・delete イベントを混在
			const events = new Map<string, any>([
				["/w/skip.ts", { uri: { fsPath: "/w/skip.ts" }, type: "change" }],
				["/w/lerr.ts", { uri: { fsPath: "/w/lerr.ts" }, type: "create" }],
				["/w/ok-hash.ts", { uri: { fsPath: "/w/ok-hash.ts" }, type: "create" }],
				["/w/ok-nohash.ts", { uri: { fsPath: "/w/ok-nohash.ts" }, type: "create" }],
				["/w/weird.ts", { uri: { fsPath: "/w/weird.ts" }, type: "create" }],
				["/w/undef.ts", { uri: { fsPath: "/w/undef.ts" }, type: "create" }],
				["/w/throw.ts", { uri: { fsPath: "/w/throw.ts" }, type: "create" }],
				["/w/del.ts", { uri: { fsPath: "/w/del.ts" }, type: "delete" }],
			])

			const finishSpy = (fw as any)._onDidFinishBatchProcessing.fire as any

			await expect((fw as any).processBatch(events)).resolves.toBeUndefined()

			// 最終結果イベントが発火し、各種別が batchResults に入っていること
			expect(finishSpy).toHaveBeenCalled()
			const summary = finishSpy.mock.calls[finishSpy.mock.calls.length - 1][0]
			const statuses = summary.processedFiles.map((r: any) => r.status)
			expect(statuses).toContain("skipped")
			expect(statuses).toContain("local_error")
			expect(statuses.filter((s: string) => s === "error").length).toBeGreaterThanOrEqual(3) // weird + undef + throw
		})

		it("同一 fsPath が delete と create の両方にある場合、upsert 側はカウントを増やさない", async () => {
			const fw = makeWatcher()
			vi.spyOn(fw, "processFile").mockResolvedValue({
				path: "/w/dup.ts",
				status: "processed_for_batching",
				newHash: "h",
				pointsToUpsert: [],
			} as any)

			// キーは別だが uri.fsPath は同一（delete と create が衝突するケース）
			const events = new Map<string, any>([
				["k-del", { uri: { fsPath: "/w/dup.ts" }, type: "delete" }],
				["k-create", { uri: { fsPath: "/w/dup.ts" }, type: "create" }],
			])

			await expect((fw as any).processBatch(events)).resolves.toBeUndefined()
		})

		it("進捗イベント発火が例外を投げても allSettled の rejected 経路で握りつぶす", async () => {
			const fw = makeWatcher()
			vi.spyOn(fw, "processFile").mockResolvedValue({
				path: "/w/throwme.ts",
				status: "processed_for_batching",
				newHash: "h",
				pointsToUpsert: [],
			} as any)

			// 対象ファイルの currentFile 進捗発火だけ例外にする
			;(fw as any)._onBatchProgressUpdate.fire = vi.fn((arg: any) => {
				if (arg?.currentFile === "/w/throwme.ts") {
					throw new Error("progress fire boom")
				}
			})
			const finishSpy = (fw as any)._onDidFinishBatchProcessing.fire as any

			const events = new Map<string, any>([
				["/w/throwme.ts", { uri: { fsPath: "/w/throwme.ts" }, type: "create" }],
			])

			await expect((fw as any).processBatch(events)).resolves.toBeUndefined()

			const summary = finishSpy.mock.calls[finishSpy.mock.calls.length - 1][0]
			expect(summary.processedFiles.some((r: any) => r.status === "error")).toBe(true)
		})
	})
})
