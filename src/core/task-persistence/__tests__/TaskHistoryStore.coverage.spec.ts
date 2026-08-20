// cd src && npx vitest run core/task-persistence/__tests__/TaskHistoryStore.coverage.spec.ts
//
// TaskHistoryStore の「防御的分岐」を埋めるための追加 spec。
// 既存の TaskHistoryStore.spec.ts / .crossInstance.spec.ts が幸せ経路を押さえているので、
// ここでは失敗経路・タイマ発火・fs.watch 連動・dispose 後の挙動といった、実 fs.watch では
// 決定的に踏めない枝を、`fs.watch` と `safeWriteJson` / `getStorageBasePath` をモックして固定する。

import * as os from "os"
import * as path from "path"
import * as fsp from "fs/promises"

import type { HistoryItem } from "@openai-agent/types"

// 差し替え可能なモック群（hoisted で初期化順の問題を回避）。
const H = vi.hoisted(() => ({ safeWriteJson: vi.fn() }))
const S = vi.hoisted(() => ({ getStorageBasePath: vi.fn() }))
const W = vi.hoisted(() => ({ watch: vi.fn() }))

vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: H.safeWriteJson }))
vi.mock("../../../utils/storage", () => ({ getStorageBasePath: S.getStorageBasePath }))
// `fs` は watch だけ差し替え、それ以外は本物を透過させる。
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	return { ...actual, watch: W.watch }
})

import { TaskHistoryStore } from "../TaskHistoryStore"
import { GlobalFileNames } from "../../../shared/globalFileNames"

function makeHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.01,
		workspace: "/test/workspace",
		...overrides,
	}
}

let tmpDir: string
let lastWatchCb: ((eventType: string, filename: string) => void) | undefined
let lastWatchErr: ((err: Error) => void) | undefined
let fakeWatcher: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

beforeEach(async () => {
	tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "task-history-cov-"))

	// safeWriteJson は既定で実ファイルへ書く（index / per-task file が実在する前提の枝を通すため）。
	H.safeWriteJson.mockReset()
	H.safeWriteJson.mockImplementation(async (filePath: string, data: unknown) => {
		await fsp.mkdir(path.dirname(filePath), { recursive: true })
		await fsp.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
	})

	S.getStorageBasePath.mockReset()
	S.getStorageBasePath.mockImplementation((p: string) => p)

	lastWatchCb = undefined
	lastWatchErr = undefined
	fakeWatcher = {
		on: vi.fn((event: string, handler: (err: Error) => void) => {
			if (event === "error") lastWatchErr = handler
			return fakeWatcher
		}),
		close: vi.fn(),
	}
	W.watch.mockReset()
	W.watch.mockImplementation((_dir: string, _opts: unknown, cb: (e: string, f: string) => void) => {
		lastWatchCb = cb
		return fakeWatcher
	})
})

// ─────────────────────────── onWrite 書き戻し ───────────────────────────

describe("onWrite コールバック", () => {
	it("upsert は onWrite をロック内で呼び最新一覧を渡す", async () => {
		const onWrite = vi.fn(async (_items: HistoryItem[]) => {})
		const store = new TaskHistoryStore(tmpDir, { onWrite })
		await store.initialize()

		await store.upsert(makeHistoryItem({ id: "u1" }))

		expect(onWrite).toHaveBeenCalled()
		const lastArg = onWrite.mock.calls.at(-1)![0]
		expect(lastArg.some((h) => h.id === "u1")).toBe(true)
		store.dispose()
	})

	it("delete は onWrite を呼ぶ", async () => {
		const onWrite = vi.fn(async (_items: HistoryItem[]) => {})
		const store = new TaskHistoryStore(tmpDir, { onWrite })
		await store.initialize()
		await store.upsert(makeHistoryItem({ id: "d1" }))
		onWrite.mockClear()

		await store.delete("d1")

		expect(onWrite).toHaveBeenCalledTimes(1)
		store.dispose()
	})

	it("deleteMany は onWrite を呼び、存在しないファイルの unlink 失敗を握り潰す", async () => {
		const onWrite = vi.fn(async (_items: HistoryItem[]) => {})
		const store = new TaskHistoryStore(tmpDir, { onWrite })
		await store.initialize()

		// ファイルが存在しない id を渡す → 内部 unlink が ENOENT で投げるが握り潰される。
		await expect(store.deleteMany(["ghost-1", "ghost-2"])).resolves.toBeUndefined()

		expect(onWrite).toHaveBeenCalled()
		store.dispose()
	})
})

// ─────────────────────────── reconcile の失敗経路 ───────────────────────────

describe("reconcile の防御的分岐", () => {
	it("tasks ディレクトリが存在しなければ何もしない（readdir 失敗）", async () => {
		const store = new TaskHistoryStore(tmpDir) // initialize しない → tasks 未作成
		await expect(store.reconcile()).resolves.toBeUndefined()
		expect(store.getAll()).toEqual([])
		store.dispose()
	})

	it("readTaskFile が投げても握り潰して続行する", async () => {
		const store = new TaskHistoryStore(tmpDir)
		await fsp.mkdir(path.join(tmpDir, "tasks", "boom"), { recursive: true })
		;(store as unknown as { readTaskFile: unknown }).readTaskFile = vi
			.fn()
			.mockRejectedValue(new Error("read boom"))

		await expect(store.reconcile()).resolves.toBeUndefined()
		expect(store.get("boom")).toBeUndefined()
		store.dispose()
	})

	it("id を持たない history_item.json は取り込まない（readTaskFile→null）", async () => {
		const store = new TaskHistoryStore(tmpDir)
		const dir = path.join(tmpDir, "tasks", "noid")
		await fsp.mkdir(dir, { recursive: true })
		await fsp.writeFile(path.join(dir, GlobalFileNames.historyItem), JSON.stringify({ ts: 1, task: "x" }))

		await store.reconcile()

		expect(store.get("noid")).toBeUndefined()
		store.dispose()
	})
})

// ─────────────────────────── invalidate / invalidateAll ───────────────────────────

describe("invalidate 系", () => {
	it("invalidate は readTaskFile が投げたらキャッシュから消す", async () => {
		const store = new TaskHistoryStore(tmpDir)
		;(store as unknown as { cache: Map<string, HistoryItem> }).cache.set("x", makeHistoryItem({ id: "x" }))
		;(store as unknown as { readTaskFile: unknown }).readTaskFile = vi.fn().mockRejectedValue(new Error("boom"))

		await store.invalidate("x")

		expect(store.get("x")).toBeUndefined()
		store.dispose()
	})

	it("invalidateAll は全キャッシュを空にする", async () => {
		const store = new TaskHistoryStore(tmpDir)
		await store.initialize()
		await store.upsert(makeHistoryItem({ id: "a" }))
		expect(store.getAll()).toHaveLength(1)

		store.invalidateAll()

		expect(store.getAll()).toEqual([])
		store.dispose()
	})
})

// ─────────────────────────── migrateFromGlobalState の早期 return ───────────────────────────

describe("migrateFromGlobalState の防御的分岐", () => {
	it("空配列 / undefined では何もしない", async () => {
		const store = new TaskHistoryStore(tmpDir)
		await store.migrateFromGlobalState([])
		await store.migrateFromGlobalState(undefined as unknown as HistoryItem[])
		expect(store.getAll()).toEqual([])
		store.dispose()
	})

	it("id の無いエントリは飛ばす", async () => {
		const store = new TaskHistoryStore(tmpDir)
		await store.migrateFromGlobalState([{ ...makeHistoryItem(), id: "" }])
		expect(store.getAll()).toEqual([])
		store.dispose()
	})
})

// ─────────────────────────── index 書き込みのタイマ・失敗 ───────────────────────────

describe("index 書き込み", () => {
	it("scheduleIndexWrite は dispose 後は何もしない", () => {
		const store = new TaskHistoryStore(tmpDir)
		store.dispose()
		;(store as unknown as { scheduleIndexWrite: () => void }).scheduleIndexWrite()
		expect((store as unknown as { indexWriteTimer: unknown }).indexWriteTimer).toBeNull()
	})

	it("debounce 発火で index を書き、書き込み失敗は握り潰す", async () => {
		vi.useFakeTimers()
		try {
			const store = new TaskHistoryStore(tmpDir)
			// 成功経路
			;(store as unknown as { scheduleIndexWrite: () => void }).scheduleIndexWrite()
			await vi.advanceTimersByTimeAsync(2000)
			expect(H.safeWriteJson).toHaveBeenCalled()

			// 失敗経路（catch）
			H.safeWriteJson.mockRejectedValueOnce(new Error("index boom"))
			;(store as unknown as { scheduleIndexWrite: () => void }).scheduleIndexWrite()
			await vi.advanceTimersByTimeAsync(2000)
			;(store as unknown as { disposed: boolean }).disposed = true
		} finally {
			vi.useRealTimers()
		}
	})

	it("dispose 時の index flush 失敗はログして飲む", async () => {
		const store = new TaskHistoryStore(tmpDir)
		H.safeWriteJson.mockRejectedValueOnce(new Error("flush boom"))
		store.dispose() // flushIndex().catch(...) が走る
		// catch のマイクロタスクを進める
		await Promise.resolve()
		await Promise.resolve()
	})
})

// ─────────────────────────── withLock の rejection ───────────────────────────

describe("withLock", () => {
	it("ロック内の操作が reject してもロックは解放され既存キャッシュも壊れない", async () => {
		const store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// 書き込み失敗 → upsert が reject。writeTaskFile が cache.set の前に投げるので、
		// 失敗した項目はキャッシュに載らない（既存を壊さない不変条件）。
		H.safeWriteJson.mockRejectedValueOnce(new Error("write boom"))
		await expect(store.upsert(makeHistoryItem({ id: "boom" }))).rejects.toThrow("write boom")
		expect(store.get("boom")).toBeUndefined()

		// ロックが壊れていない：次の upsert は成功する。
		await store.upsert(makeHistoryItem({ id: "ok" }))
		expect(store.get("ok")).toBeDefined()
		store.dispose()
	})
})

// ─────────────────────────── startWatcher（fs.watch 連動）───────────────────────────

describe("startWatcher の分岐", () => {
	it("dispose 済みなら watch を張らない", () => {
		const store = new TaskHistoryStore(tmpDir)
		;(store as unknown as { disposed: boolean }).disposed = true
		;(store as unknown as { startWatcher: () => void }).startWatcher()
		expect(W.watch).not.toHaveBeenCalled()
		store.dispose()
	})

	it("getTasksDir 解決前に dispose されたら watch を張らない", async () => {
		const store = new TaskHistoryStore(tmpDir)
		;(store as unknown as { startWatcher: () => void }).startWatcher()
		// .then が走る前に disposed にする
		;(store as unknown as { disposed: boolean }).disposed = true
		await new Promise((r) => setTimeout(r, 0))
		expect(W.watch).not.toHaveBeenCalled()
	})

	it("getTasksDir が reject したら catch でログして続行する", async () => {
		const store = new TaskHistoryStore(tmpDir)
		S.getStorageBasePath.mockRejectedValueOnce(new Error("no base"))
		;(store as unknown as { startWatcher: () => void }).startWatcher()
		await new Promise((r) => setTimeout(r, 0))
		expect(W.watch).not.toHaveBeenCalled()
		store.dispose()
	})

	it("fs.watch が投げても catch で握り潰す", async () => {
		const store = new TaskHistoryStore(tmpDir)
		W.watch.mockImplementationOnce(() => {
			throw new Error("watch throw")
		})
		;(store as unknown as { startWatcher: () => void }).startWatcher()
		await new Promise((r) => setTimeout(r, 0))
		expect(W.watch).toHaveBeenCalled()
		store.dispose()
	})

	it("watch コールバックは debounce 後 reconcile を呼び、error/ dispose 中は握り潰す", async () => {
		vi.useFakeTimers()
		try {
			const store = new TaskHistoryStore(tmpDir)
			const reconcileSpy = vi.spyOn(store, "reconcile").mockRejectedValue(new Error("recon boom"))
			;(store as unknown as { startWatcher: () => void }).startWatcher()
			// getTasksDir().then を消化して watch を張らせる
			await vi.advanceTimersByTimeAsync(0)
			expect(W.watch).toHaveBeenCalledTimes(1)

			// error ハンドラ（fs.watch はプラットフォームによっては error を出す）
			expect(typeof lastWatchErr).toBe("function")
			lastWatchErr!(new Error("watch err"))

			// コールバック 2 連打（2 回目で既存 debounce を clear する枝）
			lastWatchCb!("rename", "f1")
			lastWatchCb!("rename", "f2")
			await vi.advanceTimersByTimeAsync(500)
			expect(reconcileSpy).toHaveBeenCalled() // reject は startWatcher 側の catch が飲む

			// dispose 中はコールバックが即 return する
			;(store as unknown as { disposed: boolean }).disposed = true
			lastWatchCb!("rename", "f3")
			;(store as unknown as { disposed: boolean }).disposed = false
			store.dispose()
		} finally {
			vi.useRealTimers()
		}
	})
})

// ─────────────────────────── startPeriodicReconciliation ───────────────────────────

describe("startPeriodicReconciliation の分岐", () => {
	it("dispose 済みなら即 return（タイマを張らない）", () => {
		const store = new TaskHistoryStore(tmpDir)
		;(store as unknown as { disposed: boolean }).disposed = true
		;(store as unknown as { startPeriodicReconciliation: () => void }).startPeriodicReconciliation()
		expect((store as unknown as { reconcileTimer: unknown }).reconcileTimer).toBeNull()
	})

	it("発火で reconcile→再スケジュール、失敗はログ、dispose 中はスキップ", async () => {
		vi.useFakeTimers()
		try {
			const store = new TaskHistoryStore(tmpDir)
			const spy = vi.spyOn(store, "reconcile").mockResolvedValue()
			;(store as unknown as { startPeriodicReconciliation: () => void }).startPeriodicReconciliation()

			// 1 回目：not disposed → reconcile 成功 → 再スケジュール
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
			expect(spy).toHaveBeenCalledTimes(1)

			// 2 回目：reconcile が reject → catch
			spy.mockRejectedValueOnce(new Error("periodic boom"))
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
			expect(spy).toHaveBeenCalledTimes(2)

			// 3 回目：disposed 中はコールバック内で return（reconcile を呼ばない）
			;(store as unknown as { disposed: boolean }).disposed = true
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
			expect(spy).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})
})
