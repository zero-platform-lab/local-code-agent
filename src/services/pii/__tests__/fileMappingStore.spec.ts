import { describe, expect, it, vi } from "vitest"

// store が実行時に使う vscode は `Uri.joinPath` だけである。fs・時計・上限は注入する。
vi.mock("vscode", () => ({
	Uri: {
		joinPath(base: { path: string }, ...parts: string[]) {
			return { path: [base.path.replace(/\/$/, ""), ...parts].join("/") }
		},
	},
}))

import {
	DEFAULT_FILE_MAPPING_LIMITS,
	FileMappingStore,
	type FileMappingEntry,
	type FileMappingLimits,
} from "../fileMappingStore"

type Uri = { path: string }

/** 記憶内のファイル。store が使う操作だけを持つ。rename は上書きで移す。 */
function memoryFs() {
	const files = new Map<string, Uint8Array>()
	let ioError: string | undefined
	return {
		files,
		fail(message: string | undefined) {
			ioError = message
		},
		fs: {
			async readFile(uri: Uri) {
				if (ioError) throw new Error(ioError)
				const value = files.get(uri.path)
				if (value) return value
				const error = new Error(uri.path)
				error.name = "FileNotFound"
				throw error
			},
			async writeFile(uri: Uri, value: Uint8Array) {
				if (ioError) throw new Error(ioError)
				files.set(uri.path, Uint8Array.from(value))
			},
			async createDirectory() {},
			async rename(from: Uri, to: Uri, _options?: { overwrite?: boolean }) {
				const value = files.get(from.path)
				if (!value) throw new Error("missing temporary file")
				files.set(to.path, value)
				files.delete(from.path)
			},
			async delete(uri: Uri) {
				files.delete(uri.path)
			},
		},
	}
}

const ROOT: Uri = { path: "/state" }
const TARGET = "/state/file-mapping.v1.json"

const entry = (n: number, value: string): FileMappingEntry => [`{{email-${String(n).padStart(3, "0")}}}`, value]
const readTarget = (disk: ReturnType<typeof memoryFs>) => Buffer.from(disk.files.get(TARGET)!).toString("utf8")

function setup(options: { now?: () => Date; limits?: () => FileMappingLimits } = {}) {
	const disk = memoryFs()
	const make = () => new FileMappingStore(ROOT as never, disk.fs as never, options.now, options.limits)
	return { disk, make, store: make() }
}

describe("FileMappingStore", () => {
	describe("保存して読み戻せる", () => {
		it("保存した対応を読み戻せる", async () => {
			const { store } = setup()
			const record = await store.save("0:a.md", [entry(1, "森下")])
			expect(record.entries).toEqual([entry(1, "森下")])
			expect((await store.load("0:a.md"))?.entries).toEqual([entry(1, "森下")])
		})

		it("平文の JSON で残す（暗号化しない）", async () => {
			const { store, disk } = setup()
			await store.save("0:a.md", [entry(1, "森下")])
			const raw = readTarget(disk)
			// 同じ PII は元のファイルやタスク履歴にも平文である。ここも平文で置く。
			expect(raw).toContain("森下")
			expect(JSON.parse(raw).formatVersion).toBe(1)
		})

		it("別の store 実体でも、同じファイルなら読める", async () => {
			const { make, store } = setup()
			await store.save("0:a.md", [entry(1, "森下")])
			expect((await make().load("0:a.md"))?.entries).toEqual([entry(1, "森下")])
		})

		it(".gitignore を保管ディレクトリへ置く（万一 git 配下でも残さない）", async () => {
			const { store, disk } = setup()
			await store.save("0:a.md", [entry(1, "森下")])
			expect(Buffer.from(disk.files.get("/state/.gitignore")!).toString("utf8")).toBe("*\n")
		})
	})

	describe("壊れ・版違いは、誤った値ではなく失敗を出す", () => {
		it("JSON にならなければ corrupt", async () => {
			const { make, disk } = setup()
			disk.files.set(TARGET, Buffer.from("これは JSON ではない", "utf8"))
			await expect(make().load("0:a.md")).rejects.toMatchObject({ name: "FileMappingError", code: "corrupt" })
		})

		it("形が壊れていれば corrupt", async () => {
			const { make, disk } = setup()
			disk.files.set(TARGET, Buffer.from(JSON.stringify({ formatVersion: 1, files: { "0:a.md": {} } }), "utf8"))
			await expect(make().load("0:a.md")).rejects.toMatchObject({ name: "FileMappingError", code: "corrupt" })
		})

		it("版が違えば unsupported", async () => {
			const { make, disk } = setup()
			disk.files.set(TARGET, Buffer.from(JSON.stringify({ formatVersion: 2, files: {} }), "utf8"))
			await expect(make().load("0:a.md")).rejects.toMatchObject({ name: "FileMappingError", code: "unsupported" })
		})
	})

	describe("保存は upsert", () => {
		it("無ければ作り、あれば足し合わせ、同じ伏せ字は上書きする", async () => {
			const { store } = setup()
			await store.save("0:a.md", [entry(1, "森下")])
			await store.save("0:a.md", [entry(2, "神南")])
			await store.save("0:a.md", [entry(1, "林")])
			expect((await store.load("0:a.md"))?.entries).toEqual([entry(1, "林"), entry(2, "神南")])
		})
	})

	describe("最終利用の記録", () => {
		it("load すると lastUsedAt が進む", async () => {
			let clock = new Date("2026-01-01T00:00:00Z")
			const { store } = setup({ now: () => clock })
			await store.save("0:a.md", [entry(1, "森下")])
			clock = new Date("2026-01-02T00:00:00Z")
			const loaded = await store.load("0:a.md")
			expect(loaded?.lastUsedAt).toBe("2026-01-02T00:00:00.000Z")
			expect(loaded?.savedAt).toBe("2026-01-01T00:00:00.000Z")
		})

		it("無いファイルの load は undefined", async () => {
			const { store } = setup()
			expect(await store.load("0:none.md")).toBeUndefined()
		})
	})

	describe("消去", () => {
		it("1 件を消す", async () => {
			const { store } = setup()
			await store.save("0:a.md", [entry(1, "森下"), entry(2, "林")])
			expect(await store.delete("0:a.md")).toBe(2)
			expect(await store.load("0:a.md")).toBeUndefined()
			expect(await store.delete("0:a.md")).toBe(0)
		})

		it("複数を消し、ファイル数と対応数を返す", async () => {
			const { store } = setup()
			await store.save("0:a.md", [entry(1, "森下")])
			await store.save("0:b.md", [entry(1, "林"), entry(2, "神南")])
			expect(await store.deleteMany(["0:a.md", "0:b.md", "0:none.md"])).toEqual({ files: 2, entries: 3 })
		})
	})

	describe("移動・削除への追従", () => {
		it("ファイル 1 つの識別子を移す", async () => {
			const { store } = setup()
			await store.save("0:a.md", [entry(1, "森下")])
			expect(await store.movePath("0:a.md", "0:b.md")).toBe(1)
			expect(await store.load("0:a.md")).toBeUndefined()
			expect((await store.load("0:b.md"))?.entries).toEqual([entry(1, "森下")])
		})

		it("ディレクトリ以下をまとめて移す", async () => {
			const { store } = setup()
			await store.save("0:dir/a.md", [entry(1, "森下")])
			await store.save("0:dir/sub/b.md", [entry(1, "林")])
			await store.save("0:other.md", [entry(1, "神南")])
			expect(await store.movePath("0:dir", "0:moved")).toBe(2)
			expect((await store.load("0:moved/a.md"))?.entries).toEqual([entry(1, "森下")])
			expect((await store.load("0:moved/sub/b.md"))?.entries).toEqual([entry(1, "林")])
			expect((await store.load("0:other.md"))?.entries).toEqual([entry(1, "神南")])
		})

		it("ディレクトリ以下をまとめて削除する", async () => {
			const { store } = setup()
			await store.save("0:dir/a.md", [entry(1, "森下")])
			await store.save("0:dir/b.md", [entry(1, "林")])
			await store.save("0:keep.md", [entry(1, "神南")])
			expect(await store.deletePath("0:dir")).toEqual({ files: 2, entries: 2 })
			expect(await store.load("0:keep.md")).toBeDefined()
		})
	})

	describe("期限切れと存在しないファイルの掃除", () => {
		it("最終利用から保持期間を過ぎたものを消す", async () => {
			let clock = new Date("2026-01-01T00:00:00Z")
			const { store } = setup({ now: () => clock })
			await store.save("0:a.md", [entry(1, "森下")])
			clock = new Date("2026-02-15T00:00:00Z") // 45 日後
			expect(await store.prune(30, async () => true)).toEqual({ expired: 1, missing: 0 })
			expect(await store.load("0:a.md")).toBeUndefined()
		})

		it("存在しないファイルを消し、確認できないものは残す", async () => {
			const { store } = setup()
			await store.save("0:gone.md", [entry(1, "森下")])
			await store.save("0:unknown.md", [entry(1, "林")])
			const result = await store.prune(0, async (id) => (id === "0:gone.md" ? false : undefined))
			expect(result).toEqual({ expired: 0, missing: 1 })
			expect(await store.load("0:gone.md")).toBeUndefined()
			expect(await store.load("0:unknown.md")).toBeDefined()
		})

		it("保持期間 0 は時間で消さない", async () => {
			let clock = new Date("2026-01-01T00:00:00Z")
			const { store } = setup({ now: () => clock })
			await store.save("0:a.md", [entry(1, "森下")])
			clock = new Date("2030-01-01T00:00:00Z")
			expect(await store.prune(0, async () => true)).toEqual({ expired: 0, missing: 0 })
			expect(await store.load("0:a.md")).toBeDefined()
		})
	})

	describe("上限に達したら、黙って捨てず失敗する", () => {
		it("ファイル数の上限", async () => {
			const limits = { ...DEFAULT_FILE_MAPPING_LIMITS, maxFiles: 1 }
			const { store } = setup({ limits: () => limits })
			await store.save("0:a.md", [entry(1, "森下")])
			await expect(store.save("0:b.md", [entry(1, "林")])).rejects.toMatchObject({
				name: "FileMappingError",
				code: "maxFiles",
			})
		})

		it("ファイルごとの対応数の上限", async () => {
			const limits = { ...DEFAULT_FILE_MAPPING_LIMITS, maxEntriesPerFile: 1 }
			const { store } = setup({ limits: () => limits })
			await expect(store.save("0:a.md", [entry(1, "森下"), entry(2, "林")])).rejects.toMatchObject({
				code: "maxEntries",
			})
		})

		it("全体のバイト数の上限", async () => {
			const limits = { ...DEFAULT_FILE_MAPPING_LIMITS, maxBytes: 10 }
			const { store } = setup({ limits: () => limits })
			await expect(store.save("0:a.md", [entry(1, "森下")])).rejects.toMatchObject({ code: "maxBytes" })
		})

		it("上限 0 は無制限", async () => {
			const limits = { maxFiles: 0, maxEntriesPerFile: 0, maxBytes: 0 }
			const { store } = setup({ limits: () => limits })
			await store.save("0:a.md", [entry(1, "森下")])
			await store.save("0:b.md", [entry(1, "林")])
			expect((await store.list()).length).toBe(2)
		})
	})

	describe("原子的書き込み", () => {
		it("一時ファイルを残さず、対象と .gitignore だけを置く", async () => {
			const { store, disk } = setup()
			await store.save("0:a.md", [entry(1, "森下")])
			expect([...disk.files.keys()].sort()).toEqual([TARGET, "/state/.gitignore"].sort())
		})

		it("書き込みが失敗したら投げる", async () => {
			const { store, disk } = setup()
			await store.save("0:a.md", [entry(1, "森下")])
			disk.fail("disk full")
			await expect(store.save("0:b.md", [entry(1, "林")])).rejects.toThrow("disk full")
		})
	})
})
