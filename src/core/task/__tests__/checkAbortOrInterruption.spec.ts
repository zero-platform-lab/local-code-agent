import { describe, it, expect, vi } from "vitest"

import { checkAbortOrInterruption } from "../checkAbortOrInterruption"

function makeHost(
	over: { abort?: boolean; abandoned?: boolean; didRejectTool?: boolean; didAlreadyUseTool?: boolean } = {},
) {
	return {
		abort: over.abort ?? false,
		abandoned: over.abandoned ?? false,
		stream: {
			didRejectTool: over.didRejectTool ?? false,
			didAlreadyUseTool: over.didAlreadyUseTool ?? false,
		},
	}
}

describe("checkAbortOrInterruption", () => {
	it("abort かつ未 abandoned：user_cancelled で abortStream を呼び stop", async () => {
		const abortStream = vi.fn(async () => {})

		const result = await checkAbortOrInterruption(makeHost({ abort: true }), abortStream)

		expect(abortStream).toHaveBeenCalledWith("user_cancelled")
		expect(result).toEqual({ stop: true })
	})

	it("abort かつ abandoned：abortStream を呼ばずに stop（他インスタンスへの影響を避ける）", async () => {
		const abortStream = vi.fn(async () => {})

		const result = await checkAbortOrInterruption(makeHost({ abort: true, abandoned: true }), abortStream)

		expect(abortStream).not.toHaveBeenCalled()
		expect(result).toEqual({ stop: true })
	})

	it("didRejectTool：user feedback の suffix を付けて stop（abortStream は呼ばない）", async () => {
		const abortStream = vi.fn(async () => {})

		const result = await checkAbortOrInterruption(makeHost({ didRejectTool: true }), abortStream)

		expect(abortStream).not.toHaveBeenCalled()
		expect(result).toEqual({
			stop: true,
			assistantMessageSuffix: "\n\n[Response interrupted by user feedback]",
		})
	})

	it("didAlreadyUseTool：only-one-tool の suffix を付けて stop", async () => {
		const result = await checkAbortOrInterruption(
			makeHost({ didAlreadyUseTool: true }),
			vi.fn(async () => {}),
		)

		expect(result).toEqual({
			stop: true,
			assistantMessageSuffix:
				"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]",
		})
	})

	it("中断条件が無ければ stop:false で継続", async () => {
		const result = await checkAbortOrInterruption(
			makeHost(),
			vi.fn(async () => {}),
		)

		expect(result).toEqual({ stop: false })
	})

	it("abort は didRejectTool より優先される（suffix 無しの stop）", async () => {
		const result = await checkAbortOrInterruption(
			makeHost({ abort: true, didRejectTool: true }),
			vi.fn(async () => {}),
		)

		expect(result).toEqual({ stop: true })
	})
})
