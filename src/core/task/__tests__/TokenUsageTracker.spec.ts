import { describe, it, expect, vi, beforeEach } from "vitest"

// debounce を同期パススルーにして leading emit を即時実行させる
vi.mock("lodash.debounce", () => ({
	default: (fn: (...a: unknown[]) => unknown) => {
		const wrapped = (...args: unknown[]) => fn(...args)
		wrapped.flush = vi.fn()
		wrapped.cancel = vi.fn()
		return wrapped
	},
}))
vi.mock("../../../shared/combineApiRequests", () => ({ combineApiRequests: vi.fn((x: unknown) => x) }))
vi.mock("../../../shared/combineCommandSequences", () => ({ combineCommandSequences: vi.fn((x: unknown) => x) }))
vi.mock("../../../shared/getApiMetrics", () => ({
	getApiMetrics: vi.fn(() => ({ totalTokensIn: 5, totalTokensOut: 2 })),
	hasTokenUsageChanged: vi.fn(() => true),
	hasToolUsageChanged: vi.fn(() => false),
}))

import { TokenUsageTracker } from "../TokenUsageTracker"
import { combineCommandSequences } from "../../../shared/combineCommandSequences"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../../shared/getApiMetrics"

const mockedCombineSeq = vi.mocked(combineCommandSequences)
const mockedMetrics = vi.mocked(getApiMetrics)
const mockedTokenChanged = vi.mocked(hasTokenUsageChanged)
const mockedToolChanged = vi.mocked(hasToolUsageChanged)

function makeHost(clineMessages: Array<{ ts?: number }> = [{ ts: 1 }, { ts: 2 }]) {
	return {
		taskId: "t1",
		messageStore: { clineMessages },
		emit: vi.fn(),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedMetrics.mockReturnValue({ totalTokensIn: 5, totalTokensOut: 2 } as never)
	mockedTokenChanged.mockReturnValue(true)
	mockedToolChanged.mockReturnValue(false)
})

describe("TokenUsageTracker", () => {
	it("getTokenUsage は先頭 task メッセージを除いて metrics を算出する", () => {
		const host = makeHost([{ ts: 1 }, { ts: 2 }, { ts: 3 }])
		const tracker = new TokenUsageTracker(host as never, 100)

		const usage = tracker.getTokenUsage()

		// slice(1) されたメッセージが combine に渡る
		expect(mockedCombineSeq).toHaveBeenCalledWith([{ ts: 2 }, { ts: 3 }])
		expect(usage).toEqual({ totalTokensIn: 5, totalTokensOut: 2 })
	})

	it("getCachedTokenUsage は初回に算出してキャッシュし、2 回目はキャッシュを返す", () => {
		const host = makeHost()
		const tracker = new TokenUsageTracker(host as never, 100)

		const first = tracker.getCachedTokenUsage()
		const second = tracker.getCachedTokenUsage()

		expect(first).toBe(second)
		// 算出は 1 回だけ（2 回目はキャッシュ）
		expect(mockedMetrics).toHaveBeenCalledTimes(1)
	})

	it("末尾メッセージに ts が無い（snapshotAt が立たない）ときは毎回再算出する", () => {
		const host = makeHost([]) // at(-1) undefined → snapshotAt undefined
		const tracker = new TokenUsageTracker(host as never, 100)

		tracker.getCachedTokenUsage()
		tracker.getCachedTokenUsage()

		expect(mockedMetrics).toHaveBeenCalledTimes(2)
	})

	it("emitDebounced は変化があれば TaskTokenUsageUpdated を emit してスナップショットを更新する", () => {
		const host = makeHost()
		const tracker = new TokenUsageTracker(host as never, 100)

		tracker.emitDebounced({ totalTokensIn: 9 } as never, { read_file: { attempts: 1, failures: 0 } } as never)

		expect(host.emit).toHaveBeenCalledWith(
			"taskTokenUsageUpdated",
			"t1",
			{ totalTokensIn: 9 },
			{ read_file: { attempts: 1, failures: 0 } },
		)
	})

	it("変化が無ければ emit しない", () => {
		mockedTokenChanged.mockReturnValue(false)
		mockedToolChanged.mockReturnValue(false)
		const host = makeHost()
		const tracker = new TokenUsageTracker(host as never, 100)

		tracker.emitDebounced({} as never, {} as never)

		expect(host.emit).not.toHaveBeenCalled()
	})

	it("emitFinal は最新使用量を算出して emit し、flush する", () => {
		const host = makeHost()
		const tracker = new TokenUsageTracker(host as never, 100)

		tracker.emitFinal()

		expect(mockedMetrics).toHaveBeenCalled()
		expect(host.emit).toHaveBeenCalledWith("taskTokenUsageUpdated", "t1", expect.any(Object), expect.any(Object))
	})

	it("recordToolUsage は新規ツールを初期化して attempts を増やす", () => {
		const tracker = new TokenUsageTracker(makeHost() as never, 100)

		tracker.recordToolUsage("read_file" as never)
		tracker.recordToolUsage("read_file" as never)

		expect(tracker.toolUsage).toEqual({ read_file: { attempts: 2, failures: 0 } })
	})

	it("recordToolError は failures を増やし、error があれば TaskToolFailed を発火する", () => {
		const host = makeHost()
		const tracker = new TokenUsageTracker(host as never, 100)

		tracker.recordToolError("read_file" as never, "boom")

		expect(tracker.toolUsage).toEqual({ read_file: { attempts: 0, failures: 1 } })
		expect(host.emit).toHaveBeenCalledWith("taskToolFailed", "t1", "read_file", "boom")
	})

	it("recordToolError は error が無ければ発火しない", () => {
		const host = makeHost()
		const tracker = new TokenUsageTracker(host as never, 100)

		tracker.recordToolError("read_file" as never)

		expect(tracker.toolUsage.read_file?.failures).toBe(1)
		expect(host.emit).not.toHaveBeenCalled()
	})
})
