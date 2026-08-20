import { act, renderHook } from "@testing-library/react"

import { useScrollLifecycle, type UseScrollLifecycleOptions } from "../useScrollLifecycle"

// react-use's useEvent binds to window; the handlers are captured so tests can deliver events
// without depending on jsdom's event plumbing for passive/capture options.
const handlers = vi.hoisted(() => ({ current: {} as Record<string, (event: Event) => void> }))

vi.mock("react-use", () => ({
	useEvent: (name: string, handler: (event: Event) => void) => {
		handlers.current[name] = handler
	},
}))

const scrollToIndex = vi.fn()

const setup = (overrides: Partial<UseScrollLifecycleOptions> = {}) => {
	const container = document.createElement("div")
	container.className = "chat-container"
	document.body.appendChild(container)

	const options: UseScrollLifecycleOptions = {
		virtuosoRef: { current: { scrollToIndex } as never },
		scrollContainerRef: { current: container },
		taskTs: 1,
		isStreaming: false,
		isHidden: false,
		hasTask: true,
		...overrides,
	}

	const view = renderHook((props: UseScrollLifecycleOptions) => useScrollLifecycle(props), {
		initialProps: options,
	})

	return { ...view, container, options }
}

const fire = (name: string, event: Partial<Event> & Record<string, unknown>) => {
	act(() => {
		handlers.current[name]?.(event as Event)
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	document.body.innerHTML = ""
	handlers.current = {}
})

describe("useScrollLifecycle — starting a task", () => {
	it("pins to the bottom while a task hydrates", () => {
		const { result } = setup()

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
		expect(result.current.showScrollToBottom).toBe(false)
		expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" })
	})

	it("browses history when there is no task", () => {
		const { result } = setup({ taskTs: undefined })

		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		expect(scrollToIndex).not.toHaveBeenCalled()
	})

	it("re-pins when the task changes", () => {
		const { result, rerender, options } = setup()
		act(() => {
			result.current.atBottomStateChangeCallback(true)
		})
		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")

		rerender({ ...options, taskTs: 2 })

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})

	it("settles into following once the list reports it is at the bottom", () => {
		vi.useFakeTimers()

		try {
			const { result } = setup()
			act(() => {
				result.current.atBottomStateChangeCallback(true)
			})

			act(() => {
				vi.advanceTimersByTime(600)
			})

			expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		} finally {
			vi.useRealTimers()
		}
	})

	it("retries the pin once before giving up and following anyway", () => {
		vi.useFakeTimers()

		try {
			const { result } = setup()
			scrollToIndex.mockClear()

			act(() => {
				vi.advanceTimersByTime(600)
			})
			expect(scrollToIndex).toHaveBeenCalledTimes(1)
			expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")

			act(() => {
				vi.advanceTimersByTime(160)
			})

			expect(scrollToIndex).toHaveBeenCalledTimes(1)
			expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		} finally {
			vi.useRealTimers()
		}
	})

	it("does nothing more once the hook is unmounted", () => {
		vi.useFakeTimers()

		try {
			const { unmount } = setup()
			unmount()
			scrollToIndex.mockClear()

			act(() => {
				vi.advanceTimersByTime(1000)
			})

			expect(scrollToIndex).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("useScrollLifecycle — following the output", () => {
	it("follows unless the user is browsing", () => {
		const { result } = setup()

		expect(result.current.followOutputCallback()).toBe("auto")

		act(() => {
			result.current.enterUserBrowsingHistory("wheel-up")
		})

		expect(result.current.followOutputCallback()).toBe(false)
	})

	it("ignores a transient 'not at bottom' while hydrating", () => {
		const { result } = setup()

		act(() => {
			result.current.atBottomStateChangeCallback(false)
		})

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
		expect(result.current.showScrollToBottom).toBe(false)
	})

	it("offers the jump-to-bottom button when the user browses during hydration", () => {
		const { result } = setup()
		act(() => {
			result.current.enterUserBrowsingHistory("wheel-up")
		})

		act(() => {
			result.current.atBottomStateChangeCallback(true)
		})

		expect(result.current.showScrollToBottom).toBe(true)
		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
	})

	it("re-anchors as soon as the list is at the bottom again", () => {
		vi.useFakeTimers()

		try {
			const { result } = setup()
			act(() => {
				vi.advanceTimersByTime(800)
			})
			act(() => {
				result.current.enterUserBrowsingHistory("wheel-up")
			})

			act(() => {
				result.current.atBottomStateChangeCallback(true)
			})

			expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
			expect(result.current.showScrollToBottom).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it("keeps pinning while streaming even if the list drifts off the bottom", () => {
		vi.useFakeTimers()

		try {
			const { result } = setup({ isStreaming: true })
			act(() => {
				result.current.atBottomStateChangeCallback(true)
				vi.advanceTimersByTime(800)
			})
			scrollToIndex.mockClear()

			act(() => {
				result.current.atBottomStateChangeCallback(false)
			})

			expect(scrollToIndex).toHaveBeenCalled()
			expect(result.current.showScrollToBottom).toBe(false)
			expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		} finally {
			vi.useRealTimers()
		}
	})

	it("shows the jump-to-bottom button once the user has drifted off while browsing", () => {
		vi.useFakeTimers()

		try {
			const { result } = setup()
			act(() => {
				vi.advanceTimersByTime(800)
			})
			act(() => {
				result.current.enterUserBrowsingHistory("wheel-up")
			})

			act(() => {
				result.current.atBottomStateChangeCallback(false)
			})

			expect(result.current.showScrollToBottom).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("useScrollLifecycle — rows growing and shrinking", () => {
	const anchored = () => {
		const view = setup({ isStreaming: false })
		act(() => {
			view.result.current.atBottomStateChangeCallback(true)
		})
		scrollToIndex.mockClear()
		return view
	}

	it("does not chase row growth while the user is browsing", () => {
		const { result } = setup()
		act(() => {
			result.current.enterUserBrowsingHistory("wheel-up")
		})
		scrollToIndex.mockClear()

		act(() => {
			result.current.handleRowHeightChange(true)
		})

		expect(scrollToIndex).not.toHaveBeenCalled()
	})

	it("does not chase row growth while hydrating", () => {
		const { result } = setup()
		scrollToIndex.mockClear()

		act(() => {
			result.current.handleRowHeightChange(true)
		})

		expect(scrollToIndex).not.toHaveBeenCalled()
	})

	it("scrolls smoothly when a row grows and instantly when it shrinks", () => {
		const { result } = anchored()

		act(() => {
			result.current.handleRowHeightChange(true)
		})
		expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "smooth" })

		scrollToIndex.mockClear()
		act(() => {
			result.current.handleRowHeightChange(false)
		})
		expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "auto" })
	})

	it("keeps the view pinned while streaming even when the list is not at the bottom", () => {
		vi.useFakeTimers()

		try {
			const { result } = setup({ isStreaming: true })
			act(() => {
				result.current.atBottomStateChangeCallback(true)
				vi.advanceTimersByTime(800)
			})
			act(() => {
				result.current.atBottomStateChangeCallback(false)
			})
			scrollToIndex.mockClear()

			act(() => {
				result.current.handleRowHeightChange(true)
			})

			expect(scrollToIndex).toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("useScrollLifecycle — the jump-to-bottom button", () => {
	it("anchors, scrolls and confirms the position on the next frame", async () => {
		const { result } = setup()

		act(() => {
			result.current.handleScrollToBottomClick()
		})

		expect(result.current.scrollPhase).toBe("ANCHORED_FOLLOWING")
		expect(result.current.showScrollToBottom).toBe(false)
		const callsBeforeFrame = scrollToIndex.mock.calls.length

		await act(async () => {
			await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
		})

		expect(scrollToIndex.mock.calls.length).toBeGreaterThan(callsBeforeFrame)
	})

	it("skips the confirmation when the user browsed away in the meantime", async () => {
		const { result } = setup()

		act(() => {
			result.current.handleScrollToBottomClick()
		})
		act(() => {
			result.current.enterUserBrowsingHistory("wheel-up")
		})
		const callsBeforeFrame = scrollToIndex.mock.calls.length

		await act(async () => {
			await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
		})

		expect(scrollToIndex.mock.calls.length).toBe(callsBeforeFrame)
	})
})

describe("useScrollLifecycle — user intent", () => {
	it("treats an upward wheel over the chat as browsing", () => {
		const { result, container } = setup()

		fire("wheel", { deltaY: -10, target: container })

		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
	})

	it("ignores a downward wheel and a wheel outside the chat", () => {
		const { result, container } = setup()

		fire("wheel", { deltaY: 10, target: container })
		fire("wheel", { deltaY: -10, target: document.createElement("div") })

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})

	it("treats dragging a scrollbar upwards as browsing", () => {
		const { result, container } = setup()
		const scroller = document.createElement("div")
		scroller.className = "scrollable"
		Object.defineProperty(scroller, "scrollTop", { value: 100, writable: true, configurable: true })
		container.appendChild(scroller)

		fire("pointerdown", { target: scroller })
		scroller.scrollTop = 40
		fire("scroll", { target: scroller })

		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
	})

	it("ignores downward dragging", () => {
		const { result, container } = setup()
		const scroller = document.createElement("div")
		scroller.className = "scrollable"
		Object.defineProperty(scroller, "scrollTop", { value: 10, writable: true, configurable: true })
		container.appendChild(scroller)

		fire("pointerdown", { target: scroller })
		scroller.scrollTop = 80
		fire("scroll", { target: scroller })

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})

	it("forgets the drag once the pointer is released", () => {
		const { result, container } = setup()
		const scroller = document.createElement("div")
		scroller.className = "scrollable"
		Object.defineProperty(scroller, "scrollTop", { value: 100, writable: true, configurable: true })
		container.appendChild(scroller)
		fire("pointerdown", { target: scroller })

		fire("pointerup", {})
		scroller.scrollTop = 10
		fire("scroll", { target: scroller })

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})

	it("ignores presses that are not on an element or not inside the chat", () => {
		const { result, container } = setup()
		const outside = document.createElement("div")
		outside.className = "scrollable"
		document.body.appendChild(outside)

		fire("pointerdown", { target: null })
		fire("pointerdown", { target: outside })
		outside.scrollTop = 0
		fire("scroll", { target: outside })

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
		expect(container).toBeTruthy()
	})

	it("uses a scrollable element itself when there is no marked scroller", () => {
		const { result, container } = setup()
		const element = document.createElement("div")
		Object.defineProperty(element, "scrollHeight", { value: 500, configurable: true })
		Object.defineProperty(element, "clientHeight", { value: 100, configurable: true })
		Object.defineProperty(element, "scrollTop", { value: 200, writable: true, configurable: true })
		container.appendChild(element)

		fire("pointerdown", { target: element })
		element.scrollTop = 100
		fire("scroll", { target: element })

		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
	})

	it("ignores scrolling of an element that was not the one grabbed", () => {
		const { result, container } = setup()
		const scroller = document.createElement("div")
		scroller.className = "scrollable"
		const other = document.createElement("div")
		container.append(scroller, other)
		fire("pointerdown", { target: scroller })

		fire("scroll", { target: other })
		fire("scroll", { target: null })
		fire("scroll", { target: document.createElement("div") })

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})

	it("ignores scroll events when nothing is being dragged", () => {
		const { result, container } = setup()

		fire("scroll", { target: container })

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})
})

describe("useScrollLifecycle — keyboard navigation", () => {
	it("treats PageUp, Home and ArrowUp inside the chat as browsing", () => {
		for (const key of ["PageUp", "Home", "ArrowUp"]) {
			document.body.innerHTML = ""
			const { result, container } = setup()

			fire("keydown", { key, target: container })

			expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		}
	})

	it("ignores keys while there is no task or the view is hidden", () => {
		const withoutTask = setup({ hasTask: false })
		fire("keydown", { key: "PageUp", target: withoutTask.container })
		expect(withoutTask.result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")

		document.body.innerHTML = ""
		const hidden = setup({ isHidden: true })
		fire("keydown", { key: "PageUp", target: hidden.container })
		expect(hidden.result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})

	it("ignores shortcuts and other keys", () => {
		const { result, container } = setup()

		fire("keydown", { key: "PageUp", metaKey: true, target: container })
		fire("keydown", { key: "PageUp", ctrlKey: true, target: container })
		fire("keydown", { key: "PageUp", altKey: true, target: container })
		fire("keydown", { key: "ArrowDown", target: container })

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})

	it("leaves typing in a text field alone", () => {
		const { result, container } = setup()
		const input = document.createElement("input")
		const textarea = document.createElement("textarea")
		const select = document.createElement("select")
		const editable = document.createElement("div")
		editable.contentEditable = "true"
		Object.defineProperty(editable, "isContentEditable", { value: true, configurable: true })
		container.append(input, textarea, select, editable)

		for (const target of [input, textarea, select, editable]) {
			fire("keydown", { key: "ArrowUp", target })
		}

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})

	it("ignores a key press aimed at something that is not an element", () => {
		const { result } = setup()

		fire("keydown", { key: "ArrowUp", target: null })

		expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
	})

	it("ignores keys pressed outside the chat while something else is focused", () => {
		const { result } = setup()
		const outside = document.createElement("button")
		document.body.appendChild(outside)
		// The test setup stubs HTMLElement.focus, so the focused element is faked directly.
		const activeElement = vi.spyOn(document, "activeElement", "get").mockReturnValue(outside)

		try {
			fire("keydown", { key: "ArrowUp", target: outside })

			expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
		} finally {
			activeElement.mockRestore()
		}
	})
})

describe("useScrollLifecycle — housekeeping", () => {
	it("keeps only one pending re-anchor frame", async () => {
		const { result } = setup()

		act(() => {
			result.current.handleScrollToBottomClick()
			result.current.handleScrollToBottomClick()
		})
		const callsBeforeFrame = scrollToIndex.mock.calls.length

		await act(async () => {
			await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
		})

		expect(scrollToIndex.mock.calls.length).toBe(callsBeforeFrame + 1)
	})

	it("gives up the hydration window when the user takes over first", () => {
		vi.useFakeTimers()

		try {
			const { result } = setup()

			act(() => {
				result.current.enterUserBrowsingHistory("wheel-up")
			})
			scrollToIndex.mockClear()

			act(() => {
				vi.advanceTimersByTime(1000)
			})

			expect(scrollToIndex).not.toHaveBeenCalled()
			expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not act on a retry that the user already overtook", () => {
		vi.useFakeTimers()

		try {
			const { result } = setup()

			// First window expires and schedules the single retry.
			act(() => {
				vi.advanceTimersByTime(600)
			})
			// The user jumps to the bottom, which ends the hydration window.
			act(() => {
				result.current.handleScrollToBottomClick()
			})
			// Let the click's own re-anchor frame run before watching for the retry.
			act(() => {
				vi.advanceTimersByTime(20)
			})
			scrollToIndex.mockClear()

			act(() => {
				vi.advanceTimersByTime(160)
			})

			expect(scrollToIndex).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("replaces the hydration window when the task changes again", () => {
		vi.useFakeTimers()

		try {
			const { result, rerender, options } = setup()

			rerender({ ...options, taskTs: 2 })
			rerender({ ...options, taskTs: 3 })
			scrollToIndex.mockClear()

			act(() => {
				vi.advanceTimersByTime(600)
			})

			// Only the newest window is still armed, so exactly one retry fires.
			expect(scrollToIndex).toHaveBeenCalledTimes(1)
			expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
		} finally {
			vi.useRealTimers()
		}
	})

	it("treats drifting off the bottom during a drag as browsing", () => {
		vi.useFakeTimers()

		try {
			const { result, container } = setup()
			act(() => {
				result.current.atBottomStateChangeCallback(true)
				vi.advanceTimersByTime(800)
			})
			const scroller = document.createElement("div")
			scroller.className = "scrollable"
			container.appendChild(scroller)
			fire("pointerdown", { target: scroller })

			act(() => {
				result.current.atBottomStateChangeCallback(false)
			})

			expect(result.current.scrollPhase).toBe("USER_BROWSING_HISTORY")
		} finally {
			vi.useRealTimers()
		}
	})

	it("ignores a press on something that cannot scroll", () => {
		const { result, container } = setup()
		const plain = document.createElement("div")
		Object.defineProperty(plain, "scrollHeight", { value: 100, configurable: true })
		Object.defineProperty(plain, "clientHeight", { value: 100, configurable: true })
		container.appendChild(plain)

		fire("pointerdown", { target: plain })
		fire("scroll", { target: plain })

		expect(result.current.scrollPhase).toBe("HYDRATING_PINNED_TO_BOTTOM")
	})
})
