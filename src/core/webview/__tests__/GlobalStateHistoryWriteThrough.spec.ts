import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { HistoryItem } from "@openai-agent/types"

import { GlobalStateHistoryWriteThrough } from "../GlobalStateHistoryWriteThrough"

const items = (...ids: string[]): HistoryItem[] => ids.map((id) => ({ id }) as HistoryItem)

describe("GlobalStateHistoryWriteThrough", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("schedule はデバウンス期間が過ぎるまで書き込まない", async () => {
		const write = vi.fn().mockResolvedValue(undefined)
		const writeThrough = new GlobalStateHistoryWriteThrough({
			getItems: () => items("a"),
			write,
			log: vi.fn(),
			debounceMs: 100,
		})

		writeThrough.schedule()
		expect(write).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(100)
		expect(write).toHaveBeenCalledWith(items("a"))
	})

	it("連続した schedule は最後の 1 回にまとめられる", async () => {
		const write = vi.fn().mockResolvedValue(undefined)
		const writeThrough = new GlobalStateHistoryWriteThrough({
			getItems: () => items("a"),
			write,
			log: vi.fn(),
			debounceMs: 100,
		})

		writeThrough.schedule()
		await vi.advanceTimersByTimeAsync(90)
		writeThrough.schedule()
		await vi.advanceTimersByTimeAsync(90)

		expect(write).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(10)
		expect(write).toHaveBeenCalledTimes(1)
	})

	it("書き込みが失敗しても throw せず log に落とす", async () => {
		const log = vi.fn()
		const writeThrough = new GlobalStateHistoryWriteThrough({
			getItems: () => items("a"),
			write: vi.fn().mockRejectedValue(new Error("boom")),
			log,
			debounceMs: 10,
		})

		writeThrough.schedule()
		await vi.advanceTimersByTimeAsync(10)

		expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"))
	})

	it("flush は保留予約を取り消して即座に書き込む", async () => {
		const write = vi.fn().mockResolvedValue(undefined)
		const writeThrough = new GlobalStateHistoryWriteThrough({
			getItems: () => items("a", "b"),
			write,
			log: vi.fn(),
			debounceMs: 100,
		})

		writeThrough.schedule()
		writeThrough.flush()

		expect(write).toHaveBeenCalledTimes(1)
		expect(write).toHaveBeenCalledWith(items("a", "b"))

		// 取り消された予約が後から発火しないこと
		await vi.advanceTimersByTimeAsync(200)
		expect(write).toHaveBeenCalledTimes(1)
	})

	it("flush の失敗も log に落とす", async () => {
		const log = vi.fn()
		const writeThrough = new GlobalStateHistoryWriteThrough({
			getItems: () => items("a"),
			write: vi.fn().mockRejectedValue(new Error("nope")),
			log,
		})

		writeThrough.flush()
		await vi.advanceTimersByTimeAsync(0)

		expect(log).toHaveBeenCalledWith(expect.stringContaining("nope"))
	})
})
