import { describe, it, expect, vi, beforeEach } from "vitest"

import { awaitAskResponseAndFinalize } from "../awaitAskResponseAndFinalize"
import { AskIgnoredError } from "../AskIgnoredError"

// pWaitFor は predicate を 1 回だけ評価して解決する（分岐は askState/queue の初期値で制御）
vi.mock("p-wait-for", () => ({
	default: vi.fn(async (predicate: () => Promise<boolean> | boolean) => {
		await predicate()
	}),
}))
vi.mock("../drainQueuedMessageForAsk", () => ({ drainQueuedMessageForAsk: vi.fn() }))

import { drainQueuedMessageForAsk } from "../drainQueuedMessageForAsk"

const mockedDrain = vi.mocked(drainQueuedMessageForAsk)

function makeAskState(over: Record<string, unknown> = {}) {
	return {
		askResponse: "yesButtonClicked" as string | undefined,
		askResponseText: "txt" as string | undefined,
		askResponseImages: ["img"] as string[] | undefined,
		lastMessageTs: 100,
		currentAsk: { ts: 1 } as unknown,
		resetResponse: vi.fn(),
		clearAsks: vi.fn(),
		...over,
	}
}

function makeHost(askState: ReturnType<typeof makeAskState>, isEmpty = true) {
	return {
		askState,
		taskId: "t1",
		emit: vi.fn(),
		messageQueueService: { isEmpty: vi.fn(() => isEmpty), dequeueMessage: vi.fn() },
		handleWebviewAskResponse: vi.fn(),
	}
}

const baseInput = {
	askTs: 100,
	timeouts: [] as NodeJS.Timeout[],
	type: "followup" as const,
	shouldDrainQueuedMessageForAsk: true,
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("awaitAskResponseAndFinalize", () => {
	it("応答が揃っていれば response/text/images を束ねて返し、resetResponse する", async () => {
		const askState = makeAskState()
		const host = makeHost(askState)

		const result = await awaitAskResponseAndFinalize(host as never, baseInput)

		expect(result).toEqual({ response: "yesButtonClicked", text: "txt", images: ["img"] })
		expect(askState.resetResponse).toHaveBeenCalledTimes(1)
	})

	it("lastMessageTs が askTs と食い違えば AskIgnoredError（superseded）を投げる", async () => {
		const askState = makeAskState({ lastMessageTs: 999 })
		const host = makeHost(askState)

		await expect(awaitAskResponseAndFinalize(host as never, baseInput)).rejects.toThrow(AskIgnoredError)
	})

	it("currentAsk があれば clearAsks して TaskActive を emit、最後に TaskAskResponded を emit する", async () => {
		const askState = makeAskState()
		const host = makeHost(askState)

		await awaitAskResponseAndFinalize(host as never, baseInput)

		expect(askState.clearAsks).toHaveBeenCalledTimes(1)
		expect(host.emit).toHaveBeenCalledWith("taskActive", "t1")
		expect(host.emit).toHaveBeenLastCalledWith("taskAskResponded")
	})

	it("currentAsk が無ければ clearAsks/TaskActive はスキップし TaskAskResponded のみ emit", async () => {
		const askState = makeAskState({ currentAsk: undefined })
		const host = makeHost(askState)

		await awaitAskResponseAndFinalize(host as never, baseInput)

		expect(askState.clearAsks).not.toHaveBeenCalled()
		expect(host.emit).toHaveBeenCalledTimes(1)
		expect(host.emit).toHaveBeenCalledWith("taskAskResponded")
	})

	it("残っている timeouts は clearTimeout される", async () => {
		const t1 = setTimeout(() => {}, 10000)
		const t2 = setTimeout(() => {}, 10000)
		const clearSpy = vi.spyOn(globalThis, "clearTimeout")
		const host = makeHost(makeAskState())

		await awaitAskResponseAndFinalize(host as never, { ...baseInput, timeouts: [t1, t2] })

		expect(clearSpy).toHaveBeenCalledWith(t1)
		expect(clearSpy).toHaveBeenCalledWith(t2)
		clearSpy.mockRestore()
	})

	it("待機中に queue メッセージが届いたら drainQueuedMessageForAsk で消化する", async () => {
		// askResponse 未着 & lastMessageTs 一致 → predicate が false 経路に入る。
		// shouldDrain=true かつ queue 非空 → drain 実行
		const askState = makeAskState({ askResponse: undefined })
		const host = makeHost(askState, /* isEmpty */ false)

		await awaitAskResponseAndFinalize(host as never, baseInput)

		expect(mockedDrain).toHaveBeenCalledWith(host, "followup")
	})

	it("shouldDrain=false または queue が空なら drain しない", async () => {
		const askState = makeAskState({ askResponse: undefined })
		const host = makeHost(askState, /* isEmpty */ true)

		await awaitAskResponseAndFinalize(host as never, { ...baseInput, shouldDrainQueuedMessageForAsk: false })

		expect(mockedDrain).not.toHaveBeenCalled()
	})
})
