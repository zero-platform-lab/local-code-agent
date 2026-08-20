import { describe, it, expect, vi, beforeEach } from "vitest"

import { runStreamingLoop } from "../runStreamingLoop"

vi.mock("../makeNextChunkWithAbort", () => ({ makeNextChunkWithAbort: vi.fn() }))
vi.mock("../processStreamChunk", () => ({ processStreamChunk: vi.fn() }))
vi.mock("../checkAbortOrInterruption", () => ({ checkAbortOrInterruption: vi.fn() }))
vi.mock("../makeDrainStreamInBackground", () => ({ makeDrainStreamInBackground: vi.fn() }))

import { makeNextChunkWithAbort } from "../makeNextChunkWithAbort"
import { processStreamChunk } from "../processStreamChunk"
import { checkAbortOrInterruption } from "../checkAbortOrInterruption"
import { makeDrainStreamInBackground } from "../makeDrainStreamInBackground"

const mockedNext = vi.mocked(makeNextChunkWithAbort)
const mockedProcess = vi.mocked(processStreamChunk)
const mockedCheck = vi.mocked(checkAbortOrInterruption)
const mockedDrain = vi.mocked(makeDrainStreamInBackground)

/** `{done,value}` の並びを順に返す nextChunkWithAbort を仕込む。 */
function feedChunks(seq: Array<{ done: boolean; value?: unknown }>) {
	let i = 0
	mockedNext.mockReturnValue((async () => seq[i++]) as never)
}

function makeDeps() {
	const host = {
		taskId: "t1",
		messageStore: { clineMessages: [] },
		saveClineMessages: vi.fn(async () => {}),
		stream: { currentRequestAbortController: undefined },
	}
	return {
		host,
		presentAssistantMessage: vi.fn(),
		say: vi.fn(async () => {}),
		abortStream: vi.fn(async () => {}),
		updateApiReqMsg: vi.fn(),
		updateClineMessage: vi.fn(async () => {}),
	}
}

const stream = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true }) }) } as never
const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: undefined } as never

beforeEach(() => {
	vi.clearAllMocks()
	// 既定：chunk を assistantMessage に連結して返す（メッセージ引き回しの検証用）
	mockedProcess.mockImplementation((async (_d: unknown, chunk: unknown, prev: any) => ({
		reasoningMessage: prev.reasoningMessage,
		assistantMessage: prev.assistantMessage + String(chunk),
	})) as never)
	mockedCheck.mockResolvedValue({ stop: false } as never)
	mockedDrain.mockReturnValue(vi.fn(async () => {}) as never)
})

describe("runStreamingLoop", () => {
	it("全 chunk を順に processStreamChunk へ流し、assistantMessage を引き回す", async () => {
		feedChunks([{ done: false, value: "A" }, { done: false, value: "B" }, { done: true }])

		const result = await runStreamingLoop(makeDeps() as never, stream, tokens, 0)

		expect(mockedProcess).toHaveBeenCalledTimes(2)
		expect(result.assistantMessage).toBe("AB")
	})

	it("undefined chunk はスキップして次へ進む", async () => {
		feedChunks([{ done: false, value: undefined }, { done: false, value: "B" }, { done: true }])

		const result = await runStreamingLoop(makeDeps() as never, stream, tokens, 0)

		expect(mockedProcess).toHaveBeenCalledTimes(1)
		expect(result.assistantMessage).toBe("B")
	})

	it("checkAbortOrInterruption が stop なら suffix を足して break（残 chunk は処理しない）", async () => {
		feedChunks([{ done: false, value: "A" }, { done: false, value: "B" }, { done: true }])
		mockedCheck.mockResolvedValue({ stop: true, assistantMessageSuffix: "|X" } as never)

		const result = await runStreamingLoop(makeDeps() as never, stream, tokens, 0)

		expect(mockedProcess).toHaveBeenCalledTimes(1)
		expect(result.assistantMessage).toBe("A|X")
	})

	it("ループ後に drainStream を fire-and-forget で起動する", async () => {
		const drainFn = vi.fn((..._args: unknown[]) => Promise.resolve())
		mockedDrain.mockReturnValue(drainFn as never)
		feedChunks([{ done: false, value: "A" }, { done: true }])

		await runStreamingLoop(makeDeps() as never, stream, tokens, 3)

		expect(mockedDrain).toHaveBeenCalledTimes(1)
		expect(drainFn).toHaveBeenCalledTimes(1)
		// drainStream(lastApiReqIndex, iterator, item, lastApiReqIndex)
		expect(drainFn.mock.calls[0][0]).toBe(3)
		expect(drainFn.mock.calls[0][3]).toBe(3)
	})

	it("chunk が無くても（即 done）drain を起動して空メッセージを返す", async () => {
		feedChunks([{ done: true }])

		const result = await runStreamingLoop(makeDeps() as never, stream, tokens, 0)

		expect(mockedProcess).not.toHaveBeenCalled()
		expect(mockedDrain).toHaveBeenCalledTimes(1)
		expect(result).toEqual({ assistantMessage: "", reasoningMessage: "" })
	})

	it("drainStream（fire-and-forget）が失敗しても throw せず console.error で握りつぶす", async () => {
		mockedDrain.mockReturnValue(
			vi.fn(async () => {
				throw new Error("drain boom")
			}) as never,
		)
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		feedChunks([{ done: true }])

		await expect(runStreamingLoop(makeDeps() as never, stream, tokens, 0)).resolves.toBeDefined()
		// fire-and-forget の rejection が microtask で処理されるのを待つ
		await new Promise((r) => setTimeout(r, 0))

		expect(errSpy).toHaveBeenCalledWith("Background usage collection failed:", expect.any(Error))
		errSpy.mockRestore()
	})
})
