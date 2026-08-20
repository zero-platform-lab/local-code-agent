import { describe, it, expect, vi, afterEach } from "vitest"

import { AgentEventName, type ClineAsk, type ClineMessage } from "@openai-agent/types"

import { scheduleAskStatusMutation } from "../scheduleAskStatusMutation"

const ASK_TS = 12_345

function makeHost(opts: { message?: ClineMessage | undefined; hasMessage?: boolean } = {}) {
	// hasMessage 未指定なら message あり扱い（既定は ts 付きの適当なメッセージ）
	const message: ClineMessage | undefined =
		opts.hasMessage === false ? undefined : ((opts.message ?? { ts: ASK_TS }) as ClineMessage)

	return {
		findMessageByTimestamp: vi.fn((_ts: number): ClineMessage | undefined => message),
		setInteractiveAsk: vi.fn((_m: ClineMessage) => {}),
		setResumableAsk: vi.fn((_m: ClineMessage) => {}),
		setIdleAsk: vi.fn((_m: ClineMessage) => {}),
		emit: vi.fn((..._a: unknown[]): unknown => undefined),
		taskId: "task-1",
		postMessageToWebview: vi.fn((_m: { type: "interactionRequired" }) => {}),
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe("scheduleAskStatusMutation", () => {
	it("interactive ask（followup）: 2秒後に setInteractiveAsk→emit(TaskInteractive)→webview 通知し、返り値は Timeout", () => {
		vi.useFakeTimers()
		const host = makeHost()

		const timeout = scheduleAskStatusMutation(host as never, "followup" as ClineAsk, ASK_TS)

		// タイマーが1本張られ、まだ発火していない
		expect(timeout).toBeDefined()
		expect(vi.getTimerCount()).toBe(1)
		expect(host.setInteractiveAsk).not.toHaveBeenCalled()

		// 1999ms では発火しない（2秒ちょうどが契約）
		vi.advanceTimersByTime(1_999)
		expect(host.setInteractiveAsk).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(host.findMessageByTimestamp).toHaveBeenCalledWith(ASK_TS)
		expect(host.setInteractiveAsk).toHaveBeenCalledWith({ ts: ASK_TS })
		expect(host.emit).toHaveBeenCalledWith(AgentEventName.TaskInteractive, "task-1")
		expect(host.postMessageToWebview).toHaveBeenCalledWith({ type: "interactionRequired" })
		// 他状態には遷移させない
		expect(host.setResumableAsk).not.toHaveBeenCalled()
		expect(host.setIdleAsk).not.toHaveBeenCalled()
	})

	it("interactive ask: 発火時に対象メッセージが消えていれば何も遷移させず webview 通知もしない", () => {
		vi.useFakeTimers()
		const host = makeHost({ hasMessage: false })

		scheduleAskStatusMutation(host as never, "tool" as ClineAsk, ASK_TS)
		vi.advanceTimersByTime(2_000)

		expect(host.findMessageByTimestamp).toHaveBeenCalledWith(ASK_TS)
		expect(host.setInteractiveAsk).not.toHaveBeenCalled()
		expect(host.emit).not.toHaveBeenCalled()
		expect(host.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("resumable ask（resume_task）: 2秒後に setResumableAsk→emit(TaskResumable)、webview 通知はしない", () => {
		vi.useFakeTimers()
		const host = makeHost()

		const timeout = scheduleAskStatusMutation(host as never, "resume_task" as ClineAsk, ASK_TS)
		expect(timeout).toBeDefined()

		vi.advanceTimersByTime(2_000)

		expect(host.setResumableAsk).toHaveBeenCalledWith({ ts: ASK_TS })
		expect(host.emit).toHaveBeenCalledWith(AgentEventName.TaskResumable, "task-1")
		expect(host.postMessageToWebview).not.toHaveBeenCalled()
		expect(host.setInteractiveAsk).not.toHaveBeenCalled()
		expect(host.setIdleAsk).not.toHaveBeenCalled()
	})

	it("resumable ask: メッセージが消えていれば setResumableAsk も emit も呼ばない", () => {
		vi.useFakeTimers()
		const host = makeHost({ hasMessage: false })

		scheduleAskStatusMutation(host as never, "resume_task" as ClineAsk, ASK_TS)
		vi.advanceTimersByTime(2_000)

		expect(host.setResumableAsk).not.toHaveBeenCalled()
		expect(host.emit).not.toHaveBeenCalled()
	})

	it("idle ask（completion_result）: 2秒後に setIdleAsk→emit(TaskIdle)、webview 通知はしない", () => {
		vi.useFakeTimers()
		const host = makeHost()

		const timeout = scheduleAskStatusMutation(host as never, "completion_result" as ClineAsk, ASK_TS)
		expect(timeout).toBeDefined()

		vi.advanceTimersByTime(2_000)

		expect(host.setIdleAsk).toHaveBeenCalledWith({ ts: ASK_TS })
		expect(host.emit).toHaveBeenCalledWith(AgentEventName.TaskIdle, "task-1")
		expect(host.postMessageToWebview).not.toHaveBeenCalled()
		expect(host.setInteractiveAsk).not.toHaveBeenCalled()
		expect(host.setResumableAsk).not.toHaveBeenCalled()
	})

	it("idle ask: メッセージが消えていれば setIdleAsk も emit も呼ばない", () => {
		vi.useFakeTimers()
		const host = makeHost({ hasMessage: false })

		scheduleAskStatusMutation(host as never, "api_req_failed" as ClineAsk, ASK_TS)
		vi.advanceTimersByTime(2_000)

		expect(host.setIdleAsk).not.toHaveBeenCalled()
		expect(host.emit).not.toHaveBeenCalled()
	})

	it("非対象 ask（command_output）: タイマーを張らず undefined を返す", () => {
		vi.useFakeTimers()
		const host = makeHost()

		const timeout = scheduleAskStatusMutation(host as never, "command_output" as ClineAsk, ASK_TS)

		expect(timeout).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)

		// 念のため時間を進めても何も起きない
		vi.advanceTimersByTime(2_000)
		expect(host.findMessageByTimestamp).not.toHaveBeenCalled()
		expect(host.setInteractiveAsk).not.toHaveBeenCalled()
		expect(host.setResumableAsk).not.toHaveBeenCalled()
		expect(host.setIdleAsk).not.toHaveBeenCalled()
	})
})
