// npx vitest run src/core/webview/__tests__/TaskCancellationController.spec.ts
//
// TaskCancellationController は「ユーザーが停止ボタンを押したとき、走っているタスクを
// 本当に止める」ためのクラス。ここが緩むと停止したはずのタスクが API リクエストを続け、
// 課金もツール実行（ファイル書き込み・コマンド実行）も止まらない。
// そのため以下を不変条件として固定する。
//
//   1. 【停止の実行】キャンセル時に必ず cancelCurrentRequest() → abortTask() が呼ばれ、
//      abandoned が true になる。順序も固定（HTTP を切ってから abort、最後に abandoned）。
//      abortTask() が投げても、履歴が読めなくても、この 3 つには必ず到達する
//      （＝「停止ボタンを押したのに止まらない」窓を作らない）。
//   2. 【停止してから再開】履歴からの再水和（createTaskWithHistoryItem）は、旧インスタンスの
//      abort と abandoned が完了した後にしか起きない。＝新タスクが動き出す時点で旧タスクは死んでいる。
//   3. 【待機に入る前に止める】グレースフル待機（pWaitFor）へ入る時点で 1 の 3 つが済んでいる。
//      待機のタイムアウトやポーリング条件に関わらず停止指示自体は届いている。
//   4. 【二重中断】cancel() を 2 回呼んでも throw しない。
//   5. 【再水和の抑止】インスタンスが入れ替わっていたら再水和しない（多重復元の防止）。
//
// p-wait-for は本物を使う（ポーリング条件そのものが検証対象のため）。
// タイムアウト経路だけは実時間 3 秒かかるが、そこも実挙動で押さえる。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { HistoryItem } from "@openai-agent/types"

import {
	TaskCancellationController,
	type CancellableTask,
	type TaskCancellationDeps,
} from "../TaskCancellationController"

// ---------------------------------------------------------------------------
// フェイクタスク
// ---------------------------------------------------------------------------

interface FakeTaskOptions {
	taskId?: string
	instanceId?: string
	isStreaming?: boolean
	isWaitingForFirstChunk?: boolean
	didFinishAbortingStream?: boolean
	rootTask?: unknown
	parentTask?: unknown
	/** abortTask() が投げる値（異常系）。未指定なら投げない。 */
	abortThrowValue?: unknown
}

/**
 * CancellableTask を満たす最小フェイク。
 *
 * 「停止指示が届いたか」を検証するため、cancelCurrentRequest / abortTask / abandoned の
 * 順序を invocation order で記録する。ストリーム状態は可変にして pWaitFor の各条件を作る。
 */
class FakeTask implements CancellableTask {
	readonly taskId: string
	readonly instanceId: string
	readonly rootTask?: unknown
	readonly parentTask?: unknown
	abortReason?: string
	abandoned = false
	didFinishAbortingStream: boolean
	readonly stream: { isStreaming: boolean; isWaitingForFirstChunk: boolean }

	/** 呼ばれた順序を記録する（"cancelCurrentRequest" / "abortTask" / "abandoned"）。 */
	readonly trace: string[] = []

	readonly cancelCurrentRequest: () => void
	readonly abortTask: () => void

	constructor(options: FakeTaskOptions = {}) {
		this.taskId = options.taskId ?? "task-1"
		this.instanceId = options.instanceId ?? "inst-1"
		this.rootTask = options.rootTask
		this.parentTask = options.parentTask
		this.didFinishAbortingStream = options.didFinishAbortingStream ?? false
		this.stream = {
			isStreaming: options.isStreaming ?? false,
			isWaitingForFirstChunk: options.isWaitingForFirstChunk ?? false,
		}

		this.cancelCurrentRequest = vi.fn(() => {
			this.trace.push("cancelCurrentRequest")
		})
		this.abortTask = vi.fn(() => {
			this.trace.push("abortTask")
			if ("abortThrowValue" in options) {
				throw options.abortThrowValue
			}
		})

		// abandoned の代入も順序として記録する（setter 経由）。
		let abandoned = false
		Object.defineProperty(this, "abandoned", {
			get: () => abandoned,
			set: (value: boolean) => {
				abandoned = value
				this.trace.push("abandoned")
			},
			enumerable: true,
			configurable: true,
		})
	}
}

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function historyItem(id: string): HistoryItem {
	return { id, number: 1, ts: 0, task: `task ${id}`, tokensIn: 0, tokensOut: 0, totalCost: 0 }
}

interface SetupOptions {
	/** getCurrentTask() が返すタスク。undefined なら「タスク無し」。 */
	task?: FakeTask
	/**
	 * getCurrentTask() が n 回目以降に返す差し替えタスク。
	 * 「待機中に別インスタンスへ入れ替わった」状況を作るために使う。
	 */
	swapAfterCall?: number
	swapTo?: FakeTask | undefined
	/** getTaskWithId の実装（履歴欠落・ストレージ障害の再現用）。 */
	getTaskWithId?: (id: string) => Promise<{ historyItem: HistoryItem }>
	/** createTaskWithHistoryItem の実装。 */
	createTaskWithHistoryItem?: (item: HistoryItem) => Promise<unknown>
}

function setup(options: SetupOptions = {}) {
	const task = options.task
	let calls = 0

	const getCurrentTask = vi.fn((): FakeTask | undefined => {
		calls += 1
		if (options.swapAfterCall !== undefined && calls > options.swapAfterCall) {
			return options.swapTo
		}
		return task
	})

	const getTaskWithId = vi.fn(options.getTaskWithId ?? (async (id: string) => ({ historyItem: historyItem(id) })))
	const createTaskWithHistoryItem = vi.fn(options.createTaskWithHistoryItem ?? (async (_item: HistoryItem) => ({})))
	const log = vi.fn((_message: string) => {})

	const deps: TaskCancellationDeps<FakeTask> = {
		getCurrentTask,
		getTaskWithId,
		createTaskWithHistoryItem,
		log,
	}

	return {
		controller: new TaskCancellationController<FakeTask>(deps),
		getCurrentTask,
		getTaskWithId,
		createTaskWithHistoryItem,
		log,
		callCount: () => calls,
	}
}

/** 「停止指示が正しい順序で届いた」ことの共通検査（不変条件 1）。 */
function expectStopped(task: FakeTask): void {
	expect(task.cancelCurrentRequest).toHaveBeenCalledOnce()
	expect(task.abortTask).toHaveBeenCalledOnce()
	expect(task.abandoned).toBe(true)
	expect(task.abortReason).toBe("user_cancelled")
	// HTTP を切る → abort → abandoned の順。逆になると「abort 済みなのに
	// 進行中リクエストがネットワークタイムアウトまで生き残る」窓ができる。
	expect(task.trace).toEqual(["cancelCurrentRequest", "abortTask", "abandoned"])
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.clearAllMocks()
	consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	consoleLogSpy.mockRestore()
	consoleErrorSpy.mockRestore()
})

// ---------------------------------------------------------------------------

describe("TaskCancellationController", () => {
	describe("不変条件1: 停止指示が必ず届く", () => {
		it("【不変条件】キャンセルで cancelCurrentRequest → abortTask → abandoned が順に実行される", async () => {
			const task = new FakeTask({ isStreaming: false })
			const h = setup({ task })

			await h.controller.cancel()

			expectStopped(task)
			expect(consoleLogSpy).toHaveBeenCalledWith("[cancelTask] cancelling task task-1.inst-1")
		})

		it.each([
			{ name: "ストリーミング中でない", opts: { isStreaming: false } },
			{
				name: "abort 済み（didFinishAbortingStream）",
				opts: { isStreaming: true, didFinishAbortingStream: true },
			},
			{ name: "最初のチャンク待ち", opts: { isStreaming: true, isWaitingForFirstChunk: true } },
		])("【不変条件】$name の状態でも停止指示は届く", async ({ opts }) => {
			const task = new FakeTask(opts)
			const h = setup({ task })

			await h.controller.cancel()

			expectStopped(task)
		})

		it("【不変条件】グレースフル待機がタイムアウトしても停止指示は既に届いている", async () => {
			// pWaitFor の条件が最後まで満たされない状態（実時間 3 秒かかる経路）。
			const task = new FakeTask({
				isStreaming: true,
				isWaitingForFirstChunk: false,
				didFinishAbortingStream: false,
			})
			const h = setup({ task })

			await h.controller.cancel()

			expectStopped(task)
			expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to abort task")
			// タイムアウトしても再水和自体は行われる（履歴があるため）。
			expect(h.createTaskWithHistoryItem).toHaveBeenCalledOnce()
		}, 15_000)

		it("【不変条件】abortTask が throw しても abandoned は立つ", async () => {
			// abort の途中で落ちたインスタンスこそ放置してはいけない。ここで abandoned を
			// 飛ばすと「中途半端に abort されただけの生きたインスタンス」が残り、
			// 残留処理（ストリーム消化・ツール実行）が動き続ける。
			const task = new FakeTask({ abortThrowValue: new Error("abort boom") })
			const h = setup({ task })

			await expect(h.controller.cancel()).resolves.toBeUndefined()

			expectStopped(task)
			expect(h.log).toHaveBeenCalledWith("[cancelTask] abortTask threw for task-1: abort boom")
			// 停止が完了している以上、再水和まで通常どおり進む。
			expect(h.createTaskWithHistoryItem).toHaveBeenCalledOnce()
		})

		it("【不変条件】abortTask が Error 以外を投げても abandoned は立つ", async () => {
			const task = new FakeTask({ abortThrowValue: "not-an-error" })
			const h = setup({ task })

			await expect(h.controller.cancel()).resolves.toBeUndefined()

			expectStopped(task)
			expect(h.log).toHaveBeenCalledWith("[cancelTask] abortTask threw for task-1: not-an-error")
		})
	})

	describe("不変条件2: 再水和は旧インスタンスを止めてから", () => {
		it("【不変条件】createTaskWithHistoryItem は abortTask / abandoned の後に呼ばれる", async () => {
			const task = new FakeTask({ isStreaming: false })
			const h = setup({ task })

			await h.controller.cancel()

			const abortOrder = (task.abortTask as unknown as { mock: { invocationCallOrder: number[] } }).mock
				.invocationCallOrder[0]
			const createOrder = h.createTaskWithHistoryItem.mock.invocationCallOrder[0]
			expect(abortOrder).toBeLessThan(createOrder)
			// 新タスクを作る時点で旧インスタンスは abandoned 済み。
			expect(task.abandoned).toBe(true)
		})

		it("履歴アイテムに rootTask / parentTask を引き継いで再水和する", async () => {
			const root = { taskId: "root" }
			const parent = { taskId: "parent" }
			const task = new FakeTask({ taskId: "child", rootTask: root, parentTask: parent })
			const h = setup({ task })

			await h.controller.cancel()

			expect(h.getTaskWithId).toHaveBeenCalledExactlyOnceWith("child")
			expect(h.createTaskWithHistoryItem).toHaveBeenCalledExactlyOnceWith({
				...historyItem("child"),
				rootTask: root,
				parentTask: parent,
			})
		})
	})

	describe("不変条件3: 待機に入る前に停止指示が完了している", () => {
		it("【不変条件】pWaitFor の条件が最初に評価される時点で 3 つの停止操作が済んでいる", async () => {
			const task = new FakeTask({ isStreaming: false })
			// getCurrentTask が呼ばれた各時点のスナップショットを取る。
			const snapshots: Array<{ trace: string[]; abandoned: boolean }> = []
			const h = setup({ task })
			h.getCurrentTask.mockImplementation(() => {
				snapshots.push({ trace: [...task.trace], abandoned: task.abandoned })
				return task
			})

			await h.controller.cancel()

			// 1 回目は cancel() 冒頭（まだ何もしていない）。
			expect(snapshots[0]).toEqual({ trace: [], abandoned: false })
			// 2 回目以降はすべて pWaitFor 以降＝停止指示が完了した後。
			for (const snapshot of snapshots.slice(1)) {
				expect(snapshot.trace).toEqual(["cancelCurrentRequest", "abortTask", "abandoned"])
				expect(snapshot.abandoned).toBe(true)
			}
			expect(snapshots.length).toBeGreaterThan(1)
		})

		it("待機条件は getCurrentTask が undefined を返しても成立する（タスクが消えた場合）", async () => {
			const task = new FakeTask({ isStreaming: true })
			// 冒頭の 1 回だけタスクを返し、以降は undefined。
			const h = setup({ task, swapAfterCall: 1, swapTo: undefined })

			await h.controller.cancel()

			expectStopped(task)
			// current が undefined なのでインスタンス比較はスキップされ、履歴があるので再水和する。
			expect(h.createTaskWithHistoryItem).toHaveBeenCalledOnce()
		})
	})

	describe("不変条件4: 二重中断", () => {
		it("【不変条件】同じタスクに対して cancel() を 2 回呼んでも throw しない", async () => {
			const task = new FakeTask({ isStreaming: false })
			const h = setup({ task })

			await h.controller.cancel()
			await expect(h.controller.cancel()).resolves.toBeUndefined()

			// 2 回目も停止指示は届く（idempotent に呼ばれる）。
			expect(task.cancelCurrentRequest).toHaveBeenCalledTimes(2)
			expect(task.abortTask).toHaveBeenCalledTimes(2)
			expect(task.abandoned).toBe(true)
		})

		it("【不変条件】cancel() を並行に 2 本走らせても throw しない", async () => {
			const task = new FakeTask({ isStreaming: false })
			const h = setup({ task })

			await expect(Promise.all([h.controller.cancel(), h.controller.cancel()])).resolves.toEqual([
				undefined,
				undefined,
			])

			expect(task.abandoned).toBe(true)
			// 【要確認】並行キャンセルでは instanceId が変わらないため二重チェックが効かず、
			// 再水和が 2 回走る（履歴タスクが 2 本立ち上がる）。
			expect(h.createTaskWithHistoryItem).toHaveBeenCalledTimes(2)
		})

		it("タスクが無いときの cancel() は何もせずに返る", async () => {
			const h = setup({ task: undefined })

			await expect(h.controller.cancel()).resolves.toBeUndefined()

			expect(h.getTaskWithId).not.toHaveBeenCalled()
			expect(h.createTaskWithHistoryItem).not.toHaveBeenCalled()
			expect(consoleLogSpy).not.toHaveBeenCalled()
		})
	})

	describe("不変条件5: インスタンス入れ替わり時は再水和しない", () => {
		it("待機後に別インスタンスへ入れ替わっていたら再水和をスキップする", async () => {
			const task = new FakeTask({ isStreaming: false, instanceId: "inst-1" })
			const other = new FakeTask({ instanceId: "inst-2" })
			// 呼び出し順: 1=冒頭, 2..3=pWaitFor 条件, 4=1 回目のインスタンス比較。
			const h = setup({ task, swapAfterCall: 3, swapTo: other })

			await h.controller.cancel()

			expectStopped(task)
			expect(h.createTaskWithHistoryItem).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledWith(
				"[cancelTask] Skipping rehydrate: current instance inst-2 != original inst-1",
			)
		})

		it("最終チェックの時点で入れ替わった場合も再水和をスキップする", async () => {
			// 実装は同じ比較を 2 回行う。1 回目を通過して 2 回目で弾かれる経路。
			// 両者の間に await が無いため実運用では到達しにくい＝【要確認】冗長な二重チェック。
			const task = new FakeTask({ isStreaming: false, instanceId: "inst-1" })
			const other = new FakeTask({ instanceId: "inst-9" })
			// 呼び出し順: 1=冒頭, 2..3=pWaitFor 条件, 4=1 回目の比較, 5=最終チェック。
			const h = setup({ task, swapAfterCall: 4, swapTo: other })

			await h.controller.cancel()

			expect(h.callCount()).toBe(5)
			expect(h.createTaskWithHistoryItem).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledWith(
				"[cancelTask] Skipping rehydrate after final check: current instance inst-9 != original inst-1",
			)
		})

		it("同じ instanceId のままなら再水和する", async () => {
			const task = new FakeTask({ isStreaming: false, instanceId: "inst-1" })
			const same = new FakeTask({ instanceId: "inst-1" })
			const h = setup({ task, swapAfterCall: 3, swapTo: same })

			await h.controller.cancel()

			expect(h.createTaskWithHistoryItem).toHaveBeenCalledOnce()
		})
	})

	describe("履歴が取得できない場合", () => {
		it('"Task not found" のときは abort だけ行い、再水和はスキップする', async () => {
			// タスク起動直後（履歴未永続）にキャンセルすると実際に起きる形。
			const task = new FakeTask({ isStreaming: false })
			const h = setup({
				task,
				getTaskWithId: async () => {
					throw new Error("Task not found")
				},
			})

			await expect(h.controller.cancel()).resolves.toBeUndefined()

			expectStopped(task)
			expect(h.createTaskWithHistoryItem).not.toHaveBeenCalled()
			expect(h.log).toHaveBeenCalledWith("[cancelTask] task history missing for task-1; skipping rehydrate")
		})

		it("【不変条件】'Task not found' 以外のエラーでも停止指示は必ず届く", async () => {
			// getTaskWithId は cancelCurrentRequest / abortTask より前に await される。
			// ここで再 throw すると、ストレージ障害のときに停止指示が 1 つも届かない
			// ＝「停止ボタンを押したのにタスクが走り続ける」。再水和できないことより、
			// 停止できないことのほうが重い。
			const task = new FakeTask({ isStreaming: false })
			const h = setup({
				task,
				getTaskWithId: async () => {
					throw new Error("storage offline")
				},
			})

			await expect(h.controller.cancel()).resolves.toBeUndefined()

			expectStopped(task)
			expect(h.log).toHaveBeenCalledWith(
				"[cancelTask] failed to read task history for task-1; aborting anyway: storage offline",
			)
			// 履歴が無いので再水和はしない（停止だけして終わる）。
			expect(h.createTaskWithHistoryItem).not.toHaveBeenCalled()
		})

		it("【不変条件】Error 以外が投げられても停止指示は必ず届く", async () => {
			const task = new FakeTask({ isStreaming: false })
			const h = setup({
				task,
				getTaskWithId: async () => {
					throw "not-an-error"
				},
			})

			await expect(h.controller.cancel()).resolves.toBeUndefined()

			expectStopped(task)
			expect(h.log).toHaveBeenCalledWith(
				"[cancelTask] failed to read task history for task-1; aborting anyway: not-an-error",
			)
			expect(h.createTaskWithHistoryItem).not.toHaveBeenCalled()
		})
	})

	describe("再水和の失敗", () => {
		it("createTaskWithHistoryItem が投げたら呼び出し側へ伝播する（停止自体は完了済み）", async () => {
			const task = new FakeTask({ isStreaming: false })
			const h = setup({
				task,
				createTaskWithHistoryItem: async () => {
					throw new Error("rehydrate failed")
				},
			})

			await expect(h.controller.cancel()).rejects.toThrow("rehydrate failed")

			expectStopped(task)
		})
	})
})
