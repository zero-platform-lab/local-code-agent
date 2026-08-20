// npx vitest services/code-index/vector-store/__tests__/qdrant-client.coverage.spec.ts
//
// 既存 qdrant-client.spec.ts で未到達だったメソッド/分岐を補完する。
// 不変条件:
//  - 本物のネットワークには一切出さない（QdrantClient を全モック）
//  - 削除系は「コレクションが無ければ何もしない」「失敗しても投げずにログのみ（deletePointsByMultipleFilePaths）」
//  - メタデータ書き込み(markIndexing*)は失敗時に必ず投げる

import { QdrantClient } from "@qdrant/js-client-rest"
import { createHash } from "crypto"

import { QdrantVectorStore } from "../qdrant-client"

vitest.mock("@qdrant/js-client-rest")
vitest.mock("crypto")
vitest.mock("../../../../i18n", () => ({
	t: (key: string, params?: any) => (params ? `${key}:${JSON.stringify(params)}` : key),
}))
vitest.mock("path", async () => {
	const actual = await vitest.importActual("path")
	return { ...(actual as any), sep: "/", posix: (actual as any).posix }
})

const mockClient = {
	getCollection: vitest.fn(),
	createCollection: vitest.fn(),
	deleteCollection: vitest.fn(),
	createPayloadIndex: vitest.fn(),
	upsert: vitest.fn(),
	query: vitest.fn(),
	delete: vitest.fn(),
	retrieve: vitest.fn(),
}

const mockHash = {
	update: vitest.fn().mockReturnThis(),
	digest: vitest.fn(),
}

describe("QdrantVectorStore (coverage 補完)", () => {
	const workspacePath = "/test/workspace"
	const url = "http://mock-qdrant:6333"
	const vectorSize = 1536
	const hashed = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
	const collectionName = `ws-${hashed.substring(0, 16)}`
	let store: QdrantVectorStore

	beforeEach(() => {
		vitest.clearAllMocks()
		;(QdrantClient as any).mockImplementation(() => mockClient)
		;(createHash as any).mockReturnValue(mockHash)
		mockHash.update.mockReturnValue(mockHash)
		mockHash.digest.mockReturnValue(hashed)
		vitest.spyOn(console, "error").mockImplementation(() => {})
		vitest.spyOn(console, "warn").mockImplementation(() => {})
		vitest.spyOn(console, "log").mockImplementation(() => {})
		store = new QdrantVectorStore(workspacePath, url, vectorSize, "key")
	})

	afterEach(() => {
		vitest.restoreAllMocks()
	})

	describe("constructor: URL パース失敗時のフォールバック", () => {
		it("new URL が二段で失敗する不正 URL では url ベース設定にフォールバックする", () => {
			// "https://exa mple.com": parseQdrantUrl の new URL で失敗 → parseHostname("https://exa mple.com")
			// （":" を含み "http" 始まりなのでそのまま返す） → constructor の new URL でも失敗 → catch(url ベース)
			const bad = "https://exa mple.com"
			const s = new QdrantVectorStore(workspacePath, bad, vectorSize, "key")

			expect(QdrantClient).toHaveBeenLastCalledWith({
				url: bad,
				apiKey: "key",
				headers: { "User-Agent": "Agent" },
			})
			expect((s as any).qdrantUrl).toBe(bad)
		})
	})

	describe("initialize: 既存コレクションの vectors 設定パターン", () => {
		it("vectors が数値で一致していれば再作成せず false", async () => {
			mockClient.getCollection.mockResolvedValue({
				config: { params: { vectors: vectorSize } }, // 数値パターン
			} as any)
			mockClient.createPayloadIndex.mockResolvedValue({} as any)

			const result = await store.initialize()

			expect(result).toBe(false)
			expect(mockClient.createCollection).not.toHaveBeenCalled()
		})

		it("vectors が未知形式なら既存サイズ 0 とみなして再作成する", async () => {
			mockClient.getCollection
				.mockResolvedValueOnce({ config: { params: { vectors: null } } } as any) // 未知形式 → 0
				.mockRejectedValueOnce({ response: { status: 404 }, message: "Not found" }) // 削除確認
			mockClient.deleteCollection.mockResolvedValue(true as any)
			mockClient.createCollection.mockResolvedValue(true as any)
			mockClient.createPayloadIndex.mockResolvedValue({} as any)

			const result = await store.initialize()

			expect(result).toBe(true)
			expect(mockClient.deleteCollection).toHaveBeenCalledTimes(1)
			expect(mockClient.createCollection).toHaveBeenCalledTimes(1)
		})
	})

	describe("deletePointsByMultipleFilePaths", () => {
		it("空配列なら何もしない（delete 未呼び出し）", async () => {
			await store.deletePointsByMultipleFilePaths([])
			expect(mockClient.delete).not.toHaveBeenCalled()
		})

		it("コレクションが存在しなければ削除をスキップして警告する", async () => {
			// collectionExists() = getCollectionInfo() が null（getCollection が reject）
			mockClient.getCollection.mockRejectedValue({ response: { status: 404 }, message: "nope" })

			await store.deletePointsByMultipleFilePaths(["src/a.ts"])

			expect(mockClient.delete).not.toHaveBeenCalled()
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Skipping deletion"))
		})

		it("相対パス 1 件なら単一フィルタで delete する", async () => {
			mockClient.getCollection.mockResolvedValue({ config: {} } as any) // 存在する
			mockClient.delete.mockResolvedValue({} as any)

			await store.deletePointsByMultipleFilePaths(["src/utils/a.ts"])

			expect(mockClient.delete).toHaveBeenCalledTimes(1)
			const arg = mockClient.delete.mock.calls[0][1]
			expect(arg.wait).toBe(true)
			expect(arg.filter).toEqual({
				must: [
					{ key: "pathSegments.0", match: { value: "src" } },
					{ key: "pathSegments.1", match: { value: "utils" } },
					{ key: "pathSegments.2", match: { value: "a.ts" } },
				],
			})
		})

		it("複数パスなら should でまとめ、絶対パスは workspace 相対に変換する", async () => {
			mockClient.getCollection.mockResolvedValue({ config: {} } as any)
			mockClient.delete.mockResolvedValue({} as any)

			// 絶対パス（/test/workspace/src/b.ts）は relative 変換で "src/b.ts" になる
			await store.deletePointsByMultipleFilePaths(["src/a.ts", "/test/workspace/src/b.ts"])

			const arg = mockClient.delete.mock.calls[0][1]
			expect(arg.filter.should).toHaveLength(2)
			expect(arg.filter.should[1].must).toEqual([
				{ key: "pathSegments.0", match: { value: "src" } },
				{ key: "pathSegments.1", match: { value: "b.ts" } },
			])
		})

		it("delete 失敗時は投げずにログのみ（詳細情報を含む）", async () => {
			mockClient.getCollection.mockResolvedValue({ config: {} } as any)
			const err: any = new Error("boom")
			err.status = 500
			err.response = { data: "server detail" }
			mockClient.delete.mockRejectedValue(err)

			// 例外を投げないこと（削除失敗はインデックス処理を止めない不変条件）
			await expect(store.deletePointsByMultipleFilePaths(["src/a.ts"])).resolves.toBeUndefined()
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to delete points by file paths"),
				expect.objectContaining({ status: 500, details: "server detail" }),
			)
		})
	})

	describe("deletePointsByFilePath", () => {
		it("単一パス版は複数パス版へ委譲する", async () => {
			mockClient.getCollection.mockResolvedValue({ config: {} } as any)
			mockClient.delete.mockResolvedValue({} as any)

			await store.deletePointsByFilePath("src/a.ts")

			expect(mockClient.delete).toHaveBeenCalledTimes(1)
		})
	})

	describe("clearCollection", () => {
		it("成功時は空 must フィルタで全削除する", async () => {
			mockClient.delete.mockResolvedValue({} as any)

			await store.clearCollection()

			expect(mockClient.delete).toHaveBeenCalledWith(collectionName, {
				filter: { must: [] },
				wait: true,
			})
		})

		it("失敗時はログして再スロー", async () => {
			const err = new Error("clear failed")
			mockClient.delete.mockRejectedValue(err)

			await expect(store.clearCollection()).rejects.toThrow(err)
			expect(console.error).toHaveBeenCalledWith("Failed to clear collection:", err)
		})
	})

	describe("hasIndexedData", () => {
		it("コレクションが無ければ false", async () => {
			mockClient.getCollection.mockRejectedValue({ response: { status: 404 }, message: "nf" })
			expect(await store.hasIndexedData()).toBe(false)
		})

		it("points_count が 0 なら false", async () => {
			mockClient.getCollection.mockResolvedValue({ points_count: 0 } as any)
			expect(await store.hasIndexedData()).toBe(false)
		})

		it("完了マーカーが indexing_complete=true なら true", async () => {
			mockClient.getCollection.mockResolvedValue({ points_count: 5 } as any)
			mockClient.retrieve.mockResolvedValue([{ payload: { indexing_complete: true } }] as any)
			expect(await store.hasIndexedData()).toBe(true)
		})

		it("完了マーカーが indexing_complete=false なら false", async () => {
			mockClient.getCollection.mockResolvedValue({ points_count: 5 } as any)
			mockClient.retrieve.mockResolvedValue([{ payload: { indexing_complete: false } }] as any)
			expect(await store.hasIndexedData()).toBe(false)
		})

		it("マーカーが無ければ（旧インデックス互換）points_count>0 で true", async () => {
			mockClient.getCollection.mockResolvedValue({ points_count: 3 } as any)
			mockClient.retrieve.mockResolvedValue([] as any)
			expect(await store.hasIndexedData()).toBe(true)
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("backward compatibility"))
		})

		it("retrieve が失敗しても投げずに false", async () => {
			mockClient.getCollection.mockResolvedValue({ points_count: 5 } as any)
			mockClient.retrieve.mockRejectedValue(new Error("retrieve failed"))
			expect(await store.hasIndexedData()).toBe(false)
			expect(console.warn).toHaveBeenCalledWith(
				expect.stringContaining("Failed to check if collection has data"),
				expect.any(Error),
			)
		})
	})

	describe("markIndexingComplete / markIndexingIncomplete", () => {
		it("markIndexingComplete: indexing_complete=true のメタデータを upsert", async () => {
			mockClient.upsert.mockResolvedValue({} as any)

			await store.markIndexingComplete()

			const arg = mockClient.upsert.mock.calls[0][1]
			expect(arg.wait).toBe(true)
			expect(arg.points[0].payload).toMatchObject({ type: "metadata", indexing_complete: true })
			expect(arg.points[0].vector).toHaveLength(vectorSize)
		})

		it("markIndexingComplete: 失敗時は再スロー", async () => {
			const err = new Error("upsert failed")
			mockClient.upsert.mockRejectedValue(err)
			await expect(store.markIndexingComplete()).rejects.toThrow(err)
		})

		it("markIndexingIncomplete: indexing_complete=false のメタデータを upsert", async () => {
			mockClient.upsert.mockResolvedValue({} as any)

			await store.markIndexingIncomplete()

			const arg = mockClient.upsert.mock.calls[0][1]
			expect(arg.points[0].payload).toMatchObject({ type: "metadata", indexing_complete: false })
		})

		it("markIndexingIncomplete: 失敗時は再スロー", async () => {
			const err = new Error("upsert failed 2")
			mockClient.upsert.mockRejectedValue(err)
			await expect(store.markIndexingIncomplete()).rejects.toThrow(err)
		})
	})

	describe("エラーオブジェクトの形が違うケース（|| / ?? の else 分岐）", () => {
		it("initialize: message を持たない例外でも接続失敗メッセージで投げる", async () => {
			mockClient.getCollection.mockRejectedValue({ response: { status: 404 }, message: "Not found" })
			// message プロパティの無い値で reject（error?.message || error の else 側）
			mockClient.createCollection.mockRejectedValue("plain string failure")

			await expect(store.initialize()).rejects.toThrow(/qdrantConnectionFailed/)
		})

		it("_recreateCollectionWithNewDimension: Error 以外の失敗でも String 化して投げる", async () => {
			mockClient.getCollection.mockResolvedValue({
				config: { params: { vectors: { size: 768 } } }, // サイズ不一致 → 再作成
			} as any)
			// deleteCollection が Error 以外で reject（instanceof Error ? : String() の else 側）
			mockClient.deleteCollection.mockRejectedValue("delete boom string")

			await expect(store.initialize()).rejects.toThrow(/vectorDimensionMismatch/)
		})

		it("_createPayloadIndexes: message 無しの失敗でも握りつぶして警告（|| '' / || indexError）", async () => {
			mockClient.getCollection.mockRejectedValue({ response: { status: 404 }, message: "nf" })
			mockClient.createCollection.mockResolvedValue(true as any)
			// message を持たないオブジェクトで reject
			mockClient.createPayloadIndex.mockRejectedValue({ code: "X" })

			const result = await store.initialize()
			expect(result).toBe(true)
			// 6 個すべて失敗しても initialize は成功する
			expect(console.warn).toHaveBeenCalled()
		})

		it("_createPayloadIndexes: 'already exists' はスキップして警告しない", async () => {
			mockClient.getCollection.mockRejectedValue({ response: { status: 404 }, message: "nf" })
			mockClient.createCollection.mockResolvedValue(true as any)
			mockClient.createPayloadIndex.mockRejectedValue(new Error("index already exists"))

			const result = await store.initialize()
			expect(result).toBe(true)
			// "already exists" は既存とみなし警告しない
			expect(console.warn).not.toHaveBeenCalled()
		})

		it("deletePointsByMultipleFilePaths: status 無し→response.status→statusCode の順に解決", async () => {
			mockClient.getCollection.mockResolvedValue({ config: {} } as any)
			// status も response.status も無く statusCode のみ、response.data 無しで data のみ
			mockClient.delete.mockRejectedValue({ statusCode: 418, data: "top-level-detail" })

			await expect(store.deletePointsByMultipleFilePaths(["src/a.ts"])).resolves.toBeUndefined()
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to delete points by file paths"),
				expect.objectContaining({ status: 418, details: "top-level-detail" }),
			)
		})

		it("deletePointsByMultipleFilePaths: message も status も無い文字列例外は String 化 / details は空", async () => {
			mockClient.getCollection.mockResolvedValue({ config: {} } as any)
			mockClient.delete.mockRejectedValue("bare string error")

			await expect(store.deletePointsByMultipleFilePaths(["src/a.ts"])).resolves.toBeUndefined()
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to delete points by file paths"),
				expect.objectContaining({ error: "bare string error", details: "" }),
			)
		})

		it("deletePointsByMultipleFilePaths: top-level status 無し・response.status 有りを解決", async () => {
			mockClient.getCollection.mockResolvedValue({ config: {} } as any)
			// error.status 無し → error.response.status を採用（中間の || 分岐）
			mockClient.delete.mockRejectedValue({ response: { status: 503, data: "resp-detail" } })

			await expect(store.deletePointsByMultipleFilePaths(["src/a.ts"])).resolves.toBeUndefined()
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to delete points by file paths"),
				expect.objectContaining({ status: 503, details: "resp-detail" }),
			)
		})

		it("hasIndexedData: points_count が無い場合は 0 とみなして false", async () => {
			// points_count 未設定 → (collectionInfo.points_count ?? 0) の ?? 右側
			mockClient.getCollection.mockResolvedValue({ config: {} } as any)
			expect(await store.hasIndexedData()).toBe(false)
		})

		it("hasIndexedData: マーカーの payload が undefined でも false", async () => {
			mockClient.getCollection.mockResolvedValue({ points_count: 5 } as any)
			mockClient.retrieve.mockResolvedValue([{ id: "x" }] as any) // payload なし
			expect(await store.hasIndexedData()).toBe(false)
		})
	})
})
