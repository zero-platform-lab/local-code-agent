import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../shared/cost", () => ({
	calculateApiCostOpenAI: vi.fn(),
}))

import { calculateApiCostOpenAI } from "../../../shared/cost"

import { updateApiReqMsg, abortStream } from "../apiReqMessageUpdater"

const mockedCost = vi.mocked(calculateApiCostOpenAI)

const streamModelInfo = { contextWindow: 200_000 } as never

function makeTokens(over: Partial<Record<string, number>> = {}) {
	return { input: 10, output: 5, cacheWrite: 2, cacheRead: 1, total: undefined, ...over }
}

beforeEach(() => {
	vi.clearAllMocks()
	// 明確に区別できる値でマッピングを検証する
	mockedCost.mockReturnValue({ totalInputTokens: 111, totalOutputTokens: 222, totalCost: 3.5 })
})

describe("updateApiReqMsg", () => {
	it("lastApiReqIndex が負なら何もせず return（cost 計算も呼ばない）", () => {
		const getTokens = vi.fn(() => makeTokens())
		const messages = [{ text: "{}" }]
		const deps = {
			getClineMessages: () => messages as never,
			lastApiReqIndex: -1,
			streamModelInfo,
			getTokens,
		}

		updateApiReqMsg(deps)

		expect(mockedCost).not.toHaveBeenCalled()
		expect(getTokens).not.toHaveBeenCalled()
		expect(messages[0].text).toBe("{}")
	})

	it("該当 index のメッセージが存在しないなら return", () => {
		const deps = {
			getClineMessages: () => [] as never,
			lastApiReqIndex: 0,
			streamModelInfo,
			getTokens: vi.fn(() => makeTokens()),
		}

		updateApiReqMsg(deps)

		expect(mockedCost).not.toHaveBeenCalled()
	})

	it("既存 text をマージしつつ cost 結果を tokensIn/tokensOut/cost にマップし cancelReason 等を書く", () => {
		const messages = [{ text: JSON.stringify({ request: "GET /foo", keep: 1 }) }]
		const deps = {
			getClineMessages: () => messages as never,
			lastApiReqIndex: 0,
			streamModelInfo,
			getTokens: () => makeTokens(),
		}

		updateApiReqMsg(deps, "user_cancelled", "boom")

		// tokens は getTokens の生値でコスト計算へ渡される
		expect(mockedCost).toHaveBeenCalledWith(streamModelInfo, 10, 5, 1)

		const written = JSON.parse(messages[0].text)
		expect(written).toEqual({
			request: "GET /foo",
			keep: 1,
			tokensIn: 111, // costResult.totalInputTokens
			tokensOut: 222, // costResult.totalOutputTokens
			cacheWrites: 2, // tokens.cacheWrite（生値）
			cacheReads: 1, // tokens.cacheRead（生値）
			cost: 3.5, // total 未指定 → costResult.totalCost
			cancelReason: "user_cancelled",
			streamingFailedMessage: "boom",
		})
	})

	it("text が壊れた JSON でも throw せず、空オブジェクトから組み立て直す", () => {
		const messages = [{ text: "{not valid json" }]
		const deps = {
			getClineMessages: () => messages as never,
			lastApiReqIndex: 0,
			streamModelInfo,
			getTokens: () => makeTokens(),
		}

		expect(() => updateApiReqMsg(deps)).not.toThrow()

		// 壊れた既存データは捨てられ、cost 由来のフィールドで組み立て直される
		const written = JSON.parse(messages[0].text)
		expect(written).toMatchObject({ tokensIn: 111, tokensOut: 222, cost: 3.5 })
	})

	it("tokens.total があればコスト計算値ではなく total を採用する", () => {
		const messages = [{ text: "{}" }]
		const deps = {
			getClineMessages: () => messages as never,
			lastApiReqIndex: 0,
			streamModelInfo,
			getTokens: () => makeTokens({ total: 9.99 }),
		}

		updateApiReqMsg(deps)

		expect(JSON.parse(messages[0].text).cost).toBe(9.99)
	})

	it("text が空なら existingData は {} 扱い（|| フォールバック）", () => {
		const messages = [{ text: undefined as unknown as string }]
		const deps = {
			getClineMessages: () => messages as never,
			lastApiReqIndex: 0,
			streamModelInfo,
			getTokens: () => makeTokens(),
		}

		updateApiReqMsg(deps)

		const written = JSON.parse(messages[0].text)
		expect(written.tokensIn).toBe(111)
		// cancelReason/streamingFailedMessage は undefined なので JSON からは落ちる
		expect(written).not.toHaveProperty("cancelReason")
		expect(written).not.toHaveProperty("streamingFailedMessage")
	})
})

function makeAbortDeps(opts: { isEditing?: boolean; lastMessage?: { partial: boolean } } = {}) {
	const list = opts.lastMessage ? [opts.lastMessage] : []
	const revertChanges = vi.fn(async () => {})
	const updateApiReqMsgFn = vi.fn()
	const saveClineMessages = vi.fn(async () => {})
	const setDidFinishAbortingStream = vi.fn()
	const deps = {
		diffViewProvider: { isEditing: opts.isEditing ?? false, revertChanges },
		getClineMessages: () => list as never,
		updateApiReqMsg: updateApiReqMsgFn,
		saveClineMessages,
		setDidFinishAbortingStream,
	}
	return { deps, revertChanges, updateApiReqMsgFn, saveClineMessages, setDidFinishAbortingStream, list }
}

describe("abortStream", () => {
	it("編集中なら diff view を revert してから後続処理を行う", async () => {
		const { deps, revertChanges, updateApiReqMsgFn, saveClineMessages, setDidFinishAbortingStream } = makeAbortDeps(
			{
				isEditing: true,
			},
		)

		await abortStream(deps as never, "streaming_failed", "why")

		expect(revertChanges).toHaveBeenCalledTimes(1)
		expect(updateApiReqMsgFn).toHaveBeenCalledWith("streaming_failed", "why")
		expect(saveClineMessages).toHaveBeenCalledTimes(1)
		expect(setDidFinishAbortingStream).toHaveBeenCalledWith(true)
		// 順序: revert → updateApiReqMsg → save → finish
		expect(revertChanges.mock.invocationCallOrder[0]).toBeLessThan(updateApiReqMsgFn.mock.invocationCallOrder[0])
		expect(updateApiReqMsgFn.mock.invocationCallOrder[0]).toBeLessThan(
			saveClineMessages.mock.invocationCallOrder[0],
		)
		expect(saveClineMessages.mock.invocationCallOrder[0]).toBeLessThan(
			setDidFinishAbortingStream.mock.invocationCallOrder[0],
		)
	})

	it("編集中でなければ revertChanges を呼ばない", async () => {
		const { deps, revertChanges, setDidFinishAbortingStream } = makeAbortDeps({ isEditing: false })

		await abortStream(deps as never, "user_cancelled")

		expect(revertChanges).not.toHaveBeenCalled()
		expect(setDidFinishAbortingStream).toHaveBeenCalledWith(true)
	})

	it("末尾メッセージが partial なら確定（partial=false）する", async () => {
		const lastMessage = { partial: true }
		const { deps } = makeAbortDeps({ lastMessage })

		await abortStream(deps as never, "user_cancelled")

		expect(lastMessage.partial).toBe(false)
	})

	it("末尾メッセージが partial でなければ触らない", async () => {
		const lastMessage = { partial: false }
		const { deps } = makeAbortDeps({ lastMessage })

		await abortStream(deps as never, "user_cancelled")

		expect(lastMessage.partial).toBe(false)
	})

	it("末尾メッセージが無くても（空配列）例外なく save/finish まで進む", async () => {
		const { deps, updateApiReqMsgFn, saveClineMessages, setDidFinishAbortingStream } = makeAbortDeps()

		await abortStream(deps as never, "streaming_failed", "err")

		expect(updateApiReqMsgFn).toHaveBeenCalledWith("streaming_failed", "err")
		expect(saveClineMessages).toHaveBeenCalledTimes(1)
		expect(setDidFinishAbortingStream).toHaveBeenCalledWith(true)
	})
})
