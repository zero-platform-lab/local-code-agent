import { describe, it, expect, vi, beforeEach } from "vitest"

import { makeDrainStreamInBackground } from "../makeDrainStreamInBackground"

vi.mock("../drainStreamInBackgroundToFindAllUsage", () => ({
	drainStreamInBackgroundToFindAllUsage: vi.fn(),
}))

import { drainStreamInBackgroundToFindAllUsage } from "../drainStreamInBackgroundToFindAllUsage"

const mockedDrain = vi.mocked(drainStreamInBackgroundToFindAllUsage)

function makeHost(clineMessages: unknown[] = []) {
	return {
		taskId: "t1",
		apiConfiguration: { apiProvider: "anthropic" },
		messageStore: { clineMessages },
		saveClineMessages: vi.fn(async () => {}),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedDrain.mockResolvedValue(undefined)
})

describe("makeDrainStreamInBackground", () => {
	it("生成した関数は drain 本体へ host 情報・iterator・index・token スナップショットを渡す", async () => {
		const tokens = { input: 1, output: 2, cacheWrite: 0, cacheRead: 0, total: 0.3 }
		const drain = makeDrainStreamInBackground(makeHost() as never, tokens as never, {
			updateApiReqMsg: vi.fn(),
			updateClineMessage: vi.fn(async () => {}),
		})
		const iterator = { next: vi.fn() }
		const initialItem = { done: false, value: {} }

		await drain(5, iterator as never, initialItem as never, 9)

		const [depsArg, itArg, itemArg, apiReqIdx, lastIdx, seed] = mockedDrain.mock.calls[0] as unknown[]
		expect((depsArg as any).taskId).toBe("t1")
		expect(itArg).toBe(iterator)
		expect(itemArg).toBe(initialItem)
		expect(apiReqIdx).toBe(5)
		expect(lastIdx).toBe(9)
		// seed は tokens のコピー（参照ではない）
		expect(seed).toEqual(tokens)
		expect(seed).not.toBe(tokens)
	})

	it("onCapturedUsage は tokens を in-place 更新し、updateApiReqMsg→save→updateClineMessage の順で呼ぶ", async () => {
		const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: undefined as number | undefined }
		const order: string[] = []
		const host = makeHost([{ ts: 1 }, { ts: 2 }, { ts: 3 }])
		host.saveClineMessages = vi.fn(async () => {
			order.push("save")
		})
		const updateApiReqMsg = vi.fn(() => {
			order.push("updateApiReqMsg")
		})
		const updateClineMessage = vi.fn(async () => {
			order.push("updateClineMessage")
		})

		makeDrainStreamInBackground(host as never, tokens as never, { updateApiReqMsg, updateClineMessage })(
			0,
			{ next: vi.fn() } as never,
			{ done: true } as never,
			0,
		)

		const onCapturedUsage = (mockedDrain.mock.calls[0][0] as any).onCapturedUsage
		await onCapturedUsage({ input: 11, output: 7, cacheWrite: 3, cacheRead: 1, total: 0.42 }, 2)

		expect(tokens).toEqual({ input: 11, output: 7, cacheWrite: 3, cacheRead: 1, total: 0.42 })
		expect(order).toEqual(["updateApiReqMsg", "save", "updateClineMessage"])
		// messageIndex=2 の message が updateClineMessage に渡る
		expect(updateClineMessage).toHaveBeenCalledWith({ ts: 3 })
	})

	it("messageIndex に対応する message が無ければ updateClineMessage を呼ばない", async () => {
		const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: undefined as number | undefined }
		const updateClineMessage = vi.fn(async () => {})
		const host = makeHost([]) // 空 → index 0 は存在しない

		makeDrainStreamInBackground(host as never, tokens as never, {
			updateApiReqMsg: vi.fn(),
			updateClineMessage,
		})(0, { next: vi.fn() } as never, { done: true } as never, 0)

		const onCapturedUsage = (mockedDrain.mock.calls[0][0] as any).onCapturedUsage
		await onCapturedUsage({ input: 1, output: 1, cacheWrite: 0, cacheRead: 0, total: 0 }, 0)

		expect(host.saveClineMessages).toHaveBeenCalledTimes(1)
		expect(updateClineMessage).not.toHaveBeenCalled()
	})
})
