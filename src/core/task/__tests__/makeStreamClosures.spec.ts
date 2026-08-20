import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ClineMessage } from "@openai-agent/types"

vi.mock("../apiReqMessageUpdater", () => ({
	updateApiReqMsg: vi.fn(),
	abortStream: vi.fn(),
}))

import { makeStreamClosures, type MakeStreamClosuresInput } from "../makeStreamClosures"
import { updateApiReqMsg, abortStream } from "../apiReqMessageUpdater"

const mockedUpdate = vi.mocked(updateApiReqMsg)
const mockedAbort = vi.mocked(abortStream)

// makeStreamClosures は factory。生成した 2 closure が host/input を deps に束ねて
// apiReqMessageUpdater の実装へ配線されること（＋引数の素通し・live 参照）を検証する。
const streamModelInfo = { contextWindow: 200_000 } as never

function makeHost() {
	return {
		diffViewProvider: { isEditing: false, revertChanges: vi.fn(async () => {}) },
		messageStore: { clineMessages: [] as ClineMessage[] },
		didFinishAbortingStream: false,
		saveClineMessages: vi.fn(async () => {}),
	}
}

function makeInput(
	getTokens: MakeStreamClosuresInput["getTokens"] = () => ({
		input: 0,
		output: 0,
		cacheWrite: 0,
		cacheRead: 0,
		total: undefined,
	}),
): MakeStreamClosuresInput {
	return { lastApiReqIndex: 3, streamModelInfo, getTokens }
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedAbort.mockResolvedValue(undefined)
})

describe("makeStreamClosures", () => {
	it("updateApiReqMsg は host/input を束ねた deps で runUpdateApiReqMsg を呼び、cancelReason と失敗メッセージを素通しする", () => {
		const host = makeHost()
		const getTokens = () => ({ input: 1, output: 2, cacheWrite: 0, cacheRead: 0, total: 0.5 })

		const { updateApiReqMsg: run } = makeStreamClosures(host, makeInput(getTokens))
		run("streaming_failed", "boom")

		expect(mockedUpdate).toHaveBeenCalledTimes(1)
		const [deps, cancelReason, failMsg] = mockedUpdate.mock.calls[0]
		expect(cancelReason).toBe("streaming_failed")
		expect(failMsg).toBe("boom")
		expect(deps.lastApiReqIndex).toBe(3)
		expect(deps.streamModelInfo).toBe(streamModelInfo)
		// getTokens は参照ごと渡される（呼び出し時点のスナップショットを供給する契約）
		expect(deps.getTokens).toBe(getTokens)
	})

	it("updateApiReqMsg の getClineMessages は messageStore.clineMessages を live 参照する（factory 時のスナップショットではない）", () => {
		const host = makeHost()
		const { updateApiReqMsg: run } = makeStreamClosures(host, makeInput())

		run()
		const deps = mockedUpdate.mock.calls[0][0]
		expect(deps.getClineMessages()).toBe(host.messageStore.clineMessages)

		// 配列そのものを差し替えても、closure は毎回 host 経由で読み直す
		const replaced = [{ ts: 9 } as ClineMessage]
		host.messageStore.clineMessages = replaced
		expect(deps.getClineMessages()).toBe(replaced)
	})

	it("abortStream は diffViewProvider/saveClineMessages/getClineMessages を配線し、cancelReason と失敗メッセージを素通しする", async () => {
		const host = makeHost()
		const { abortStream: run } = makeStreamClosures(host, makeInput())

		await run("user_cancelled", "why")

		expect(mockedAbort).toHaveBeenCalledTimes(1)
		const [deps, cancelReason, failMsg] = mockedAbort.mock.calls[0]
		expect(cancelReason).toBe("user_cancelled")
		expect(failMsg).toBe("why")
		expect(deps.diffViewProvider).toBe(host.diffViewProvider)
		expect(deps.saveClineMessages).toBe(host.saveClineMessages)
		expect(deps.getClineMessages()).toBe(host.messageStore.clineMessages)
	})

	it("abortStream deps.setDidFinishAbortingStream は host.didFinishAbortingStream を書き換える", async () => {
		const host = makeHost()
		const { abortStream: run } = makeStreamClosures(host, makeInput())

		await run("user_cancelled")
		const deps = mockedAbort.mock.calls[0][0]

		deps.setDidFinishAbortingStream(true)
		expect(host.didFinishAbortingStream).toBe(true)
		deps.setDidFinishAbortingStream(false)
		expect(host.didFinishAbortingStream).toBe(false)
	})

	it("abortStream deps に渡る updateApiReqMsg は生成された updateApiReqMsg クロージャそのもので、呼ぶと runUpdateApiReqMsg へ素通しで届く", async () => {
		const host = makeHost()
		const closures = makeStreamClosures(host, makeInput())

		await closures.abortStream("user_cancelled")
		const deps = mockedAbort.mock.calls[0][0]
		expect(deps.updateApiReqMsg).toBe(closures.updateApiReqMsg)

		deps.updateApiReqMsg("streaming_failed", "x")
		expect(mockedUpdate).toHaveBeenCalledWith(expect.anything(), "streaming_failed", "x")
	})
})
