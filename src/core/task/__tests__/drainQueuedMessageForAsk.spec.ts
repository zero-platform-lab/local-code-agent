import { describe, it, expect, vi } from "vitest"

import { drainQueuedMessageForAsk } from "../drainQueuedMessageForAsk"

function makeHost(message?: { text?: string; images?: string[] }) {
	return {
		messageQueueService: { dequeueMessage: vi.fn(() => message) },
		handleWebviewAskResponse: vi.fn((..._a: unknown[]) => {}),
	}
}

describe("drainQueuedMessageForAsk", () => {
	it("queue が空なら何もしない", () => {
		const host = makeHost(undefined)

		drainQueuedMessageForAsk(host as never, "followup")

		expect(host.handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it.each(["tool", "command", "use_mcp_server"] as const)(
		"ツール系 ask（%s）は yesButtonClicked で承認しつつ text/images を渡す",
		(type) => {
			const host = makeHost({ text: "go", images: ["img"] })

			drainQueuedMessageForAsk(host as never, type)

			expect(host.handleWebviewAskResponse).toHaveBeenCalledWith("yesButtonClicked", "go", ["img"])
		},
	)

	it("非ツール系 ask（followup）は messageResponse で直接 fulfill する", () => {
		const host = makeHost({ text: "hi" })

		drainQueuedMessageForAsk(host as never, "followup")

		expect(host.handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "hi", undefined)
	})
})
