import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { ProgrammaticWriteGuard } from "../ProgrammaticWriteGuard"

describe("ProgrammaticWriteGuard", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("初期状態では抑止していない", () => {
		expect(new ProgrammaticWriteGuard().isActive).toBe(false)
	})

	it("書き込み中は抑止する", async () => {
		const guard = new ProgrammaticWriteGuard(100)
		let activeDuringWrite: boolean | undefined

		await guard.run(async () => {
			activeDuringWrite = guard.isActive
		})

		expect(activeDuringWrite).toBe(true)
	})

	it("書き込み後も watcher の debounce が明けるまで抑止を続ける", async () => {
		const guard = new ProgrammaticWriteGuard(100)

		await guard.run(async () => {})
		expect(guard.isActive).toBe(true)

		await vi.advanceTimersByTimeAsync(99)
		expect(guard.isActive).toBe(true)

		await vi.advanceTimersByTimeAsync(1)
		expect(guard.isActive).toBe(false)
	})

	it("書き込みの戻り値をそのまま返す", async () => {
		const guard = new ProgrammaticWriteGuard(100)

		await expect(guard.run(async () => "written")).resolves.toBe("written")
	})

	it("書き込みが失敗しても抑止解除タイマーは張られる", async () => {
		const guard = new ProgrammaticWriteGuard(100)

		await expect(guard.run(async () => Promise.reject(new Error("disk full")))).rejects.toThrow("disk full")
		expect(guard.isActive).toBe(true)

		await vi.advanceTimersByTimeAsync(100)
		expect(guard.isActive).toBe(false)
	})

	it("連続した書き込みでは解除タイマーが張り直される", async () => {
		const guard = new ProgrammaticWriteGuard(100)

		await guard.run(async () => {})
		await vi.advanceTimersByTimeAsync(90)

		// 2 回目の書き込みで最初のタイマーは捨てられる
		await guard.run(async () => {})
		await vi.advanceTimersByTimeAsync(90)
		expect(guard.isActive).toBe(true)

		await vi.advanceTimersByTimeAsync(10)
		expect(guard.isActive).toBe(false)
	})

	it("dispose は保留タイマーを捨ててフラグを落とす", async () => {
		const guard = new ProgrammaticWriteGuard(100)

		await guard.run(async () => {})
		guard.dispose()

		expect(guard.isActive).toBe(false)

		// 捨てたタイマーが後から発火して状態を触らないこと
		await vi.advanceTimersByTimeAsync(200)
		expect(guard.isActive).toBe(false)
	})
})
