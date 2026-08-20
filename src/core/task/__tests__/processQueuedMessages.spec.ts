import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { processQueuedMessages } from "../processQueuedMessages"

function makeHost(opts: {
	isEmpty?: boolean
	queued?: { text: string; images?: string[] } | undefined
	isEmptyThrows?: boolean
	submitImpl?: (...a: unknown[]) => Promise<void>
}) {
	return {
		messageQueueService: {
			isEmpty: vi.fn(() => {
				if (opts.isEmptyThrows) throw new Error("queue boom")
				return opts.isEmpty ?? false
			}),
			dequeueMessage: vi.fn(() => opts.queued),
		},
		submitUserMessage: opts.submitImpl ?? vi.fn((..._a: unknown[]) => Promise.resolve()),
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("processQueuedMessages", () => {
	it("queue が空なら submitUserMessage しない", async () => {
		const host = makeHost({ isEmpty: true })

		processQueuedMessages(host as never)
		await vi.runAllTimersAsync()

		expect(host.submitUserMessage).not.toHaveBeenCalled()
	})

	it("dequeue が null なら submitUserMessage しない", async () => {
		const host = makeHost({ isEmpty: false, queued: undefined })

		processQueuedMessages(host as never)
		await vi.runAllTimersAsync()

		expect(host.submitUserMessage).not.toHaveBeenCalled()
	})

	it("メッセージがあれば次の tick で text/images 付きで submitUserMessage する", async () => {
		const host = makeHost({ isEmpty: false, queued: { text: "hi", images: ["img"] } })

		processQueuedMessages(host as never)
		// setTimeout(0) を挟むので即時には呼ばれない
		expect(host.submitUserMessage).not.toHaveBeenCalled()

		await vi.runAllTimersAsync()

		expect(host.submitUserMessage).toHaveBeenCalledWith("hi", ["img"])
	})

	it("submitUserMessage が reject しても throw せず console.error で吸収する", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const host = makeHost({
			isEmpty: false,
			queued: { text: "hi" },
			submitImpl: vi.fn(() => Promise.reject(new Error("submit boom"))),
		})

		processQueuedMessages(host as never)
		await vi.runAllTimersAsync()

		expect(errSpy).toHaveBeenCalledWith("[Task] Failed to submit queued message:", expect.any(Error))
	})

	it("queue 処理中の同期例外は catch して console.error で吸収する", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const host = makeHost({ isEmptyThrows: true })

		expect(() => processQueuedMessages(host as never)).not.toThrow()
		expect(errSpy).toHaveBeenCalledWith("[Task] Queue processing error:", expect.any(Error))
	})
})
