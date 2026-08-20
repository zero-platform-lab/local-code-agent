import { describe, it, expect, vi, afterEach } from "vitest"

import {
	drainStreamInBackgroundToFindAllUsage,
	type UsageAccumulatorState,
} from "../drainStreamInBackgroundToFindAllUsage"

const ZERO: UsageAccumulatorState = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: undefined }

function usageChunk(over: Partial<Record<string, number>> = {}) {
	return {
		type: "usage",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		totalCost: 0,
		...over,
	}
}

/**
 * chunks[0] を initialItem の value に、残りを iterator.next() が順に返す。
 * `throwAt` を渡すとその回数目の next() で例外を投げる。
 */
function makeStream(chunks: unknown[], throwAt?: number) {
	const rest = chunks.slice(1)
	let i = 0
	let nextCalls = 0
	const iterator = {
		next: vi.fn(async () => {
			nextCalls++
			if (throwAt && nextCalls === throwAt) throw new Error("iterator boom")
			return i < rest.length ? { done: false, value: rest[i++] } : { done: true, value: undefined }
		}),
		return: vi.fn(async () => ({ done: true, value: undefined })),
	}
	const initialItem = chunks.length ? { done: false, value: chunks[0] } : { done: true, value: undefined }
	return { iterator, initialItem }
}

function makeDeps() {
	return {
		taskId: "t1",
		apiConfiguration: {} as never,
		onCapturedUsage: vi.fn(async () => {}),
	}
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("drainStreamInBackgroundToFindAllUsage", () => {
	it("usage chunk のトークンを集計して onCapturedUsage を呼ぶ（messageIndex は lastApiReqIndex）", async () => {
		const deps = makeDeps()
		const { iterator, initialItem } = makeStream([
			usageChunk({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, totalCost: 0.5 }),
		])

		await drainStreamInBackgroundToFindAllUsage(deps as never, iterator as never, initialItem as never, 3, 9, {
			...ZERO,
		})

		expect(deps.onCapturedUsage).toHaveBeenCalledTimes(1)
		expect(deps.onCapturedUsage).toHaveBeenCalledWith(
			{ input: 10, output: 5, cacheWrite: 0, cacheRead: 1, total: 0.5 },
			9,
		)
	})

	it("複数 usage chunk は加算される（cacheRead の欠落は 0 扱い）", async () => {
		const deps = makeDeps()
		const { iterator, initialItem } = makeStream([
			usageChunk({ inputTokens: 3, outputTokens: 1 }),
			usageChunk({ inputTokens: 4, outputTokens: 2, totalCost: 1.25 }),
		])

		await drainStreamInBackgroundToFindAllUsage(deps as never, iterator as never, initialItem as never, 0, 0, {
			...ZERO,
		})

		expect(deps.onCapturedUsage).toHaveBeenCalledWith(
			{ input: 7, output: 3, cacheWrite: 0, cacheRead: 0, total: 1.25 },
			0,
		)
	})

	it("usage chunk が無く seed も 0 なら capture せず警告のみ", async () => {
		const deps = makeDeps()
		const { iterator, initialItem } = makeStream([{ type: "text", text: "hi" }])

		await drainStreamInBackgroundToFindAllUsage(deps as never, iterator as never, initialItem as never, 0, 0, {
			...ZERO,
		})

		expect(deps.onCapturedUsage).not.toHaveBeenCalled()
	})

	it("usage chunk は無くても seed に累積があれば seed 値で capture する", async () => {
		const deps = makeDeps()
		const { iterator, initialItem } = makeStream([{ type: "text", text: "hi" }])

		await drainStreamInBackgroundToFindAllUsage(deps as never, iterator as never, initialItem as never, 0, 2, {
			input: 8,
			output: 4,
			cacheWrite: 0,
			cacheRead: 0,
			total: 0.9,
		})

		expect(deps.onCapturedUsage).toHaveBeenCalledWith(
			{ input: 8, output: 4, cacheWrite: 0, cacheRead: 0, total: 0.9 },
			2,
		)
	})

	it("iterator.next() が例外を投げても、それまでの累積を capture する", async () => {
		const deps = makeDeps()
		// 1 個目を消化したあと 2 個目の next() で throw
		const { iterator, initialItem } = makeStream(
			[usageChunk({ inputTokens: 6, outputTokens: 2 }), usageChunk({ inputTokens: 99, outputTokens: 99 })],
			2,
		)
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await drainStreamInBackgroundToFindAllUsage(deps as never, iterator as never, initialItem as never, 0, 0, {
			...ZERO,
		})

		expect(errSpy).toHaveBeenCalled()
		// 2 個目は next() throw 前で未集計 → 1 個目ぶんだけ
		expect(deps.onCapturedUsage).toHaveBeenCalledWith(
			{ input: 6, output: 2, cacheWrite: 0, cacheRead: 0, total: 0 },
			0,
		)
	})

	it("usage chunk でも全トークンが 0/未指定なら capture しない（cache フィールド欠落は 0 扱い）", async () => {
		const deps = makeDeps()
		// cacheReadTokens を持たない usage chunk
		const { iterator, initialItem } = makeStream([{ type: "usage", inputTokens: 0, outputTokens: 0, totalCost: 0 }])

		await drainStreamInBackgroundToFindAllUsage(deps as never, iterator as never, initialItem as never, 0, 0, {
			...ZERO,
		})

		expect(deps.onCapturedUsage).not.toHaveBeenCalled()
	})

	it("タイムアウト超過で iterator.return を呼んで打ち切る", async () => {
		const deps = makeDeps()
		const { iterator, initialItem } = makeStream([{ type: "text", text: "a" }])
		// startTime=0 → ループ内の判定で 6000ms 経過（>5000）とみなす
		vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(6000)
		vi.spyOn(console, "warn").mockImplementation(() => {})

		await drainStreamInBackgroundToFindAllUsage(deps as never, iterator as never, initialItem as never, 0, 0, {
			...ZERO,
		})

		expect(iterator.return).toHaveBeenCalledTimes(1)
		expect(deps.onCapturedUsage).not.toHaveBeenCalled()
	})
})
