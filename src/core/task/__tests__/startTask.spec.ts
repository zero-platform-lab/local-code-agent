import { MAX_MCP_TOOLS_THRESHOLD } from "@openai-agent/types"
import { describe, it, expect, vi } from "vitest"

import { startTask } from "../startTask"

function makeHost(
	opts: {
		enabledToolCount?: number
		enabledServerCount?: number
		abandoned?: boolean
		abort?: boolean
		abortReason?: string
	} = {},
) {
	return {
		// 前セッションの残骸を模して、初期化でクリアされることを検証できるようにする
		messageStore: {
			clineMessages: [{ ts: 1 }] as unknown[],
			apiConversationHistory: [{ role: "user" }] as unknown[],
		},
		isInitialized: false,
		abort: opts.abort ?? false,
		abandoned: opts.abandoned ?? false,
		abortReason: opts.abortReason,
		say: vi.fn((..._a: unknown[]) => Promise.resolve()),
		getEnabledMcpToolsCount: vi.fn(() =>
			Promise.resolve({
				enabledToolCount: opts.enabledToolCount ?? 5,
				enabledServerCount: opts.enabledServerCount ?? 1,
			}),
		),
		initiateTaskLoop: vi.fn((..._a: unknown[]) => Promise.resolve()),
		postStateToWebviewWithoutTaskHistory: vi.fn((..._a: unknown[]) => Promise.resolve()),
	}
}

describe("startTask", () => {
	it("初期化：stale 履歴を空に戻し text を say、ツール数が閾値以下なら警告せず isInitialized を立てて initiateTaskLoop を呼ぶ", async () => {
		// ちょうど閾値（60 > 60 は false）なので警告は出ない、という境界を突く
		const host = makeHost({ enabledToolCount: MAX_MCP_TOOLS_THRESHOLD })

		await startTask({ host } as never, "do it", undefined)

		expect(host.messageStore.clineMessages).toEqual([])
		expect(host.messageStore.apiConversationHistory).toEqual([])
		expect(host.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(1)
		// 最初の say はタスク本文
		expect(host.say).toHaveBeenNthCalledWith(1, "text", "do it", undefined)
		// 警告 say は無いので say は 1 回だけ
		expect(host.say).toHaveBeenCalledTimes(1)
		expect(host.isInitialized).toBe(true)
		const content = host.initiateTaskLoop.mock.calls[0][0]
		expect(content).toEqual([{ type: "text", text: "<user_message>\ndo it\n</user_message>" }])
	})

	it("ツール数が閾値超過なら too_many_tools_warning を非対話で say する", async () => {
		const host = makeHost({
			enabledToolCount: MAX_MCP_TOOLS_THRESHOLD + 1,
			enabledServerCount: 3,
		})

		await startTask({ host } as never, "hi", undefined)

		expect(host.say).toHaveBeenNthCalledWith(
			2,
			"too_many_tools_warning",
			JSON.stringify({
				toolCount: MAX_MCP_TOOLS_THRESHOLD + 1,
				serverCount: 3,
				threshold: MAX_MCP_TOOLS_THRESHOLD,
			}),
			undefined,
			undefined,
			undefined,
			undefined,
			{ isNonInteractive: true },
		)
		expect(host.say).toHaveBeenCalledTimes(2)
	})

	it("images があれば say と initiateTaskLoop の両方へ画像ブロックを渡す", async () => {
		const host = makeHost()
		const images = ["data:image/png;base64,AAAA"]

		await startTask({ host } as never, "hi", images)

		expect(host.say).toHaveBeenNthCalledWith(1, "text", "hi", images)
		const content = host.initiateTaskLoop.mock.calls[0][0]
		expect(content).toEqual([
			{ type: "text", text: "<user_message>\nhi\n</user_message>" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		])
	})

	it("ループ拒否かつ abandoned なら握りつぶして resolve する（unhandled rejection を出さない）", async () => {
		const host = makeHost({ abandoned: true })
		host.initiateTaskLoop.mockRejectedValue(new Error("loop"))

		await expect(startTask({ host } as never, "hi", undefined)).resolves.toBeUndefined()
	})

	it("ループ拒否かつ abortReason=user_cancelled なら握りつぶして resolve する", async () => {
		const host = makeHost({ abortReason: "user_cancelled" })
		host.initiateTaskLoop.mockRejectedValue(new Error("loop"))

		await expect(startTask({ host } as never, "hi", undefined)).resolves.toBeUndefined()
	})

	it("ループ拒否で中断フラグがどれも立っていなければ、内側 catch が投げ外側 catch も再送出する", async () => {
		const host = makeHost()
		host.initiateTaskLoop.mockRejectedValue(new Error("loop"))

		await expect(startTask({ host } as never, "hi", undefined)).rejects.toThrow("loop")
	})

	it("初期化中の say 失敗でも abandoned なら外側 catch で握りつぶす（ループには進まない）", async () => {
		const host = makeHost({ abandoned: true })
		host.say.mockRejectedValue(new Error("say boom"))

		await expect(startTask({ host } as never, "hi", undefined)).resolves.toBeUndefined()
		expect(host.initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("初期化中の say 失敗でも abort なら外側 catch で握りつぶす", async () => {
		const host = makeHost({ abort: true })
		host.say.mockRejectedValue(new Error("say boom"))

		await expect(startTask({ host } as never, "hi", undefined)).resolves.toBeUndefined()
	})

	it("初期化中の say 失敗でも abortReason=user_cancelled なら外側 catch で握りつぶす", async () => {
		const host = makeHost({ abortReason: "user_cancelled" })
		host.say.mockRejectedValue(new Error("say boom"))

		await expect(startTask({ host } as never, "hi", undefined)).resolves.toBeUndefined()
	})
})
