import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderHook, act } from "@testing-library/react"

import { copyToClipboard, useCopyToClipboard } from "../clipboard"

describe("copyToClipboard", () => {
	beforeEach(() => {
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		})
	})

	it("returns true on success", async () => {
		const result = await copyToClipboard("text")
		expect(result).toBe(true)
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith("text")
	})

	it("calls onSuccess callback on success", async () => {
		const onSuccess = vi.fn()
		await copyToClipboard("text", { onSuccess })
		expect(onSuccess).toHaveBeenCalled()
	})

	it("returns false on failure", async () => {
		vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("fail"))
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const result = await copyToClipboard("text")
		expect(result).toBe(false)

		consoleSpy.mockRestore()
	})

	it("calls onError callback with Error instance on failure", async () => {
		const error = new Error("clipboard error")
		vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(error)
		const onError = vi.fn()
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await copyToClipboard("text", { onError })
		expect(onError).toHaveBeenCalledWith(error)

		consoleSpy.mockRestore()
	})

	it("wraps non-Error rejections in Error", async () => {
		vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce("string error")
		const onError = vi.fn()
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await copyToClipboard("text", { onError })
		expect(onError).toHaveBeenCalledWith(expect.any(Error))
		expect(onError.mock.calls[0][0].message).toBe("Failed to copy to clipboard")

		consoleSpy.mockRestore()
	})

	it("works without options", async () => {
		const result = await copyToClipboard("text")
		expect(result).toBe(true)
	})
})

describe("useCopyToClipboard", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("initializes with showCopyFeedback as false", () => {
		const { result } = renderHook(() => useCopyToClipboard())
		expect(result.current.showCopyFeedback).toBe(false)
	})

	it("sets showCopyFeedback to true on successful copy", async () => {
		const { result } = renderHook(() => useCopyToClipboard())

		await act(async () => {
			await result.current.copyWithFeedback("text")
		})

		expect(result.current.showCopyFeedback).toBe(true)
	})

	it("resets showCopyFeedback after feedbackDuration", async () => {
		const { result } = renderHook(() => useCopyToClipboard(500))

		await act(async () => {
			await result.current.copyWithFeedback("text")
		})

		expect(result.current.showCopyFeedback).toBe(true)

		act(() => {
			vi.advanceTimersByTime(500)
		})

		expect(result.current.showCopyFeedback).toBe(false)
	})

	it("stops propagation when event is passed", async () => {
		const { result } = renderHook(() => useCopyToClipboard())
		const stopPropagation = vi.fn()
		const fakeEvent = { stopPropagation } as unknown as React.MouseEvent

		await act(async () => {
			await result.current.copyWithFeedback("text", fakeEvent)
		})

		expect(stopPropagation).toHaveBeenCalled()
	})

	it("clears existing timeout on rapid repeated copies", async () => {
		const { result } = renderHook(() => useCopyToClipboard(1000))

		await act(async () => {
			await result.current.copyWithFeedback("first")
		})

		act(() => {
			vi.advanceTimersByTime(500)
		})

		// Copy again before first timeout expires
		await act(async () => {
			await result.current.copyWithFeedback("second")
		})

		// After another 500ms, feedback should still be showing (new timer started)
		act(() => {
			vi.advanceTimersByTime(500)
		})
		expect(result.current.showCopyFeedback).toBe(true)

		// After full duration from second copy, feedback should be hidden
		act(() => {
			vi.advanceTimersByTime(500)
		})
		expect(result.current.showCopyFeedback).toBe(false)
	})

	it("cleans up timeout on unmount", async () => {
		const { result, unmount } = renderHook(() => useCopyToClipboard(1000))

		await act(async () => {
			await result.current.copyWithFeedback("text")
		})

		// Unmount should not throw
		unmount()

		// Advancing timers after unmount should be safe
		act(() => {
			vi.advanceTimersByTime(2000)
		})
	})

	it("returns success status from copyWithFeedback", async () => {
		const { result } = renderHook(() => useCopyToClipboard())

		let success: boolean | undefined
		await act(async () => {
			success = await result.current.copyWithFeedback("text")
		})

		expect(success).toBe(true)
	})

	// --- Mutation kills ---
	it("uses default feedbackDuration of 2000ms", async () => {
		const { result } = renderHook(() => useCopyToClipboard())

		await act(async () => {
			await result.current.copyWithFeedback("text")
		})

		act(() => {
			vi.advanceTimersByTime(1999)
		})
		expect(result.current.showCopyFeedback).toBe(true)

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(result.current.showCopyFeedback).toBe(false)
	})
})
