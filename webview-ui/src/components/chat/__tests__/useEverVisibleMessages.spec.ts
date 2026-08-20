// npx vitest run src/components/chat/__tests__/useEverVisibleMessages.spec.ts

import { act, renderHook } from "@testing-library/react"

import type { ClineMessage } from "@openai-agent/types"

import { messagesToRemember } from "../chatMessageVisibility"
import { useEverVisibleMessages, usePeriodicPrune } from "../useEverVisibleMessages"

const msg = (ts: number): ClineMessage => ({ type: "say", say: "text", ts, text: `m${ts}` }) as ClineMessage

interface Props {
	isHidden: boolean
	taskTs: number | undefined
}

const setup = (isHidden = false, taskTs: number | undefined = 1) =>
	renderHook<ReturnType<typeof useEverVisibleMessages>, Props>(
		({ isHidden: h, taskTs: t }) => useEverVisibleMessages({ isHidden: h, taskTs: t }),
		{ initialProps: { isHidden, taskTs } },
	)

describe("useEverVisibleMessages — remembering", () => {
	it("does not know anything at first", () => {
		const { result } = setup()

		expect(result.current.hasBeenSeen(1)).toBe(false)
	})

	it("remembers the messages it is given", () => {
		const { result } = setup()

		act(() => result.current.remember([msg(1), msg(2)]))

		expect(result.current.hasBeenSeen(1)).toBe(true)
		expect(result.current.hasBeenSeen(2)).toBe(true)
		expect(result.current.hasBeenSeen(3)).toBe(false)
	})

	it("accepts an empty list without complaint", () => {
		const { result } = setup()

		act(() => result.current.remember([]))

		expect(result.current.hasBeenSeen(1)).toBe(false)
	})

	it("keeps only the most recent entries once the cap is exceeded", () => {
		const { result } = setup()

		// 上限 100。121 件覚えさせると古いものが落ちる。
		act(() => result.current.remember(Array.from({ length: 121 }, (_, i) => msg(i + 1))))

		expect(result.current.hasBeenSeen(121)).toBe(true)
		expect(result.current.hasBeenSeen(1)).toBe(false)
	})
})

describe("useEverVisibleMessages — forgetting rules", () => {
	it("forgets everything when the task changes", () => {
		const { result, rerender } = setup(false, 1)

		act(() => result.current.remember([msg(1)]))
		expect(result.current.hasBeenSeen(1)).toBe(true)

		rerender({ isHidden: false, taskTs: 2 })

		expect(result.current.hasBeenSeen(1)).toBe(false)
	})

	it("keeps its memory when the task stays the same", () => {
		const { result, rerender } = setup(false, 1)

		act(() => result.current.remember([msg(1)]))
		rerender({ isHidden: false, taskTs: 1 })

		expect(result.current.hasBeenSeen(1)).toBe(true)
	})

	it("forgets everything when the chat becomes hidden", () => {
		const { result, rerender } = setup(false, 1)

		act(() => result.current.remember([msg(1)]))
		rerender({ isHidden: true, taskTs: 1 })

		expect(result.current.hasBeenSeen(1)).toBe(false)
	})

	it("starts fresh again after being shown once more", () => {
		const { result, rerender } = setup(false, 1)

		act(() => result.current.remember([msg(1)]))
		rerender({ isHidden: true, taskTs: 1 })
		rerender({ isHidden: false, taskTs: 1 })

		expect(result.current.hasBeenSeen(1)).toBe(false)

		act(() => result.current.remember([msg(1)]))
		expect(result.current.hasBeenSeen(1)).toBe(true)
	})

	it("also forgets when the task becomes undefined", () => {
		const { result, rerender } = setup(false, 1)

		act(() => result.current.remember([msg(1)]))
		rerender({ isHidden: false, taskTs: undefined })

		expect(result.current.hasBeenSeen(1)).toBe(false)
	})
})

describe("useEverVisibleMessages — pruning", () => {
	it("drops entries that are neither current nor on screen", () => {
		const { result } = setup()

		act(() => result.current.remember([msg(1), msg(2), msg(3)]))
		act(() => result.current.prune([msg(1)], [msg(2)]))

		expect(result.current.hasBeenSeen(1)).toBe(true) // still in the conversation
		expect(result.current.hasBeenSeen(2)).toBe(true) // still on screen
		expect(result.current.hasBeenSeen(3)).toBe(false) // gone from both
	})

	it("keeps everything when all entries are still current", () => {
		const { result } = setup()

		act(() => result.current.remember([msg(1), msg(2)]))
		act(() => result.current.prune([msg(1), msg(2)], []))

		expect(result.current.hasBeenSeen(1)).toBe(true)
		expect(result.current.hasBeenSeen(2)).toBe(true)
	})

	it("keeps an entry that is only on screen, not in the conversation", () => {
		const { result } = setup()

		act(() => result.current.remember([msg(5)]))
		act(() => result.current.prune([], [msg(5)]))

		expect(result.current.hasBeenSeen(5)).toBe(true)
	})

	it("clears everything when nothing is current or on screen", () => {
		const { result } = setup()

		act(() => result.current.remember([msg(1), msg(2)]))
		act(() => result.current.prune([], []))

		expect(result.current.hasBeenSeen(1)).toBe(false)
		expect(result.current.hasBeenSeen(2)).toBe(false)
	})
})

describe("useEverVisibleMessages — stable identity", () => {
	it("returns the same object across renders", () => {
		// 呼び出し側の useMemo / useEffect 依存配列に入るので、毎レンダー新しい
		// オブジェクトを返すとメモ化とタイマーが毎回作り直される。
		const { result, rerender } = setup(false, 1)
		const first = result.current

		rerender({ isHidden: false, taskTs: 1 })

		expect(result.current).toBe(first)
	})

	it("keeps the same object even across a task change", () => {
		const { result, rerender } = setup(false, 1)
		const first = result.current

		rerender({ isHidden: false, taskTs: 2 })

		expect(result.current).toBe(first)
	})
})

describe("usePeriodicPrune", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("does not prune before the interval elapses", () => {
		const prune = vi.fn()

		renderHook(() => usePeriodicPrune({ prune }, [msg(1)], [msg(1)], messagesToRemember))
		act(() => vi.advanceTimersByTime(59_000))

		expect(prune).not.toHaveBeenCalled()
	})

	it("prunes once the interval elapses", () => {
		const prune = vi.fn()

		renderHook(() => usePeriodicPrune({ prune }, [msg(1)], [msg(2)], messagesToRemember))
		act(() => vi.advanceTimersByTime(60_000))

		expect(prune).toHaveBeenCalledTimes(1)
		expect(prune).toHaveBeenCalledWith([msg(1)], [msg(2)])
	})

	it("keeps pruning on each interval", () => {
		const prune = vi.fn()

		renderHook(() => usePeriodicPrune({ prune }, [], [], messagesToRemember))
		act(() => vi.advanceTimersByTime(180_000))

		expect(prune).toHaveBeenCalledTimes(3)
	})

	it("stops pruning after unmount", () => {
		const prune = vi.fn()

		const { unmount } = renderHook(() => usePeriodicPrune({ prune }, [], [], messagesToRemember))
		unmount()
		act(() => vi.advanceTimersByTime(180_000))

		expect(prune).not.toHaveBeenCalled()
	})

	it("narrows the on-screen list to the remembered window", () => {
		// selectViewport は interval の中で呼ばれる（分割前と同じ）。
		const prune = vi.fn()
		const visible = Array.from({ length: 130 }, (_, i) => msg(i + 1))

		renderHook(() => usePeriodicPrune({ prune }, [], visible, messagesToRemember))
		act(() => vi.advanceTimersByTime(60_000))

		expect(prune.mock.calls[0][1]).toHaveLength(100)
	})
})
