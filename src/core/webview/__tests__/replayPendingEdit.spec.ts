import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { ClineMessage } from "@openai-agent/types"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import type { PendingEditOperation } from "../PendingEditOperationManager"
import { replayPendingEdit, schedulePendingEditReplay, type PendingEditTarget } from "../replayPendingEdit"

const msg = (ts: number): ClineMessage => ({ ts, type: "say", say: "text", text: `m${ts}` }) as ClineMessage
const apiMsg = (ts: number): ApiMessage => ({ ts, role: "user", content: `a${ts}` }) as ApiMessage

const makeTask = (
	overrides: Partial<PendingEditTarget> = {},
	messages: Partial<PendingEditTarget["messageStore"]> = {},
) => {
	const task = {
		taskId: "task-1",
		messageStore: {
			clineMessages: [msg(1), msg(2), msg(3)],
			apiConversationHistory: [apiMsg(1), apiMsg(2), apiMsg(3)],
			...messages,
		},
		overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
		overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		handleWebviewAskResponse: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as PendingEditTarget

	return task
}

const pendingEdit = (overrides: Partial<PendingEditOperation> = {}): PendingEditOperation =>
	({
		messageTs: 2,
		editedContent: "edited!",
		images: ["img"],
		messageIndex: 1,
		apiConversationHistoryIndex: 1,
		timeoutId: undefined,
		createdAt: 0,
		...overrides,
	}) as unknown as PendingEditOperation

describe("replayPendingEdit", () => {
	it("編集対象以降を UI 履歴と API 履歴の両方から切り落として再投入する", async () => {
		const task = makeTask()

		await replayPendingEdit(task, pendingEdit())

		expect(task.overwriteClineMessages).toHaveBeenCalledWith([msg(1)])
		expect(task.overwriteApiConversationHistory).toHaveBeenCalledWith([apiMsg(1)])
		expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "edited!", ["img"])
	})

	it("対象メッセージが UI 履歴に無ければ何もしない", async () => {
		const task = makeTask()

		await replayPendingEdit(task, pendingEdit({ messageTs: 999 }))

		expect(task.overwriteClineMessages).not.toHaveBeenCalled()
		expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("API 履歴に対応するメッセージが無ければ UI 履歴だけ切り落とす", async () => {
		const task = makeTask({}, { apiConversationHistory: [apiMsg(10)] })

		await replayPendingEdit(task, pendingEdit())

		expect(task.overwriteClineMessages).toHaveBeenCalledWith([msg(1)])
		expect(task.overwriteApiConversationHistory).not.toHaveBeenCalled()
		expect(task.handleWebviewAskResponse).toHaveBeenCalled()
	})
})

describe("schedulePendingEditReplay", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("保留が無ければ no-op（false を返す）", () => {
		const task = makeTask()
		const store = { get: vi.fn().mockReturnValue(undefined), clear: vi.fn() }

		expect(schedulePendingEditReplay(task, store, vi.fn())).toBe(false)
		expect(store.clear).not.toHaveBeenCalled()
	})

	it("タスク id から operation id を引き当て、予約前に保留を解除する", async () => {
		const task = makeTask()
		const store = { get: vi.fn().mockReturnValue(pendingEdit()), clear: vi.fn().mockReturnValue(true) }

		expect(schedulePendingEditReplay(task, store, vi.fn())).toBe(true)
		expect(store.get).toHaveBeenCalledWith("task-task-1")
		expect(store.clear).toHaveBeenCalledWith("task-task-1")

		// 予約は遅延実行（タスクの復元完了を待つ）
		expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(100)

		expect(task.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "edited!", ["img"])
	})

	it("再生が失敗しても throw せず log に落とす", async () => {
		const log = vi.fn()
		const task = makeTask({
			overwriteClineMessages: vi.fn().mockRejectedValue(new Error("replay boom")),
		})
		const store = { get: vi.fn().mockReturnValue(pendingEdit()), clear: vi.fn() }

		schedulePendingEditReplay(task, store, log)
		await vi.advanceTimersByTimeAsync(100)

		expect(log).toHaveBeenCalledWith(expect.stringContaining("replay boom"))
	})
})
