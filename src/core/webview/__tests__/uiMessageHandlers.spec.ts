// npx vitest run src/core/webview/__tests__/uiMessageHandlers.spec.ts
//
// uiMessageHandlers は webview から届く UI 操作系メッセージのディスパッチ表。
// 固定したい不変条件は 3 つ。
//
//   1. 【未知のメッセージ種別】表に無い type を渡しても throw せず、provider に一切触らない。
//      （実装は `uiMessageHandlers[message.type]` の索引だけで、未登録なら undefined が返る）
//   2. 【壊れたペイロード】checkpointDiff / checkpointRestore は zod で検証し、
//      不正なら **タスクに触らない**。特に checkpointRestore は cancelTask（＝実行中タスクの中断）を
//      伴うので、壊れたメッセージでタスクが止まってはいけない。
//   3. 【dismissUpsell の冪等性】同じ upsellId を二重に受けても保存リストが重複しない。
//
// p-wait-for は本物を使う（初期化待ちのタイムアウトが実挙動の一部のため）。

import type { WebviewMessage } from "@openai-agent/types"

vi.mock("vscode", () => ({
	commands: { executeCommand: vi.fn(async () => undefined) },
	window: { showErrorMessage: vi.fn() },
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import * as vscode from "vscode"

import { Package } from "../../../shared/package"
import { uiMessageHandlers } from "../uiMessageHandlers"
import type { WebviewMessageHost } from "../webviewMessageHost"

// ---------------------------------------------------------------------------
// フェイク provider
// ---------------------------------------------------------------------------

interface FakeTaskOptions {
	/** isInitialized の初期値。false のままだと初期化待ちがタイムアウトする。 */
	isInitialized?: boolean
	/** checkpointRestore が投げるようにする。 */
	restoreThrows?: boolean
	/** checkpointDiff が投げるようにする。 */
	diffThrows?: boolean
}

function makeTask(options: FakeTaskOptions = {}) {
	return {
		isInitialized: options.isInitialized ?? true,
		checkpointDiff: vi.fn(async (_payload: unknown) => {
			if (options.diffThrows) {
				throw new Error("diff boom")
			}
		}),
		checkpointRestore: vi.fn(async (_payload: unknown) => {
			if (options.restoreThrows) {
				throw new Error("restore boom")
			}
		}),
	}
}

type FakeTask = ReturnType<typeof makeTask>

interface SetupOptions {
	/** contextProxy.getValue("dismissedUpsells") の戻り値。 */
	dismissedUpsells?: string[]
	/** contextProxy.setValue の実装（失敗させる用）。 */
	setValue?: (key: string, value: unknown) => Promise<void>
	/** getCurrentTask() の戻り値。 */
	task?: FakeTask
	/** cancelTask() の後に getCurrentTask() が返すタスクへ差し替える。 */
	taskAfterCancel?: FakeTask
}

function setup(options: SetupOptions = {}) {
	let currentTask = options.task
	let cancelled = false

	const getValue = vi.fn((_key: string) => options.dismissedUpsells)
	const setValue = vi.fn(options.setValue ?? (async (_key: string, _value: unknown) => {}))
	const postMessageToWebview = vi.fn(async (_message: unknown) => {})
	const log = vi.fn((_message: string) => {})
	const getCurrentTask = vi.fn(() => currentTask)
	const cancelTask = vi.fn(async () => {
		cancelled = true
		if (Object.hasOwn(options, "taskAfterCancel")) {
			currentTask = options.taskAfterCancel
		}
	})

	// WebviewMessageHost は 60 以上のメンバを持つため必要な分だけ生やしてキャストする
	// （既存の webview 系 spec と同じ流儀）。
	const provider = {
		contextProxy: { getValue, setValue },
		postMessageToWebview,
		log,
		getCurrentTask,
		cancelTask,
	} as unknown as WebviewMessageHost

	return {
		provider,
		getValue,
		setValue,
		postMessageToWebview,
		log,
		getCurrentTask,
		cancelTask,
		wasCancelled: () => cancelled,
		posted: () => postMessageToWebview.mock.calls.map((call) => call[0]),
	}
}

/** 表からハンドラを取り出して実行する（未登録なら false を返す）。 */
const dispatch = async (provider: WebviewMessageHost, message: WebviewMessage): Promise<boolean> => {
	const handler = uiMessageHandlers[message.type]
	if (!handler) {
		return false
	}
	await handler(provider, message)
	return true
}

const msg = (type: string, rest: Record<string, unknown> = {}): WebviewMessage =>
	({ type, ...rest }) as unknown as WebviewMessage

beforeEach(() => {
	vi.clearAllMocks()
})

// ---------------------------------------------------------------------------

describe("uiMessageHandlers", () => {
	describe("不変条件1: 未知のメッセージ種別は黙って無視される", () => {
		it.each([
			"totallyUnknownMessage",
			"",
			"switchtab", // 大文字小文字違い
			"CheckpointRestore",
			"webviewDidLaunch", // 別の表が担当する既知の type
		])("%s は表に登録されておらず、provider に一切触らない", async (type) => {
			const h = setup({ task: makeTask() })

			await expect(dispatch(h.provider, msg(type))).resolves.toBe(false)

			expect(h.postMessageToWebview).not.toHaveBeenCalled()
			expect(h.getCurrentTask).not.toHaveBeenCalled()
			expect(h.cancelTask).not.toHaveBeenCalled()
			expect(h.setValue).not.toHaveBeenCalled()
			expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		})

		it("【要確認】Object.prototype 由来のキーはハンドラとして引ける", async () => {
			// 表はプレーンオブジェクトリテラルなので、"toString" などは
			// プロトタイプチェーン経由で関数が返る。webview から壊れた type が来ると
			// 呼び出し側の `handlers[message.type]` が truthy になり、その関数が実行される。
			// 実害（throw / 副作用）は無いが、null プロトタイプでない点は記録しておく。
			const looked = (uiMessageHandlers as Record<string, unknown>)["toString"]
			expect(typeof looked).toBe("function")

			const h = setup()
			await expect(dispatch(h.provider, msg("toString"))).resolves.toBe(true)
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})
	})

	describe("focusPanelRequest", () => {
		it("拡張の focusPanel コマンドを実行する", async () => {
			const h = setup()

			await dispatch(h.provider, msg("focusPanelRequest"))

			expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith(`${Package.name}.focusPanel`)
		})
	})

	describe("switchTab", () => {
		it("tab を指定するとその内容を webview へ転送する", async () => {
			const h = setup()

			await dispatch(h.provider, msg("switchTab", { tab: "settings", values: { section: "api" } }))

			expect(h.posted()).toEqual([
				{ type: "action", action: "switchTab", tab: "settings", values: { section: "api" } },
			])
		})

		it.each([
			["tab が undefined", {}],
			["tab が空文字", { tab: "" }],
		])("%s なら何もしない", async (_label, rest) => {
			const h = setup()

			await dispatch(h.provider, msg("switchTab", rest))

			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})
	})

	describe("dismissUpsell", () => {
		it("未保存の ID なら追記して保存し、更新後リストを返す", async () => {
			const h = setup({ dismissedUpsells: ["a"] })

			await dispatch(h.provider, msg("dismissUpsell", { upsellId: "b" }))

			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("dismissedUpsells", ["a", "b"])
			expect(h.posted()).toEqual([{ type: "dismissedUpsells", list: ["a", "b"] }])
		})

		it("保存済みリストが未初期化（undefined）でも空配列から始まる", async () => {
			const h = setup({ dismissedUpsells: undefined })

			await dispatch(h.provider, msg("dismissUpsell", { upsellId: "a" }))

			expect(h.setValue).toHaveBeenCalledExactlyOnceWith("dismissedUpsells", ["a"])
			expect(h.posted()).toEqual([{ type: "dismissedUpsells", list: ["a"] }])
		})

		it("【不変条件】同じ ID を二重に受けても保存はせず、リストも重複しない", async () => {
			const h = setup({ dismissedUpsells: ["a", "b"] })

			await dispatch(h.provider, msg("dismissUpsell", { upsellId: "a" }))

			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.posted()).toEqual([{ type: "dismissedUpsells", list: ["a", "b"] }])
		})

		it.each([
			["upsellId が undefined", {}],
			["upsellId が空文字", { upsellId: "" }],
		])("%s なら何もしない", async (_label, rest) => {
			const h = setup({ dismissedUpsells: ["a"] })

			await dispatch(h.provider, msg("dismissUpsell", rest))

			expect(h.getValue).not.toHaveBeenCalled()
			expect(h.setValue).not.toHaveBeenCalled()
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("保存に失敗しても throw せずログだけ残す", async () => {
			const h = setup({
				dismissedUpsells: [],
				setValue: async () => {
					throw new Error("storage full")
				},
			})

			await expect(dispatch(h.provider, msg("dismissUpsell", { upsellId: "a" }))).resolves.toBe(true)

			expect(h.log).toHaveBeenCalledExactlyOnceWith("Failed to dismiss upsell: storage full")
			expect(h.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("Error 以外が投げられても String 化してログに残す", async () => {
			const h = setup({
				dismissedUpsells: [],
				setValue: async () => {
					throw "plain-string-failure"
				},
			})

			await dispatch(h.provider, msg("dismissUpsell", { upsellId: "a" }))

			expect(h.log).toHaveBeenCalledExactlyOnceWith("Failed to dismiss upsell: plain-string-failure")
		})
	})

	describe("getDismissedUpsells", () => {
		it("保存済みリストをそのまま返す", async () => {
			const h = setup({ dismissedUpsells: ["x", "y"] })

			await dispatch(h.provider, msg("getDismissedUpsells"))

			expect(h.posted()).toEqual([{ type: "dismissedUpsells", list: ["x", "y"] }])
		})

		it("未初期化なら空配列を返す", async () => {
			const h = setup({ dismissedUpsells: undefined })

			await dispatch(h.provider, msg("getDismissedUpsells"))

			expect(h.posted()).toEqual([{ type: "dismissedUpsells", list: [] }])
		})
	})

	describe("checkpointDiff", () => {
		const validPayload = { ts: 1, previousCommitHash: "aaa", commitHash: "bbb", mode: "checkpoint" as const }

		it("正しいペイロードなら現在タスクの checkpointDiff を呼ぶ", async () => {
			const task = makeTask()
			const h = setup({ task })

			await dispatch(h.provider, msg("checkpointDiff", { payload: validPayload }))

			expect(task.checkpointDiff).toHaveBeenCalledExactlyOnceWith(validPayload)
		})

		it("任意項目を省いたペイロードも受け付ける", async () => {
			const task = makeTask()
			const h = setup({ task })

			await dispatch(h.provider, msg("checkpointDiff", { payload: { commitHash: "bbb", mode: "full" } }))

			expect(task.checkpointDiff).toHaveBeenCalledExactlyOnceWith({ commitHash: "bbb", mode: "full" })
		})

		it.each([
			["payload が undefined", undefined],
			["payload が null", null],
			["commitHash が無い", { mode: "full" }],
			["mode が未知の値", { commitHash: "bbb", mode: "unknown-mode" }],
			["commitHash が数値", { commitHash: 1, mode: "full" }],
			["payload が文字列", "not-an-object"],
		])("【不変条件】%s ならタスクに触らない", async (_label, payload) => {
			const task = makeTask()
			const h = setup({ task })

			await expect(dispatch(h.provider, msg("checkpointDiff", { payload }))).resolves.toBe(true)

			expect(task.checkpointDiff).not.toHaveBeenCalled()
		})

		it("現在タスクが無くても throw しない", async () => {
			const h = setup({ task: undefined })

			await expect(dispatch(h.provider, msg("checkpointDiff", { payload: validPayload }))).resolves.toBe(true)
		})

		it("【要確認】checkpointDiff が投げた例外は握り潰されずに伝播する", async () => {
			// checkpointRestore 側には try/catch があるが diff 側には無い。
			const task = makeTask({ diffThrows: true })
			const h = setup({ task })

			await expect(dispatch(h.provider, msg("checkpointDiff", { payload: validPayload }))).rejects.toThrow(
				"diff boom",
			)
		})
	})

	describe("checkpointRestore", () => {
		const validPayload = { ts: 1, commitHash: "bbb", mode: "restore" as const }

		it("正しいペイロードならタスクを中断してから復元する", async () => {
			const task = makeTask({ isInitialized: true })
			const h = setup({ task })

			await dispatch(h.provider, msg("checkpointRestore", { payload: validPayload }))

			expect(h.cancelTask).toHaveBeenCalledOnce()
			expect(task.checkpointRestore).toHaveBeenCalledExactlyOnceWith(validPayload)
			// 中断が復元より先。逆だと復元中のファイルに実行中タスクが書き込む。
			expect(h.cancelTask.mock.invocationCallOrder[0]).toBeLessThan(
				(task.checkpointRestore.mock.invocationCallOrder as number[])[0],
			)
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it.each([
			["payload が undefined", undefined],
			["payload が null", null],
			["ts が無い", { commitHash: "bbb", mode: "restore" }],
			["commitHash が無い", { ts: 1, mode: "restore" }],
			["mode が未知の値", { ts: 1, commitHash: "bbb", mode: "rollback" }],
			["ts が文字列", { ts: "1", commitHash: "bbb", mode: "restore" }],
		])("【不変条件】%s ならタスクを中断しない", async (_label, payload) => {
			const task = makeTask()
			const h = setup({ task })

			await expect(dispatch(h.provider, msg("checkpointRestore", { payload }))).resolves.toBe(true)

			// 壊れたメッセージで実行中タスクが止まると、ユーザーの作業が黙って中断される。
			expect(h.cancelTask).not.toHaveBeenCalled()
			expect(task.checkpointRestore).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("再水和後のタスクが初期化されなければタイムアウトを通知しつつ復元を試みる", async () => {
			// isInitialized が false のままなので pWaitFor が 3 秒でタイムアウトする経路。
			const task = makeTask({ isInitialized: false })
			const h = setup({ task })

			await dispatch(h.provider, msg("checkpointRestore", { payload: validPayload }))

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.checkpoint_timeout")
			// タイムアウトしても復元自体は試みる（実装の意図）。
			expect(task.checkpointRestore).toHaveBeenCalledOnce()
		}, 15_000)

		it("復元が失敗したらエラーダイアログを出して握り潰す", async () => {
			const task = makeTask({ isInitialized: true, restoreThrows: true })
			const h = setup({ task })

			await expect(dispatch(h.provider, msg("checkpointRestore", { payload: validPayload }))).resolves.toBe(true)

			expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith("common:errors.checkpoint_failed")
		})

		it("中断後にタスクが消えていても throw しない（タイムアウト通知のみ）", async () => {
			const task = makeTask({ isInitialized: true })
			const h = setup({ task, taskAfterCancel: undefined })

			await expect(dispatch(h.provider, msg("checkpointRestore", { payload: validPayload }))).resolves.toBe(true)

			expect(task.checkpointRestore).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith("common:errors.checkpoint_timeout")
		}, 15_000)
	})
})
