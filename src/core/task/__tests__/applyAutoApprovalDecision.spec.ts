import { describe, it, expect, vi } from "vitest"

import { applyAutoApprovalDecision } from "../applyAutoApprovalDecision"

function makeHost() {
	const approveAsk = vi.fn()
	const denyAsk = vi.fn()
	const handleWebviewAskResponse = vi.fn()
	const host = { approveAsk, denyAsk, handleWebviewAskResponse }
	return { host, approveAsk, denyAsk, handleWebviewAskResponse }
}

describe("applyAutoApprovalDecision", () => {
	it("approve は approveAsk だけを即時に呼ぶ", () => {
		const { host, approveAsk, denyAsk, handleWebviewAskResponse } = makeHost()

		applyAutoApprovalDecision(host, { decision: "approve" })

		expect(approveAsk).toHaveBeenCalledTimes(1)
		expect(denyAsk).not.toHaveBeenCalled()
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("deny は denyAsk だけを即時に呼ぶ", () => {
		const { host, approveAsk, denyAsk, handleWebviewAskResponse } = makeHost()

		applyAutoApprovalDecision(host, { decision: "deny" })

		expect(denyAsk).toHaveBeenCalledTimes(1)
		expect(approveAsk).not.toHaveBeenCalled()
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("ask は何も呼ばない（呼び出し側の待受へ委ねる）", () => {
		const { host, approveAsk, denyAsk, handleWebviewAskResponse } = makeHost()

		applyAutoApprovalDecision(host, { decision: "ask" })

		expect(approveAsk).not.toHaveBeenCalled()
		expect(denyAsk).not.toHaveBeenCalled()
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it("respond は待たずに、その場で返事を handleWebviewAskResponse へ渡す", () => {
		const { host, approveAsk, denyAsk, handleWebviewAskResponse } = makeHost()

		applyAutoApprovalDecision(host, { decision: "respond", askResponse: "messageResponse", text: "auto" })

		// タイマーを置かないので、呼び出しが戻った時点で渡し終えている
		expect(handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "auto")
		expect(approveAsk).not.toHaveBeenCalled()
		expect(denyAsk).not.toHaveBeenCalled()
	})
})
