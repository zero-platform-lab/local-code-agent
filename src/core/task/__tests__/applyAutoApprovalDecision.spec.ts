import { describe, it, expect, vi, afterEach } from "vitest"

import type { CheckAutoApprovalResult } from "../../auto-approval"
import { applyAutoApprovalDecision } from "../applyAutoApprovalDecision"

function makeHost() {
	const approveAsk = vi.fn()
	const denyAsk = vi.fn()
	const handleWebviewAskResponse = vi.fn()
	const askState = { autoApprovalTimeoutRef: undefined as NodeJS.Timeout | undefined }
	const host = { approveAsk, denyAsk, handleWebviewAskResponse, askState }
	return { host, approveAsk, denyAsk, handleWebviewAskResponse, askState }
}

afterEach(() => {
	vi.useRealTimers()
})

describe("applyAutoApprovalDecision", () => {
	it("approve は approveAsk を即時に呼び、timeout を仕込まず undefined を返す", () => {
		const { host, approveAsk, denyAsk } = makeHost()

		const result = applyAutoApprovalDecision(host as never, { decision: "approve" })

		expect(approveAsk).toHaveBeenCalledTimes(1)
		expect(denyAsk).not.toHaveBeenCalled()
		expect(result).toBeUndefined()
		expect(host.askState.autoApprovalTimeoutRef).toBeUndefined()
	})

	it("deny は denyAsk を即時に呼び、approveAsk は呼ばず undefined を返す", () => {
		const { host, approveAsk, denyAsk } = makeHost()

		const result = applyAutoApprovalDecision(host as never, { decision: "deny" })

		expect(denyAsk).toHaveBeenCalledTimes(1)
		expect(approveAsk).not.toHaveBeenCalled()
		expect(result).toBeUndefined()
	})

	it("ask は何も呼ばず undefined を返す（呼び出し側の待受へ委ねる）", () => {
		const { host, approveAsk, denyAsk, handleWebviewAskResponse } = makeHost()

		const result = applyAutoApprovalDecision(host as never, { decision: "ask" })

		expect(approveAsk).not.toHaveBeenCalled()
		expect(denyAsk).not.toHaveBeenCalled()
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()
		expect(result).toBeUndefined()
	})

	it("timeout は指定時間経過後に fn() の応答を handleWebviewAskResponse へ渡し、ref をクリアする", () => {
		vi.useFakeTimers()
		const { host, handleWebviewAskResponse } = makeHost()
		const fn = vi.fn(() => ({ askResponse: "messageResponse" as const, text: "auto", images: ["img1"] }))
		const approval: CheckAutoApprovalResult = { decision: "timeout", timeout: 1000, fn }

		const result = applyAutoApprovalDecision(host as never, approval)

		// 返り値と askState.autoApprovalTimeoutRef には同一ハンドルが入る（後からユーザー操作で clear 可能にするため）
		expect(result).toBeDefined()
		expect(result).toBe(host.askState.autoApprovalTimeoutRef)
		// まだ発火していない
		expect(fn).not.toHaveBeenCalled()
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()

		// 期限前は発火しない
		vi.advanceTimersByTime(999)
		expect(handleWebviewAskResponse).not.toHaveBeenCalled()

		// 期限到達で fn() を評価し、その応答をそのまま webview 応答ハンドラへ渡す
		vi.advanceTimersByTime(1)
		expect(fn).toHaveBeenCalledTimes(1)
		expect(handleWebviewAskResponse).toHaveBeenCalledWith("messageResponse", "auto", ["img1"])
		// 発火後は自動承認 ref をクリアする
		expect(host.askState.autoApprovalTimeoutRef).toBeUndefined()
	})

	it("timeout: fn が text/images を返さない場合も handleWebviewAskResponse に undefined を渡して発火する", () => {
		vi.useFakeTimers()
		const { host, handleWebviewAskResponse } = makeHost()
		const fn = vi.fn(() => ({ askResponse: "yesButtonClicked" as const }))
		const approval: CheckAutoApprovalResult = { decision: "timeout", timeout: 500, fn }

		applyAutoApprovalDecision(host as never, approval)
		vi.advanceTimersByTime(500)

		expect(handleWebviewAskResponse).toHaveBeenCalledWith("yesButtonClicked", undefined, undefined)
		expect(host.askState.autoApprovalTimeoutRef).toBeUndefined()
	})
})
