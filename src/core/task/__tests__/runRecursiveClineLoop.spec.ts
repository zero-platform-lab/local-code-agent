import { describe, it, expect, vi, beforeEach } from "vitest"

import { runRecursiveClineLoop } from "../runRecursiveClineLoop"

vi.mock("../checkMistakeLimit", () => ({ checkMistakeLimit: vi.fn() }))
vi.mock("../prepareRequestCycle", () => ({ prepareRequestCycle: vi.fn() }))
vi.mock("../runOneRequest", () => ({ runOneRequest: vi.fn() }))

import { checkMistakeLimit } from "../checkMistakeLimit"
import { prepareRequestCycle } from "../prepareRequestCycle"
import { runOneRequest } from "../runOneRequest"

const mockedCheckMistake = vi.mocked(checkMistakeLimit)
const mockedPrepare = vi.mocked(prepareRequestCycle)
const mockedRunOne = vi.mocked(runOneRequest)

function makeDeps(hostOverrides: Record<string, unknown> = {}) {
	const host = {
		abort: false,
		taskId: "t1",
		instanceId: "i1",
		mistakeTracker: { count: 0, limit: 3 },
		ask: vi.fn(),
		say: vi.fn(),
		...hostOverrides,
	}
	return {
		host,
		provider: {},
		stampLastGlobalApiRequestTime: vi.fn(),
		presentAssistantMessage: vi.fn(),
	} as never
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedCheckMistake.mockResolvedValue({ additionalContent: [], fired: false } as never)
	mockedPrepare.mockResolvedValue({ lastApiReqIndex: 0 } as never)
	mockedRunOne.mockResolvedValue({ action: "break" } as never)
})

describe("runRecursiveClineLoop", () => {
	it("abort されていたら pop 直後に throw し、リクエストは走らせない", async () => {
		const deps = makeDeps({ abort: true })

		await expect(runRecursiveClineLoop(deps, [], false)).rejects.toThrow(
			"[Agent#recursivelyMakeAgentRequests] task t1.i1 aborted",
		)
		expect(mockedRunOne).not.toHaveBeenCalled()
	})

	it("action=break で正常終了し false を返す", async () => {
		mockedRunOne.mockResolvedValue({ action: "break" } as never)

		const result = await runRecursiveClineLoop(makeDeps(), [], false)

		expect(result).toBe(false)
		expect(mockedRunOne).toHaveBeenCalledTimes(1)
	})

	it("action=abandoned は continue し、スタックが尽きたら false", async () => {
		mockedRunOne.mockResolvedValue({ action: "abandoned" } as never)

		const result = await runRecursiveClineLoop(makeDeps(), [], false)

		expect(result).toBe(false)
		expect(mockedRunOne).toHaveBeenCalledTimes(1)
	})

	it("nextStackItem を push すると次の反復で処理される", async () => {
		mockedRunOne
			.mockResolvedValueOnce({
				nextStackItem: { userContent: [], includeFileDetails: false, retryAttempt: 1 },
			} as never)
			.mockResolvedValueOnce({ action: "break" } as never)

		const result = await runRecursiveClineLoop(makeDeps(), [], false)

		expect(result).toBe(false)
		expect(mockedRunOne).toHaveBeenCalledTimes(2)
	})

	it("retryAttempt を持たない nextStackItem を push しても ?? 0 で 0 扱いになる", async () => {
		// 82/93 行目の `currentItem.retryAttempt ?? 0` の既定側（retryAttempt 欠落）を踏む。
		mockedRunOne
			.mockResolvedValueOnce({
				nextStackItem: { userContent: [], includeFileDetails: false },
			} as never)
			.mockResolvedValueOnce({ action: "break" } as never)

		const result = await runRecursiveClineLoop(makeDeps(), [], false)

		expect(result).toBe(false)
		expect(mockedRunOne).toHaveBeenCalledTimes(2)
		// 2 回目の prepare / runOne に retryAttempt=0 が渡る
		expect((mockedPrepare.mock.calls[1][1] as { retryAttempt: number }).retryAttempt).toBe(0)
		expect((mockedRunOne.mock.calls[1][1] as { currentRetryAttempt: number }).currentRetryAttempt).toBe(0)
	})

	it("runOneRequest が throw したら true を返す（親がタスク終了する）", async () => {
		mockedRunOne.mockRejectedValue(new Error("boom"))

		const result = await runRecursiveClineLoop(makeDeps(), [], false)

		expect(result).toBe(true)
	})

	it("mistake limit が発火したら count を 0 にリセットする", async () => {
		mockedCheckMistake.mockResolvedValue({ additionalContent: [], fired: true } as never)
		const deps = makeDeps({ mistakeTracker: { count: 5, limit: 3 } })

		await runRecursiveClineLoop(deps, [], false)

		expect((deps as any).host.mistakeTracker.count).toBe(0)
	})

	it("mistake の additionalContent は当該リクエストの userContent に足される", async () => {
		const extra = { type: "text", text: "mistake feedback" }
		mockedCheckMistake.mockResolvedValue({ additionalContent: [extra], fired: false } as never)

		await runRecursiveClineLoop(makeDeps(), [{ type: "text", text: "orig" }] as never, false)

		// prepareRequestCycle に渡る currentUserContent に追加分が含まれる
		const secondArg = mockedPrepare.mock.calls[0][1] as { currentUserContent: unknown[] }
		expect(secondArg.currentUserContent).toContainEqual(extra)
	})
})
