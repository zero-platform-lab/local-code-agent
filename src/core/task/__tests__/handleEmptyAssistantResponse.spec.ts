import { describe, it, expect, vi } from "vitest"

import { handleEmptyAssistantResponse } from "../handleEmptyAssistantResponse"

function makeDeps(
	opts: {
		autoApproval?: boolean
		askResponse?: string
		abort?: boolean
		noAssistantMessages?: number
		history?: unknown[]
	} = {},
) {
	const host = {
		taskId: "t1",
		instanceId: "i1",
		abort: opts.abort ?? false,
		graceRetry: { noAssistantMessages: opts.noAssistantMessages ?? 0 },
		messageStore: { apiConversationHistory: opts.history ?? [] },
	}
	const deps = {
		host,
		say: vi.fn(async () => {}),
		ask: vi.fn(async () => ({ response: opts.askResponse ?? "yesButtonClicked" })),
		getProviderState: vi.fn(async () => ({ autoApprovalEnabled: opts.autoApproval ?? false })),
		addToApiConversationHistory: vi.fn(async () => {}),
		backoffAndAnnounce: vi.fn(async () => {}),
	}
	return deps as never
}

const userContent = [{ type: "text", text: "hi" }] as never

describe("handleEmptyAssistantResponse", () => {
	it("初回失敗は grace retry：エラーを出さずカウントだけ上げる", async () => {
		const deps = makeDeps({ autoApproval: true, noAssistantMessages: 0 })

		await handleEmptyAssistantResponse(deps, userContent, 0)

		expect((deps as any).host.graceRetry.noAssistantMessages).toBe(1)
		expect((deps as any).say).not.toHaveBeenCalledWith("error", "MODEL_NO_ASSISTANT_MESSAGES")
	})

	it("2 回目の連続失敗で MODEL_NO_ASSISTANT_MESSAGES エラーを出す", async () => {
		const deps = makeDeps({ autoApproval: true, noAssistantMessages: 1 })

		await handleEmptyAssistantResponse(deps, userContent, 0)

		expect((deps as any).say).toHaveBeenCalledWith("error", "MODEL_NO_ASSISTANT_MESSAGES")
	})

	it("末尾の user ターンを丸ごと履歴から取り除く（連続 user を防ぐ）", async () => {
		// item 列では 1 ターンが複数要素に割れるので、末尾から user ターンが続く間だけ剥がす。
		const history = [
			{ type: "message", role: "assistant", content: "前のターン" },
			{ type: "function_call_output", call_id: "c1", output: "tool result" },
			{ type: "message", role: "user", content: "本文" },
		]
		const deps = makeDeps({ autoApproval: true, history })

		await handleEmptyAssistantResponse(deps, userContent, 0)

		expect(history).toEqual([{ type: "message", role: "assistant", content: "前のターン" }])
	})

	it("末尾が assistant なら履歴を取り除かない", async () => {
		const history = [{ type: "message", role: "assistant", content: "" }]
		const deps = makeDeps({ autoApproval: true, history })

		await handleEmptyAssistantResponse(deps, userContent, 0)

		expect(history).toHaveLength(1)
	})

	it("autoApproval 有効：バックオフ後に retryAttempt+1・userMessageWasRemoved で continue", async () => {
		const deps = makeDeps({ autoApproval: true })

		const result = await handleEmptyAssistantResponse(deps, userContent, 2)

		expect((deps as any).backoffAndAnnounce).toHaveBeenCalledWith(2, expect.any(Error))
		expect(result).toEqual({
			action: "continue",
			retryStackItem: {
				userContent,
				includeFileDetails: false,
				retryAttempt: 3,
				userMessageWasRemoved: true,
			},
		})
	})

	it("autoApproval 有効・バックオフ中に abort されたら break", async () => {
		const deps = makeDeps({ autoApproval: true, abort: true })

		const result = await handleEmptyAssistantResponse(deps, userContent, 0)

		expect(result).toEqual({ action: "break" })
	})

	it("手動・ユーザー承認：api_req_retried を出し、pop 済み user を再追加させるため userMessageWasRemoved 付きで continue", async () => {
		const deps = makeDeps({ autoApproval: false, askResponse: "yesButtonClicked" })

		const result = await handleEmptyAssistantResponse(deps, userContent, 1)

		expect((deps as any).say).toHaveBeenCalledWith("api_req_retried")
		// auto 経路と同様に userMessageWasRemoved:true を付ける（付けないと pop した user が再追加されず欠落する）
		expect(result).toEqual({
			action: "continue",
			retryStackItem: { userContent, includeFileDetails: false, retryAttempt: 2, userMessageWasRemoved: true },
		})
	})

	it("手動・ユーザー拒否：user を戻し、Failure の assistant を残して諦める", async () => {
		const deps = makeDeps({ autoApproval: false, askResponse: "noButtonClicked" })

		const result = await handleEmptyAssistantResponse(deps, userContent, 0)

		expect((deps as any).addToApiConversationHistory).toHaveBeenNthCalledWith(1, {
			role: "user",
			content: userContent,
		})
		expect((deps as any).addToApiConversationHistory).toHaveBeenNthCalledWith(2, {
			role: "assistant",
			content: [{ type: "text", text: "Failure: I did not provide a response." }],
		})
		expect(result).toEqual({ action: "continue" })
	})
})
