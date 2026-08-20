// pnpm --filter openai-agent test core/webview/__tests__/TaskDeletionController.spec.ts
//
// TaskDeletionController は「復元不可能な削除」を行う数少ないクラスなので、
// 「消える範囲」そのものを不変条件として固定する。行数を稼ぐのではなく、
//   1. 指定 ID とその子孫以外のディレクトリに fs.rm が飛ばないこと
//   2. cascade off なら子は消えないこと
//   3. childIds が循環・重複していても各 ID を高々 1 回しか消さないこと
//   4. 存在しない ID / 空文字 / undefined、および childIds に混ざった危険な ID で
//      `<globalStorage>/tasks/<1 セグメント>` の外へ fs.rm が飛ばないこと
//   5. ShadowCheckpointService.deleteTask が投げても残りの削除が続くこと
//   6. 現在実行中のタスクを消すときの扱い
// を、fs.rm に渡った引数の「全件」で検証する。

import path from "node:path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { HistoryItem } from "@openai-agent/types"

import { TaskDeletionController, type TaskDeletionDeps } from "../TaskDeletionController"

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

const { rmMock, deleteTaskMock, getTaskDirectoryPathMock } = vi.hoisted(() => ({
	rmMock: vi.fn(async (..._args: unknown[]) => undefined),
	deleteTaskMock: vi.fn(async (..._args: unknown[]) => undefined),
	getTaskDirectoryPathMock: vi.fn(async (..._args: unknown[]) => ""),
}))

// 実装は `import fs from "fs/promises"` の default import なので default も生やす。
vi.mock("fs/promises", () => {
	const api = { rm: rmMock }
	return { ...api, default: api }
})

vi.mock("../../../services/checkpoints/ShadowCheckpointService", () => ({
	ShadowCheckpointService: { deleteTask: deleteTaskMock },
}))

// isSafeTaskId は本物を使う。ここをスタブにすると「危険な子 ID を集めない」検証が空振りする。
//
// 一方 getTaskDirectoryPath はスタブにし、素朴な path.join(base, "tasks", taskId) だけを再現する。
// 本物はさらに isSafeTaskId で throw するが、そのガードは意図的に写していない：
// このファイルで固定したいのは「TaskDeletionController 自身が危険な ID を集めない」ことなので、
// パス組み立て側の防波堤が無かったとしても危険なパスが fs.rm へ届かない、という強い形で見る。
// storage 側の throw は src/utils/__tests__/storage.spec.ts が受け持つ。
vi.mock("../../../utils/storage", async () => {
	const actual = await vi.importActual<typeof import("../../../utils/storage")>("../../../utils/storage")
	return { ...actual, getTaskDirectoryPath: getTaskDirectoryPathMock }
})

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

const GLOBAL_STORAGE_DIR = "/global-storage"
const WORKSPACE_DIR = "/workspace/project"
const TASKS_DIR = path.join(GLOBAL_STORAGE_DIR, "tasks")

/** そのタスクディレクトリの想定パス。 */
const taskDir = (id: string) => path.join(TASKS_DIR, id)

function historyItem(id: string, childIds?: string[]): HistoryItem {
	return {
		id,
		number: 1,
		ts: 0,
		task: `task ${id}`,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...(childIds === undefined ? {} : { childIds }),
	}
}

interface SetupOptions {
	/** 履歴ストアに存在するタスク。 */
	tasks?: HistoryItem[]
	/** 現在アクティブなタスク ID。 */
	currentTaskId?: string
	/** getTaskWithId を丸ごと差し替える（循環参照や異常系の再現用）。 */
	getTaskWithId?: (id: string) => Promise<{ historyItem: HistoryItem }>
	/**
	 * getTaskWithId の呼び出し回数の上限。超えたら throw する。
	 *
	 * 循環した childIds を渡すテスト用の安全装置。実装の循環ガードが外れると
	 * collectChildIds は await を挟むぶんスタックも溢れないまま回り続け、
	 * テストがタイムアウトではなく OOM で落ちて他テストの結果まで潰す。
	 * 上限で throw しておけば collectChildIds の catch に吸われて再帰が巻き戻り、
	 * 「重複して消しに行った」という assertion 失敗として観測できる。
	 */
	maxLookups?: number
}

function setup(options: SetupOptions = {}) {
	const store = new Map((options.tasks ?? []).map((item) => [item.id, item]))

	const defaultGetTaskWithId = async (id: string): Promise<{ historyItem: HistoryItem }> => {
		const item = store.get(id)
		if (!item) {
			// 実装は message === "Task not found" だけを state-only 削除に分岐させるので、
			// 本物（ClineProvider.getTaskWithId）と同じ文言を使う。
			throw new Error("Task not found")
		}
		return { historyItem: item }
	}

	const rawGetTaskWithId = options.getTaskWithId ?? defaultGetTaskWithId
	let lookups = 0
	const getTaskWithId = vi.fn(async (id: string): Promise<{ historyItem: HistoryItem }> => {
		lookups += 1
		if (options.maxLookups !== undefined && lookups > options.maxLookups) {
			throw new Error(`test guard: getTaskWithId が ${options.maxLookups} 回を超えて呼ばれた`)
		}
		return rawGetTaskWithId(id)
	})
	const getCurrentTaskId = vi.fn((): string | undefined => options.currentTaskId)
	const removeClineFromStack = vi.fn(async () => {})
	const deleteManyFromStore = vi.fn(async (_ids: string[]) => {})
	const invalidateRecentTasksCache = vi.fn(() => {})
	const deleteFromState = vi.fn(async (_id: string) => {})
	const getGlobalStorageDir = vi.fn(() => GLOBAL_STORAGE_DIR)
	const getWorkspaceDir = vi.fn(() => WORKSPACE_DIR)
	const postStateToWebview = vi.fn(async () => {})

	const deps: TaskDeletionDeps = {
		getTaskWithId,
		getCurrentTaskId,
		removeClineFromStack,
		deleteManyFromStore,
		invalidateRecentTasksCache,
		deleteFromState,
		getGlobalStorageDir,
		getWorkspaceDir,
		postStateToWebview,
	}

	return {
		controller: new TaskDeletionController(deps),
		/** getTaskWithId が呼ばれた回数（上限で弾かれた分も含む）。 */
		lookupCount: () => lookups,
		getTaskWithId,
		getCurrentTaskId,
		removeClineFromStack,
		deleteManyFromStore,
		invalidateRecentTasksCache,
		deleteFromState,
		postStateToWebview,
	}
}

/** fs.rm に渡った第 1 引数（＝消えるパス）を呼ばれた順に全件返す。 */
const rmPaths = (): string[] => rmMock.mock.calls.map((call) => call[0] as string)

/** fs.rm に渡った第 2 引数（オプション）を全件返す。 */
const rmOptions = (): unknown[] => rmMock.mock.calls.map((call) => call[1])

/** ShadowCheckpointService.deleteTask に渡った taskId を全件返す。 */
const shadowTaskIds = (): string[] => deleteTaskMock.mock.calls.map((call) => (call[0] as { taskId: string }).taskId)

/**
 * fs.rm に渡った全パスが `<GLOBAL_STORAGE_DIR>/tasks/<1 セグメント>` の形であることを検査する。
 *
 * ここが崩れると「タスク 1 件のつもりが tasks ディレクトリごと消えた」になり、
 * force:true の rm なので気づく手段が無い。テストごとの期待値とは別に、
 * 削除が走るケースでは必ずこの形を通す。
 */
function expectAllRmPathsInsideTasksDir(): void {
	for (const p of rmPaths()) {
		expect(path.dirname(p)).toBe(TASKS_DIR)
		const segment = path.basename(p)
		expect(segment).not.toBe("")
		expect(segment).not.toBe(".")
		expect(segment).not.toBe("..")
		// 正規化後もちょうど tasks/<segment> に戻る＝上位へ抜けていない。
		expect(path.resolve(p)).toBe(path.join(TASKS_DIR, segment))
	}
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let consoleWarnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.clearAllMocks()
	rmMock.mockImplementation(async (..._args: unknown[]) => undefined)
	deleteTaskMock.mockImplementation(async (..._args: unknown[]) => undefined)
	getTaskDirectoryPathMock.mockImplementation(async (...args: unknown[]) =>
		path.join(args[0] as string, "tasks", args[1] as string),
	)
	consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
	consoleLogSpy.mockRestore()
	consoleErrorSpy.mockRestore()
	consoleWarnSpy.mockRestore()
})

// ---------------------------------------------------------------------------

describe("TaskDeletionController", () => {
	describe("削除範囲（不変条件 1）", () => {
		it("子を持たないタスクは自分のディレクトリだけを消す（cascade 引数省略＝既定 true）", async () => {
			const h = setup({ tasks: [historyItem("A")], currentTaskId: "other" })

			// cascadeSubtasks を渡さない＝デフォルト引数 true の経路。
			await h.controller.deleteWithId("A")

			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A"])
			expect(h.invalidateRecentTasksCache).toHaveBeenCalledOnce()
			expect(shadowTaskIds()).toEqual(["A"])
			expect(deleteTaskMock).toHaveBeenCalledWith({
				taskId: "A",
				globalStorageDir: GLOBAL_STORAGE_DIR,
				workspaceDir: WORKSPACE_DIR,
			})
			// 消えたのは A のディレクトリだけ。
			expect(rmPaths()).toEqual([taskDir("A")])
			expect(rmOptions()).toEqual([{ recursive: true, force: true }])
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
			expect(h.deleteFromState).not.toHaveBeenCalled()
		})

		it("無関係なタスクのディレクトリには fs.rm が飛ばない（親＋子孫のみ）", async () => {
			const h = setup({
				tasks: [
					historyItem("A", ["A1"]),
					historyItem("A1"),
					// 以下は削除対象外。1 件でも rm が飛んだら復元不能な事故になる。
					historyItem("B", ["B1"]),
					historyItem("B1"),
					historyItem("C"),
				],
				currentTaskId: "C",
			})

			await h.controller.deleteWithId("A", true)

			expect(rmPaths()).toEqual([taskDir("A"), taskDir("A1")])
			expect(shadowTaskIds()).toEqual(["A", "A1"])
			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A", "A1"])
			// 無関係な B / B1 / C のパスは一度も現れない。
			for (const untouched of ["B", "B1", "C"]) {
				expect(rmPaths()).not.toContain(taskDir(untouched))
			}
		})

		it("孫まで再帰的に収集し、深さ優先の順で消す", async () => {
			const h = setup({
				tasks: [
					historyItem("root", ["c1", "c2"]),
					historyItem("c1", ["g1"]),
					historyItem("g1"),
					historyItem("c2"),
					historyItem("stranger"),
				],
			})

			await h.controller.deleteWithId("root")

			// 実装は push → 再帰の順（pre-order DFS）。
			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["root", "c1", "g1", "c2"])
			expect(rmPaths()).toEqual([taskDir("root"), taskDir("c1"), taskDir("g1"), taskDir("c2")])
			expect(rmPaths()).not.toContain(taskDir("stranger"))
		})

		it("childIds が空配列なら親だけを消す", async () => {
			const h = setup({ tasks: [historyItem("A", []), historyItem("B")] })

			await h.controller.deleteWithId("A")

			expect(rmPaths()).toEqual([taskDir("A")])
		})

		it("履歴に無い子 ID も削除対象に積まれる（存在確認の失敗はスキップログのみ）", async () => {
			// 子タスクが先に消されている履歴は実運用でも起きる（親だけ残るケース）。
			const h = setup({ tasks: [historyItem("A", ["ghost"])] })

			await h.controller.deleteWithId("A")

			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A", "ghost"])
			// 存在確認に失敗しても push 済みなので rm は飛ぶ（force:true なので実害は小さい）。
			expect(rmPaths()).toEqual([taskDir("A"), taskDir("ghost")])
			expect(consoleLogSpy).toHaveBeenCalledWith("[deleteTaskWithId] child task ghost not found, skipping")
		})
	})

	describe("cascade off（不変条件 2）", () => {
		it("cascadeSubtasks=false なら子は消えない", async () => {
			const h = setup({
				tasks: [historyItem("A", ["A1", "A2"]), historyItem("A1"), historyItem("A2")],
			})

			await h.controller.deleteWithId("A", false)

			// 子を辿るための getTaskWithId も呼ばれない（存在確認の 1 回だけ）。
			expect(h.getTaskWithId).toHaveBeenCalledExactlyOnceWith("A")
			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A"])
			expect(rmPaths()).toEqual([taskDir("A")])
			expect(rmPaths()).not.toContain(taskDir("A1"))
			expect(rmPaths()).not.toContain(taskDir("A2"))
			expect(shadowTaskIds()).toEqual(["A"])
		})
	})

	describe("循環・重複した childIds（不変条件 3）", () => {
		it("【不変条件】childIds が循環していても有限回で終わり、各 ID の fs.rm は 1 回だけ", async () => {
			// A→B→A の循環。委譲メタデータが壊れた履歴で起こりうる。
			const h = setup({
				tasks: [historyItem("A", ["B"]), historyItem("B", ["A"])],
				maxLookups: 40,
			})

			await h.controller.deleteWithId("A")

			// 走査は「存在確認の A」「収集の A」「収集の B」の 3 回で打ち止め。
			// B の childIds に居る A は visited 済みなので再訪しない。
			expect(h.getTaskWithId.mock.calls.map((call) => call[0])).toEqual(["A", "A", "B"])
			expect(h.lookupCount()).toBe(3)

			const paths = rmPaths()
			expect(paths).toEqual([taskDir("A"), taskDir("B")])
			// 「各 ID を高々 1 回」＝重複が 1 件も無い。
			expect(new Set(paths).size).toBe(paths.length)
			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A", "B"])
			expect(shadowTaskIds()).toEqual(["A", "B"])
			expectAllRmPathsInsideTasksDir()
		})

		it("【不変条件】自分自身を childIds に持つタスクでも 1 回だけ消す", async () => {
			// A→A の自己参照。開始 ID は最初から visited に入っているので即座に弾かれる。
			const h = setup({ tasks: [historyItem("A", ["A"])], maxLookups: 40 })

			await h.controller.deleteWithId("A")

			expect(h.lookupCount()).toBe(2)
			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A"])
			expect(rmPaths()).toEqual([taskDir("A")])
		})

		it("【不変条件】childIds に同じ子が 2 回入っていても 1 回しか消しに行かない", async () => {
			const h = setup({ tasks: [historyItem("A", ["B", "B"]), historyItem("B")], maxLookups: 40 })

			await h.controller.deleteWithId("A")

			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A", "B"])
			expect(rmPaths()).toEqual([taskDir("A"), taskDir("B")])
			expect(shadowTaskIds()).toEqual(["A", "B"])
			// 2 回目の B では getTaskWithId ごと省略される（visited で先に落ちる）。
			expect(h.getTaskWithId.mock.calls.map((call) => call[0])).toEqual(["A", "A", "B"])
		})

		it("【不変条件】複数の親から同じ孫を指す菱形でも孫は 1 回だけ消す", async () => {
			// A→[B, C], B→[D], C→[D]。委譲を挟むと実運用でも作れる形。
			const h = setup({
				tasks: [
					historyItem("A", ["B", "C"]),
					historyItem("B", ["D"]),
					historyItem("C", ["D"]),
					historyItem("D"),
				],
				maxLookups: 40,
			})

			await h.controller.deleteWithId("A")

			// pre-order DFS で A→B→D→C。C 側の D は visited 済み。
			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A", "B", "D", "C"])
			expect(rmPaths()).toEqual([taskDir("A"), taskDir("B"), taskDir("D"), taskDir("C")])
			expect(new Set(rmPaths()).size).toBe(4)
		})
	})

	describe("存在しない ID / 空文字 / undefined（不変条件 4）", () => {
		it.each([
			["存在しない ID", "missing-id"],
			["空文字", ""],
			["undefined", undefined as unknown as string],
		])("%s を渡しても fs.rm は一度も呼ばれず、state からの削除だけになる", async (_label, id) => {
			// 空文字・undefined は webview からの壊れたメッセージや、
			// 履歴が壊れて id を失ったカードのクリックで実際に到達しうる。
			const h = setup({ tasks: [historyItem("A"), historyItem("B")] })

			await h.controller.deleteWithId(id)

			expect(h.deleteFromState).toHaveBeenCalledExactlyOnceWith(id)
			// ワークスペース近傍どころか、そもそも 1 回も rm しない。
			expect(rmMock).not.toHaveBeenCalled()
			expect(deleteTaskMock).not.toHaveBeenCalled()
			expect(h.deleteManyFromStore).not.toHaveBeenCalled()
			expect(h.removeClineFromStack).not.toHaveBeenCalled()
			expect(h.postStateToWebview).not.toHaveBeenCalled()
		})

		it("正常な ID では tasks/<id> より浅いパスへ rm が飛ばない", async () => {
			const h = setup({ tasks: [historyItem("A", ["A1"]), historyItem("A1")] })

			await h.controller.deleteWithId("A")

			expectAllRmPathsInsideTasksDir()
			for (const p of rmPaths()) {
				expect(p.startsWith(`${TASKS_DIR}/`)).toBe(true)
			}
			// getTaskDirectoryPath には globalStorageDir 側が渡る（workspaceDir ではない）。
			expect(getTaskDirectoryPathMock.mock.calls).toEqual([
				[GLOBAL_STORAGE_DIR, "A"],
				[GLOBAL_STORAGE_DIR, "A1"],
			])
		})

		it("【不変条件】childIds に空文字や '..' やパス区切りが混ざっても tasks ディレクトリの外へ rm が飛ばない", async () => {
			// childIds は履歴 JSON 由来で、壊れた／細工された履歴からそのまま流れてくる。
			// ここを素通りさせると path.join(base, "tasks", childId) が tasks 自身やその上位を指し、
			// fs.rm(recursive, force) で黙って消える。復元手段は無い。
			const unsafeChildIds = [
				"", // → tasks ディレクトリそのもの
				".", // → 同上
				"..", // → globalStorage 直下
				"../..", // → さらに上位
				"../../../../../../etc", // → ストレージ外
				"a/b", // → tasks/a/b（別タスクの入れ子）
				"sub\\dir", // Windows のセパレータ
				"x\0y", // NUL 入り
				42 as unknown as string, // JSON が壊れて数値になっている
			]
			const h = setup({
				// 安全な子 A1 も混ぜて「危険な子だけが落ちる」ことを見る。
				tasks: [historyItem("A", [...unsafeChildIds, "A1"]), historyItem("A1")],
			})

			await h.controller.deleteWithId("A")

			// 一番大事な検査：fs.rm に渡った全パスが tasks/<1 セグメント> の形に収まっている。
			expectAllRmPathsInsideTasksDir()
			expect(rmPaths()).not.toContain(TASKS_DIR)
			expect(rmPaths()).not.toContain(GLOBAL_STORAGE_DIR)
			expect(rmPaths()).not.toContain(path.dirname(GLOBAL_STORAGE_DIR))
			expect(rmPaths()).not.toContain("/")
			expect(rmPaths()).toEqual([taskDir("A"), taskDir("A1")])

			// 危険な ID はそもそも収集されない：削除対象も shadow 削除も安全な 2 件だけ。
			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A", "A1"])
			expect(shadowTaskIds()).toEqual(["A", "A1"])
			// パスを組む前に落としているので getTaskDirectoryPath にも渡らない。
			expect(getTaskDirectoryPathMock.mock.calls).toEqual([
				[GLOBAL_STORAGE_DIR, "A"],
				[GLOBAL_STORAGE_DIR, "A1"],
			])

			// 握り潰さずに警告は出す（壊れた履歴に気づける）。
			expect(consoleWarnSpy).toHaveBeenCalledTimes(unsafeChildIds.length)
			for (const unsafe of unsafeChildIds) {
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					`[deleteTaskWithId] skipping unsafe child task id: ${JSON.stringify(unsafe)}`,
				)
			}
		})

		it("【不変条件】危険な子 ID を持つタスクの走査は続く（危険な子だけを落として孫まで辿る）", async () => {
			// 危険な ID で例外を投げて中断すると、残りの子孫が消し残る。落とすのはその子だけ。
			const h = setup({
				tasks: [historyItem("A", ["..", "A1"]), historyItem("A1", ["A1a"]), historyItem("A1a")],
			})

			await h.controller.deleteWithId("A")

			expect(h.deleteManyFromStore).toHaveBeenCalledExactlyOnceWith(["A", "A1", "A1a"])
			expect(rmPaths()).toEqual([taskDir("A"), taskDir("A1"), taskDir("A1a")])
			expectAllRmPathsInsideTasksDir()
		})
	})

	describe("失敗の握り潰し（不変条件 5）", () => {
		it("ShadowCheckpointService.deleteTask が投げても残りのタスクの削除は続き、呼び出し側には伝わらない", async () => {
			const h = setup({
				tasks: [historyItem("A", ["A1", "A2"]), historyItem("A1"), historyItem("A2")],
			})
			deleteTaskMock.mockImplementation(async (...args: unknown[]) => {
				const { taskId } = args[0] as { taskId: string }
				if (taskId === "A1") {
					throw new Error("shadow boom")
				}
				return undefined
			})

			// 【意図的か要確認】現状は try/catch で握り潰すため reject しない。
			// 呼び出し側（webview）は「shadow ブランチが消し残った」ことを知れない。
			await expect(h.controller.deleteWithId("A")).resolves.toBeUndefined()

			expect(shadowTaskIds()).toEqual(["A", "A1", "A2"])
			// 失敗した A1 も含めてディレクトリ削除は継続する。
			expect(rmPaths()).toEqual([taskDir("A"), taskDir("A1"), taskDir("A2")])
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("shadow boom"))
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("ShadowCheckpointService.deleteTask が Error 以外を投げても String 化して握り潰す", async () => {
			const h = setup({ tasks: [historyItem("A")] })
			// reject に文字列を渡すコードは実在するため（sanitized git ラッパ等）非 Error も通す。
			deleteTaskMock.mockImplementation(async () => {
				throw "shadow-string-failure"
			})

			await expect(h.controller.deleteWithId("A")).resolves.toBeUndefined()

			expect(rmPaths()).toEqual([taskDir("A")])
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("shadow-string-failure"))
		})

		it("fs.rm が投げても残りのタスクの削除は続き、呼び出し側には伝わらない", async () => {
			const h = setup({ tasks: [historyItem("A", ["A1"]), historyItem("A1")] })
			rmMock.mockImplementation(async (...args: unknown[]) => {
				if (args[0] === taskDir("A")) {
					// EBUSY / EPERM（Windows でファイルが開かれている等）で実際に起きうる。
					throw new Error("EBUSY: resource busy")
				}
				return undefined
			})

			// 【意図的か要確認】ディレクトリが残ったまま履歴からは消えるので、孤児ディレクトリになる。
			await expect(h.controller.deleteWithId("A")).resolves.toBeUndefined()

			expect(rmPaths()).toEqual([taskDir("A"), taskDir("A1")])
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("EBUSY: resource busy"))
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})

		it("getTaskDirectoryPath が Error 以外を投げても String 化して握り潰す", async () => {
			const h = setup({ tasks: [historyItem("A")] })
			getTaskDirectoryPathMock.mockImplementation(async () => {
				throw { code: "ENOENT" }
			})

			await expect(h.controller.deleteWithId("A")).resolves.toBeUndefined()

			expect(rmMock).not.toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("[object Object]"))
			expect(h.postStateToWebview).toHaveBeenCalledOnce()
		})
	})

	describe("現在実行中のタスク（不変条件 6）", () => {
		it("削除対象が現在タスクならスタックから外してから削除する", async () => {
			const h = setup({ tasks: [historyItem("A")], currentTaskId: "A" })

			await h.controller.deleteWithId("A")

			expect(h.removeClineFromStack).toHaveBeenCalledOnce()
			// abort ではなく removeClineFromStack のみ。削除自体は通常どおり進む。
			expect(h.removeClineFromStack.mock.invocationCallOrder[0] as number).toBeLessThan(
				h.deleteManyFromStore.mock.invocationCallOrder[0] as number,
			)
			expect(rmPaths()).toEqual([taskDir("A")])
		})

		it("子タスクが現在タスクの場合も 1 回だけスタックから外し、一致した時点で走査を打ち切る", async () => {
			// 現在タスクを「最後ではない」位置に置くことで break の有無を見分ける。
			const h = setup({
				tasks: [historyItem("A", ["A1", "A2"]), historyItem("A1"), historyItem("A2")],
				currentTaskId: "A1",
			})

			await h.controller.deleteWithId("A")

			expect(h.removeClineFromStack).toHaveBeenCalledOnce()
			// A → A1 の 2 回比較で一致し、A2 は比較されない（break）。
			expect(h.getCurrentTaskId).toHaveBeenCalledTimes(2)
			expect(rmPaths()).toEqual([taskDir("A"), taskDir("A1"), taskDir("A2")])
		})

		it("削除対象に現在タスクが含まれなければスタックには触らない", async () => {
			const h = setup({
				tasks: [historyItem("A", ["A1"]), historyItem("A1"), historyItem("B")],
				currentTaskId: "B",
			})

			await h.controller.deleteWithId("A")

			expect(h.removeClineFromStack).not.toHaveBeenCalled()
			expect(h.getCurrentTaskId).toHaveBeenCalledTimes(2)
		})

		it("アクティブなタスクが無い（getCurrentTaskId が undefined）ときもスタックには触らない", async () => {
			const h = setup({ tasks: [historyItem("A")] })

			await h.controller.deleteWithId("A")

			expect(h.removeClineFromStack).not.toHaveBeenCalled()
		})
	})

	describe("エラー伝播", () => {
		it("'Task not found' 以外の Error は握り潰さず再 throw する", async () => {
			const h = setup({
				getTaskWithId: async () => {
					throw new Error("storage offline")
				},
			})

			await expect(h.controller.deleteWithId("A")).rejects.toThrow("storage offline")

			expect(h.deleteFromState).not.toHaveBeenCalled()
			expect(rmMock).not.toHaveBeenCalled()
		})

		it("Error 以外が投げられた場合も再 throw する（state-only 削除に落ちない）", async () => {
			const h = setup({
				getTaskWithId: async () => {
					throw "not-an-error"
				},
			})

			await expect(h.controller.deleteWithId("A")).rejects.toBe("not-an-error")

			expect(h.deleteFromState).not.toHaveBeenCalled()
			expect(rmMock).not.toHaveBeenCalled()
		})

		it("履歴ストアの一括削除が失敗したらディレクトリは消さずに再 throw する", async () => {
			const h = setup({ tasks: [historyItem("A", ["A1"]), historyItem("A1")] })
			h.deleteManyFromStore.mockRejectedValue(new Error("store write failed"))

			await expect(h.controller.deleteWithId("A")).rejects.toThrow("store write failed")

			// 履歴が消せていないのにディレクトリだけ消える、という順序事故が無いことの固定。
			expect(rmMock).not.toHaveBeenCalled()
			expect(deleteTaskMock).not.toHaveBeenCalled()
			expect(h.postStateToWebview).not.toHaveBeenCalled()
		})
	})
})
