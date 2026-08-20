import type { ClineMessage } from "@openai-agent/types"
import { describe, it, expect, vi } from "vitest"

import { finalizeReasoningMessage } from "../finalizeReasoningMessage"

// findLastIndex は純粋な utility なのでモックせず実挙動を通す。
function makeDeps(clineMessages: unknown[]) {
	const host = { messageStore: { clineMessages } }
	const updateClineMessage = vi.fn(async () => {})
	const deps = { host, updateClineMessage }
	return { deps, host, updateClineMessage }
}

describe("finalizeReasoningMessage", () => {
	it("reasoningMessage が空文字なら早期 return し、partial も更新しない", async () => {
		const messages = [{ type: "say", say: "reasoning", partial: true, ts: 1 }]
		const { deps, updateClineMessage } = makeDeps(messages)

		await finalizeReasoningMessage(deps as never, "")

		expect(updateClineMessage).not.toHaveBeenCalled()
		expect(messages[0].partial).toBe(true)
	})

	it("末尾でない partial な reasoning を findLastIndex で見つけ、partial=false にして updateClineMessage へ渡す", async () => {
		const messages = [
			{ type: "say", say: "text", partial: false, ts: 1 },
			{ type: "say", say: "reasoning", partial: true, ts: 2 },
			{ type: "say", say: "text", partial: false, ts: 3 },
			{ type: "ask", ask: "tool", partial: false, ts: 4 },
		]
		const { deps, updateClineMessage } = makeDeps(messages)

		await finalizeReasoningMessage(deps as never, "some reasoning")

		expect(messages[1].partial).toBe(false)
		// 確定した当のメッセージ（参照そのもの）を 1 回だけ永続化する
		expect(updateClineMessage).toHaveBeenCalledTimes(1)
		expect(updateClineMessage).toHaveBeenCalledWith(messages[1] as ClineMessage)
	})

	it("reasoning メッセージが存在しなければ updateClineMessage を呼ばない", async () => {
		const messages = [
			{ type: "say", say: "text", partial: false, ts: 1 },
			{ type: "ask", ask: "tool", partial: true, ts: 2 },
		]
		const { deps, updateClineMessage } = makeDeps(messages)

		await finalizeReasoningMessage(deps as never, "some reasoning")

		expect(updateClineMessage).not.toHaveBeenCalled()
	})

	it("最後の reasoning が既に確定済み（partial=false）なら何もしない", async () => {
		const messages = [{ type: "say", say: "reasoning", partial: false, ts: 1 }]
		const { deps, updateClineMessage } = makeDeps(messages)

		await finalizeReasoningMessage(deps as never, "some reasoning")

		expect(updateClineMessage).not.toHaveBeenCalled()
		expect(messages[0].partial).toBe(false)
	})

	it("reasoning が複数ある場合は最後のものだけ確定し、前の reasoning は触らない", async () => {
		const messages = [
			{ type: "say", say: "reasoning", partial: true, ts: 1 },
			{ type: "say", say: "text", partial: false, ts: 2 },
			{ type: "say", say: "reasoning", partial: true, ts: 3 },
		]
		const { deps, updateClineMessage } = makeDeps(messages)

		await finalizeReasoningMessage(deps as never, "some reasoning")

		expect(messages[2].partial).toBe(false)
		expect(messages[0].partial).toBe(true)
		expect(updateClineMessage).toHaveBeenCalledTimes(1)
		expect(updateClineMessage).toHaveBeenCalledWith(messages[2] as ClineMessage)
	})
})
