import { describe, it, expect, vi } from "vitest"

import type { HistoryItem } from "@openai-agent/types"

import { RecentTasksCache } from "../RecentTasksCache"

const item = (id: string, workspace: string, ts: number): HistoryItem =>
	({ id, ts, task: id, workspace }) as HistoryItem

describe("RecentTasksCache", () => {
	it("現在ワークスペースのタスクだけを新しい順に返す", () => {
		const cache = new RecentTasksCache({
			getHistory: () => [item("old", "/ws", 1), item("new", "/ws", 3), item("other-workspace", "/elsewhere", 2)],
			getWorkspaceDir: () => "/ws",
		})

		const recent = cache.get()

		expect(recent).toContain("new")
		expect(recent).toContain("old")
		expect(recent).not.toContain("other-workspace")
		expect(recent.indexOf("new")).toBeLessThan(recent.indexOf("old"))
	})

	it("2 回目以降は履歴を読み直さない（memoize）", () => {
		const getHistory = vi.fn(() => [item("a", "/ws", 1)])
		const cache = new RecentTasksCache({ getHistory, getWorkspaceDir: () => "/ws" })

		const first = cache.get()
		const second = cache.get()

		expect(getHistory).toHaveBeenCalledTimes(1)
		expect(second).toBe(first)
	})

	it("invalidate 後は履歴から再計算する", () => {
		let history = [item("a", "/ws", 1)]
		const getHistory = vi.fn(() => history)
		const cache = new RecentTasksCache({ getHistory, getWorkspaceDir: () => "/ws" })

		expect(cache.get()).toEqual(["a"])

		history = [item("a", "/ws", 1), item("b", "/ws", 2)]

		// invalidate しない限り古い結果のまま
		expect(cache.get()).toEqual(["a"])

		cache.invalidate()

		expect(cache.get()).toEqual(["b", "a"])
		expect(getHistory).toHaveBeenCalledTimes(2)
	})
})
