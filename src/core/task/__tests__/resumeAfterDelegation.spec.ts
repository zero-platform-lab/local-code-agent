import { describe, it, expect, vi, beforeEach } from "vitest"

import { resumeAfterDelegation } from "../resumeAfterDelegation"

vi.mock("../../environment/getEnvironmentDetails", () => ({ getEnvironmentDetails: vi.fn(async () => "ENV") }))

import { getEnvironmentDetails } from "../../environment/getEnvironmentDetails"

const mockedEnv = vi.mocked(getEnvironmentDetails)

function makeHost(history: unknown[] = []) {
	return {
		taskId: "t1",
		askState: { clearAsks: vi.fn() },
		abort: true,
		abandoned: true,
		abortReason: "streaming_failed" as string | undefined,
		didFinishAbortingStream: true,
		stream: { isStreaming: true, isWaitingForFirstChunk: true },
		isInitialized: false,
		messageStore: { apiConversationHistory: history },
		getSavedApiConversationHistory: vi.fn(async () => [
			{ role: "user", content: [{ type: "text", text: "loaded" }] },
		]),
		saveApiConversationHistory: vi.fn(async () => {}),
		initiateTaskLoop: vi.fn(async () => {}),
		emit: vi.fn(),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedEnv.mockResolvedValue("ENV" as never)
})

describe("resumeAfterDelegation", () => {
	it("abort/streaming state をリセットし、初期化フラグ立て・TaskActive を emit する", async () => {
		const host = makeHost([{ role: "user", content: [{ type: "text", text: "orig" }] }])

		await resumeAfterDelegation({ host } as never)

		expect(host.askState.clearAsks).toHaveBeenCalledTimes(1)
		expect(host.abort).toBe(false)
		expect(host.abandoned).toBe(false)
		expect(host.abortReason).toBeUndefined()
		expect(host.didFinishAbortingStream).toBe(false)
		expect(host.stream.isStreaming).toBe(false)
		expect(host.stream.isWaitingForFirstChunk).toBe(false)
		expect(host.isInitialized).toBe(true)
		expect(host.emit).toHaveBeenCalledWith("taskActive", "t1")
	})

	it("履歴が空なら getSavedApiConversationHistory から読み込む", async () => {
		const host = makeHost([])

		await resumeAfterDelegation({ host } as never)

		expect(host.getSavedApiConversationHistory).toHaveBeenCalledTimes(1)
		// 読み込んだ履歴が使われている（末尾 user に ENV が足される）
		expect(host.messageStore.apiConversationHistory.length).toBeGreaterThan(0)
	})

	it("履歴が既にあれば再読み込みしない", async () => {
		const host = makeHost([{ role: "user", content: [{ type: "text", text: "orig" }] }])

		await resumeAfterDelegation({ host } as never)

		expect(host.getSavedApiConversationHistory).not.toHaveBeenCalled()
	})

	it("environment_details を独立した user item として末尾に足す", async () => {
		// item 列では environment_details は content 配列の一要素ではなく独立 item。
		// 既存メッセージへの追記ではなく、新しい item の push になる。
		const host = makeHost([
			{ type: "message", role: "assistant", content: "a" },
			{ type: "message", role: "user", content: "orig" },
		])

		await resumeAfterDelegation({ host } as never)

		expect(mockedEnv).toHaveBeenCalledWith(host, true)
		const history = host.messageStore.apiConversationHistory
		expect(history).toHaveLength(3)
		expect(history[1]).toEqual({ type: "message", role: "user", content: "orig" })
		expect(history[2]).toMatchObject({ type: "message", role: "user", content: "ENV" })
	})

	it("古い environment_details item は取り除いてから足し直す", async () => {
		const host = makeHost([
			{ type: "message", role: "assistant", content: "a" },
			{ type: "message", role: "user", content: "<environment_details>\nold\n</environment_details>" },
		])

		await resumeAfterDelegation({ host } as never)

		const history = host.messageStore.apiConversationHistory
		// 古い env item は消え、新しいものが 1 つだけ残る
		expect(history).toHaveLength(2)
		expect(history[0]).toEqual({ type: "message", role: "assistant", content: "a" })
		expect(history[1]).toMatchObject({ type: "message", role: "user", content: "ENV" })
	})

	it("user メッセージが無くても env を足し、save と initiateTaskLoop は行う", async () => {
		const host = makeHost([{ type: "message", role: "assistant", content: "a" }])

		await resumeAfterDelegation({ host } as never)

		expect(host.messageStore.apiConversationHistory).toHaveLength(2)
		expect(host.saveApiConversationHistory).toHaveBeenCalledTimes(1)
		expect(host.initiateTaskLoop).toHaveBeenCalledWith([])
	})
})
