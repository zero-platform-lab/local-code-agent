// npx vitest run src/components/ui/__tests__/useClipboard.spec.ts

import { renderHook, act } from "@testing-library/react"
import { useClipboard } from "../hooks/useClipboard"

describe("useClipboard", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("returns isCopied=false initially", () => {
		const { result } = renderHook(() => useClipboard())
		expect(result.current.isCopied).toBe(false)
	})

	it("sets isCopied=true after successful copy", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.assign(navigator, { clipboard: { writeText } })

		const { result } = renderHook(() => useClipboard())

		await act(async () => {
			result.current.copy("hello")
			// Flush the promise
			await Promise.resolve()
		})

		expect(writeText).toHaveBeenCalledWith("hello")
		expect(result.current.isCopied).toBe(true)
	})

	it("resets isCopied after timeout", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.assign(navigator, { clipboard: { writeText } })

		const { result } = renderHook(() => useClipboard({ timeout: 1000 }))

		await act(async () => {
			result.current.copy("world")
			await Promise.resolve()
		})
		expect(result.current.isCopied).toBe(true)

		act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(result.current.isCopied).toBe(false)
	})

	it("does nothing when value is empty", () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.assign(navigator, { clipboard: { writeText } })

		const { result } = renderHook(() => useClipboard())

		act(() => {
			result.current.copy("")
		})

		expect(writeText).not.toHaveBeenCalled()
		expect(result.current.isCopied).toBe(false)
	})

	it("does nothing when clipboard API is unavailable", () => {
		// Remove clipboard API
		Object.assign(navigator, { clipboard: undefined })

		const { result } = renderHook(() => useClipboard())

		act(() => {
			result.current.copy("text")
		})

		expect(result.current.isCopied).toBe(false)
	})

	it("uses default timeout of 2000ms", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.assign(navigator, { clipboard: { writeText } })

		const { result } = renderHook(() => useClipboard())

		await act(async () => {
			result.current.copy("test")
			await Promise.resolve()
		})
		expect(result.current.isCopied).toBe(true)

		act(() => {
			vi.advanceTimersByTime(1999)
		})
		expect(result.current.isCopied).toBe(true)

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(result.current.isCopied).toBe(false)
	})
})
