import { describe, it, expect, vi } from "vitest"

import type { ClineMessage, ToolProgressStatus } from "@openai-agent/types"

import { upsertAskMessage } from "../upsertAskMessage"
import { AskIgnoredError } from "../AskIgnoredError"

function makeDeps(clineMessages: ClineMessage[] = []) {
	const setLastMessageTs = vi.fn((..._a: unknown[]) => undefined)
	const resetAskResponse = vi.fn((..._a: unknown[]) => undefined)
	const addToClineMessages = vi.fn((..._a: unknown[]) => Promise.resolve())
	const saveClineMessages = vi.fn((..._a: unknown[]) => Promise.resolve())
	const updateClineMessage = vi.fn((..._a: unknown[]) => undefined)
	const deps = {
		clineMessages,
		setLastMessageTs,
		resetAskResponse,
		addToClineMessages,
		saveClineMessages,
		updateClineMessage,
	}
	return { deps, setLastMessageTs, resetAskResponse, addToClineMessages, saveClineMessages, updateClineMessage }
}

function askMessage(overrides: Partial<ClineMessage>): ClineMessage {
	return { ts: 111, type: "ask", ask: "followup", partial: true, text: "old", ...overrides } as ClineMessage
}

describe("upsertAskMessage", () => {
	it("partial 未指定：ask をリセットしてから新規メッセージを append し、partial キーは含めない", async () => {
		const { deps, resetAskResponse, addToClineMessages, setLastMessageTs, saveClineMessages, updateClineMessage } =
			makeDeps()

		const result = await upsertAskMessage(deps as never, { type: "followup", text: "hello", isProtected: true })

		expect(resetAskResponse).toHaveBeenCalledTimes(1)
		expect(addToClineMessages).toHaveBeenCalledTimes(1)
		const msg = addToClineMessages.mock.calls[0][0] as ClineMessage
		expect(msg).toMatchObject({ type: "ask", ask: "followup", text: "hello", isProtected: true })
		// complete/非 partial メッセージは partial フラグを持たない契約
		expect(msg).not.toHaveProperty("partial")
		expect(msg.ts).toBe(result.askTs)
		expect(setLastMessageTs).toHaveBeenCalledWith(result.askTs)
		expect(saveClineMessages).not.toHaveBeenCalled()
		expect(updateClineMessage).not.toHaveBeenCalled()
	})

	it("partial=true・直前メッセージ無し：partial 付きで append し AskIgnoredError('new partial') を投げる（reset は呼ばない）", async () => {
		const { deps, addToClineMessages, resetAskResponse, updateClineMessage, setLastMessageTs } = makeDeps()

		const err = (await upsertAskMessage(deps as never, {
			type: "command",
			text: "part",
			partial: true,
			isProtected: false,
		}).catch((e: unknown) => e)) as AskIgnoredError

		expect(err).toBeInstanceOf(AskIgnoredError)
		expect(err.message).toContain("new partial")
		expect(addToClineMessages).toHaveBeenCalledTimes(1)
		const msg = addToClineMessages.mock.calls[0][0] as ClineMessage
		expect(msg).toMatchObject({ type: "ask", ask: "command", text: "part", partial: true, isProtected: false })
		expect(setLastMessageTs).toHaveBeenCalledWith(msg.ts)
		// 新規 partial 追加は askResponse をリセットしない
		expect(resetAskResponse).not.toHaveBeenCalled()
		expect(updateClineMessage).not.toHaveBeenCalled()
	})

	it("partial=true・直前が同種の partial ask：既存を in-place 更新し update を呼び AskIgnoredError('updating existing partial') を投げる", async () => {
		const last = askMessage({ ts: 111, type: "ask", ask: "followup", partial: true, text: "old" })
		const { deps, updateClineMessage, addToClineMessages, resetAskResponse, saveClineMessages, setLastMessageTs } =
			makeDeps([last])
		const progressStatus: ToolProgressStatus = { icon: "spinner", text: "running" }

		const err = (await upsertAskMessage(deps as never, {
			type: "followup",
			text: "new",
			partial: true,
			progressStatus,
			isProtected: true,
		}).catch((e: unknown) => e)) as AskIgnoredError

		expect(err).toBeInstanceOf(AskIgnoredError)
		expect(err.message).toContain("updating existing partial")
		// 同一オブジェクトを直接書き換える
		expect(last.text).toBe("new")
		expect(last.partial).toBe(true)
		expect(last.progressStatus).toBe(progressStatus)
		expect(last.isProtected).toBe(true)
		expect(updateClineMessage).toHaveBeenCalledTimes(1)
		expect(updateClineMessage.mock.calls[0][0]).toBe(last)
		expect(addToClineMessages).not.toHaveBeenCalled()
		expect(resetAskResponse).not.toHaveBeenCalled()
		expect(saveClineMessages).not.toHaveBeenCalled()
		// 更新経路では lastMessageTs を触らない（ts を安定させるため）
		expect(setLastMessageTs).not.toHaveBeenCalled()
	})

	it("partial=false・直前が同種の partial ask：元の ts を保持したまま complete 化し、save→update の順で反映する", async () => {
		const last = askMessage({ ts: 999, type: "ask", ask: "tool", partial: true, text: "old" })
		const { deps, resetAskResponse, saveClineMessages, updateClineMessage, addToClineMessages, setLastMessageTs } =
			makeDeps([last])
		const progressStatus: ToolProgressStatus = { icon: "check", text: "done" }

		const result = await upsertAskMessage(deps as never, {
			type: "tool",
			text: "final",
			partial: false,
			progressStatus,
			isProtected: false,
		})

		// Date.now() ではなく既存 ts を維持する（webview の key 安定性）
		expect(result.askTs).toBe(999)
		expect(setLastMessageTs).toHaveBeenCalledWith(999)
		expect(resetAskResponse).toHaveBeenCalledTimes(1)
		expect(last.text).toBe("final")
		expect(last.partial).toBe(false)
		expect(last.progressStatus).toBe(progressStatus)
		expect(last.isProtected).toBe(false)
		expect(saveClineMessages).toHaveBeenCalledTimes(1)
		expect(updateClineMessage).toHaveBeenCalledWith(last)
		// save が update より先に走る
		expect(saveClineMessages.mock.invocationCallOrder[0]).toBeLessThan(
			updateClineMessage.mock.invocationCallOrder[0],
		)
		expect(addToClineMessages).not.toHaveBeenCalled()
	})

	it("partial=false・直前が partial でない：reset して新規 complete を append し、partial キーは含めない", async () => {
		const last = askMessage({ ts: 5, type: "ask", ask: "followup", partial: false })
		const { deps, resetAskResponse, addToClineMessages, saveClineMessages, updateClineMessage, setLastMessageTs } =
			makeDeps([last])

		const result = await upsertAskMessage(deps as never, { type: "followup", text: "hi", partial: false })

		expect(resetAskResponse).toHaveBeenCalledTimes(1)
		expect(addToClineMessages).toHaveBeenCalledTimes(1)
		const msg = addToClineMessages.mock.calls[0][0] as ClineMessage
		expect(msg).toMatchObject({ type: "ask", ask: "followup", text: "hi" })
		expect(msg).not.toHaveProperty("partial")
		expect(msg.ts).toBe(result.askTs)
		expect(setLastMessageTs).toHaveBeenCalledWith(result.askTs)
		expect(saveClineMessages).not.toHaveBeenCalled()
		expect(updateClineMessage).not.toHaveBeenCalled()
	})

	it("partial=true・直前が partial だが say タイプ：更新扱いにせず新規 partial を append する", async () => {
		const last = { ts: 3, type: "say", partial: true, text: "x" } as ClineMessage
		const { deps, addToClineMessages, updateClineMessage } = makeDeps([last])

		const err = (await upsertAskMessage(deps as never, {
			type: "followup",
			text: "p",
			partial: true,
		}).catch((e: unknown) => e)) as AskIgnoredError

		expect(err).toBeInstanceOf(AskIgnoredError)
		expect(err.message).toContain("new partial")
		expect(addToClineMessages).toHaveBeenCalledTimes(1)
		expect(updateClineMessage).not.toHaveBeenCalled()
	})

	it("partial=true・直前が partial ask だが ask 種別が異なる：更新扱いにせず新規 partial を append する", async () => {
		const last = askMessage({ ts: 7, type: "ask", ask: "command", partial: true })
		const { deps, addToClineMessages, updateClineMessage } = makeDeps([last])

		const err = (await upsertAskMessage(deps as never, {
			type: "followup",
			text: "p",
			partial: true,
		}).catch((e: unknown) => e)) as AskIgnoredError

		expect(err).toBeInstanceOf(AskIgnoredError)
		expect(addToClineMessages).toHaveBeenCalledTimes(1)
		const msg = addToClineMessages.mock.calls[0][0] as ClineMessage
		expect(msg.ask).toBe("followup")
		expect(updateClineMessage).not.toHaveBeenCalled()
	})
})
