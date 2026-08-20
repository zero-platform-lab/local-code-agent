import { describe, it, expect, vi } from "vitest"

import { AskState } from "../AskState"

// idle > resumable > interactive の優先順位を pin するための識別可能な ClineMessage 群。
const idle = { text: "idle" } as never
const resumable = { text: "resumable" } as never
const interactive = { text: "interactive" } as never

describe("AskState", () => {
	it("生成直後は全 field が undefined で currentAsk も undefined", () => {
		const state = new AskState()

		expect(state.askResponse).toBeUndefined()
		expect(state.askResponseText).toBeUndefined()
		expect(state.askResponseImages).toBeUndefined()
		expect(state.lastMessageTs).toBeUndefined()
		expect(state.autoApprovalTimeoutRef).toBeUndefined()
		expect(state.idleAsk).toBeUndefined()
		expect(state.resumableAsk).toBeUndefined()
		expect(state.interactiveAsk).toBeUndefined()
		expect(state.currentAsk).toBeUndefined()
	})

	it("resetResponse は応答 3 field だけをクリアし、ts や ask 追跡には触れない", () => {
		const state = new AskState()
		state.askResponse = "messageResponse"
		state.askResponseText = "hello"
		state.askResponseImages = ["data:image/png;base64,abc"]
		state.lastMessageTs = 123
		state.idleAsk = idle

		state.resetResponse()

		expect(state.askResponse).toBeUndefined()
		expect(state.askResponseText).toBeUndefined()
		expect(state.askResponseImages).toBeUndefined()
		// 応答以外は保持される（reset の責務境界を退行から守る）
		expect(state.lastMessageTs).toBe(123)
		expect(state.idleAsk).toBe(idle)
	})

	it("clearAsks は ask 追跡 3 field だけをクリアし、応答 field には触れない", () => {
		const state = new AskState()
		state.idleAsk = idle
		state.resumableAsk = resumable
		state.interactiveAsk = interactive
		state.askResponse = "yesButtonClicked"

		state.clearAsks()

		expect(state.idleAsk).toBeUndefined()
		expect(state.resumableAsk).toBeUndefined()
		expect(state.interactiveAsk).toBeUndefined()
		// 応答は保持される
		expect(state.askResponse).toBe("yesButtonClicked")
	})

	it("cancelAutoApprovalTimeout: ref があれば clearTimeout してから undefined に落とす", () => {
		const state = new AskState()
		const timer = setTimeout(() => {}, 10_000)
		state.autoApprovalTimeoutRef = timer
		const clearSpy = vi.spyOn(globalThis, "clearTimeout")

		state.cancelAutoApprovalTimeout()

		expect(clearSpy).toHaveBeenCalledWith(timer)
		expect(state.autoApprovalTimeoutRef).toBeUndefined()
		clearSpy.mockRestore()
	})

	it("cancelAutoApprovalTimeout: ref が無いときは clearTimeout を呼ばず何もしない", () => {
		const state = new AskState()
		const clearSpy = vi.spyOn(globalThis, "clearTimeout")

		state.cancelAutoApprovalTimeout()

		expect(clearSpy).not.toHaveBeenCalled()
		expect(state.autoApprovalTimeoutRef).toBeUndefined()
		clearSpy.mockRestore()
	})

	it("currentAsk は idleAsk があれば resumable/interactive を差し置いて idle を返す", () => {
		const state = new AskState()
		state.idleAsk = idle
		state.resumableAsk = resumable
		state.interactiveAsk = interactive

		expect(state.currentAsk).toBe(idle)
	})

	it("currentAsk は idle が無ければ resumable を優先する", () => {
		const state = new AskState()
		state.resumableAsk = resumable
		state.interactiveAsk = interactive

		expect(state.currentAsk).toBe(resumable)
	})

	it("currentAsk は idle も resumable も無ければ interactive を返す", () => {
		const state = new AskState()
		state.interactiveAsk = interactive

		expect(state.currentAsk).toBe(interactive)
	})
})
