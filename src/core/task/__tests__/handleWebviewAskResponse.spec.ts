import { describe, it, expect, vi, afterEach } from "vitest"

import { type ClineMessage } from "@openai-agent/types"

import { AskState } from "../AskState"
import { handleWebviewAskResponse, type HandleWebviewAskResponseStateHost } from "../handleWebviewAskResponse"

type TestMsg = { type: string; ask?: string; say?: string; isAnswered?: boolean }

function makeHost(messages: TestMsg[], opts: { saveRejects?: boolean } = {}) {
	const askState = new AskState()
	const checkpointSave = vi.fn((..._a: unknown[]) => Promise.resolve())
	const updateClineMessage = vi.fn((..._a: unknown[]) => Promise.resolve())
	const saveClineMessages = vi.fn((..._a: unknown[]) =>
		opts.saveRejects ? Promise.reject(new Error("db down")) : Promise.resolve(),
	)
	const host: HandleWebviewAskResponseStateHost = {
		askState,
		messageStore: { clineMessages: messages as unknown as ClineMessage[] },
		checkpointSave,
		updateClineMessage,
		saveClineMessages,
	}
	return { host, askState, checkpointSave, updateClineMessage, saveClineMessages }
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
	vi.restoreAllMocks()
})

describe("handleWebviewAskResponse", () => {
	it("messageResponse: 応答3フィールドを反映し auto-approval タイマーを取り消し、checkpoint を chatRow 抑制付きで作り、直近未回答 followup を answered にして保存する", () => {
		// 降順スキャンで followup predicate の各分岐（type!=ask / ask!=followup / 既回答）を通す並び
		const messages: TestMsg[] = [
			{ type: "ask", ask: "followup", isAnswered: false }, // マッチ（最後に評価される最下位 index）
			{ type: "ask", ask: "followup", isAnswered: true }, // 既回答 followup
			{ type: "ask", ask: "command", isAnswered: false }, // ask!=followup
			{ type: "say", say: "hello" }, // type!=ask
		]
		const { host, askState, checkpointSave, saveClineMessages } = makeHost(messages)
		askState.autoApprovalTimeoutRef = setTimeout(() => {}, 100000)

		handleWebviewAskResponse({ host }, "messageResponse", "hi there", ["img-a"])

		expect(askState.askResponse).toBe("messageResponse")
		expect(askState.askResponseText).toBe("hi there")
		expect(askState.askResponseImages).toEqual(["img-a"])
		expect(askState.autoApprovalTimeoutRef).toBeUndefined()
		expect(checkpointSave).toHaveBeenCalledWith(false, true)
		expect(messages[0].isAnswered).toBe(true)
		expect(saveClineMessages).toHaveBeenCalledTimes(1)
	})

	it("yesButtonClicked: checkpoint は作らず、直近未回答 tool を answered にして updateClineMessage と保存を呼ぶ（followup は無ければ保存しない）", () => {
		// 降順スキャンで tool predicate の各分岐（type!=ask / ask!=tool / 既回答）を通す並び。followup は不在。
		const messages: TestMsg[] = [
			{ type: "ask", ask: "tool", isAnswered: false }, // マッチ
			{ type: "ask", ask: "tool", isAnswered: true }, // 既回答 tool
			{ type: "ask", ask: "command", isAnswered: false }, // ask!=tool
			{ type: "say", say: "hello" }, // type!=ask
		]
		const { host, checkpointSave, updateClineMessage, saveClineMessages } = makeHost(messages)

		handleWebviewAskResponse({ host }, "yesButtonClicked", undefined, undefined)

		expect(checkpointSave).not.toHaveBeenCalled()
		expect(messages[0].isAnswered).toBe(true)
		expect(updateClineMessage).toHaveBeenCalledTimes(1)
		expect(updateClineMessage).toHaveBeenCalledWith(messages[0])
		// followup は不在なので保存は tool 1 回のみ
		expect(saveClineMessages).toHaveBeenCalledTimes(1)
	})

	it("yesButtonClicked: 未回答の followup と tool が両方あれば双方を answered にし、保存を2回呼ぶ", () => {
		const messages: TestMsg[] = [
			{ type: "ask", ask: "followup", isAnswered: false },
			{ type: "ask", ask: "tool", isAnswered: false },
		]
		const { host, updateClineMessage, saveClineMessages } = makeHost(messages)

		handleWebviewAskResponse({ host }, "yesButtonClicked", undefined, undefined)

		expect(messages[0].isAnswered).toBe(true)
		expect(messages[1].isAnswered).toBe(true)
		expect(updateClineMessage).toHaveBeenCalledWith(messages[1])
		expect(saveClineMessages).toHaveBeenCalledTimes(2)
	})

	it("noButtonClicked: 応答3フィールドは反映するが checkpoint も answered マークも保存も一切行わない", () => {
		const messages: TestMsg[] = [
			{ type: "ask", ask: "followup", isAnswered: false },
			{ type: "ask", ask: "tool", isAnswered: false },
		]
		const { host, askState, checkpointSave, updateClineMessage, saveClineMessages } = makeHost(messages)

		handleWebviewAskResponse({ host }, "noButtonClicked", "nope", undefined)

		expect(askState.askResponse).toBe("noButtonClicked")
		expect(askState.askResponseText).toBe("nope")
		expect(askState.askResponseImages).toBeUndefined()
		expect(checkpointSave).not.toHaveBeenCalled()
		expect(updateClineMessage).not.toHaveBeenCalled()
		expect(saveClineMessages).not.toHaveBeenCalled()
		expect(messages[0].isAnswered).toBe(false)
		expect(messages[1].isAnswered).toBe(false)
	})

	it("yesButtonClicked で未回答 tool が無ければ、tool のマークも updateClineMessage も保存も行わない", () => {
		const messages: TestMsg[] = [{ type: "ask", ask: "tool", isAnswered: true }]
		const { host, updateClineMessage, saveClineMessages } = makeHost(messages)

		handleWebviewAskResponse({ host }, "yesButtonClicked", undefined, undefined)

		expect(updateClineMessage).not.toHaveBeenCalled()
		expect(saveClineMessages).not.toHaveBeenCalled()
	})

	it("保存が失敗しても throw せず、followup と tool それぞれの失敗を console.error に落とすだけ", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const messages: TestMsg[] = [
			{ type: "ask", ask: "followup", isAnswered: false },
			{ type: "ask", ask: "tool", isAnswered: false },
		]
		const { host } = makeHost(messages, { saveRejects: true })

		// 同期的には throw しない
		expect(() => handleWebviewAskResponse({ host }, "yesButtonClicked", undefined, undefined)).not.toThrow()
		await flushMicrotasks()

		expect(errorSpy).toHaveBeenCalledWith("Failed to save answered follow-up state:", expect.any(Error))
		expect(errorSpy).toHaveBeenCalledWith("Failed to save answered tool-ask state:", expect.any(Error))
	})
})
