import { describe, it, expect, vi } from "vitest"

import { handleMidStreamError, type HandleMidStreamErrorStateHost } from "../handleMidStreamError"

function makeDeps(
	opts: {
		abort?: boolean
		abandoned?: boolean
		autoApproval?: boolean
		backoffAndAnnounce?: (retryAttempt: number, error: unknown) => Promise<void>
	} = {},
) {
	const host: HandleMidStreamErrorStateHost = {
		taskId: "t1",
		instanceId: "i1",
		abort: opts.abort ?? false,
		abandoned: opts.abandoned ?? false,
		abortReason: undefined,
	}
	const deps = {
		host,
		abortStream: vi.fn(async () => {}),
		abortTask: vi.fn(async () => {}),
		getProviderState: vi.fn(async () => ({ autoApprovalEnabled: opts.autoApproval ?? false })),
		backoffAndAnnounce: opts.backoffAndAnnounce ?? vi.fn(async () => {}),
	}
	return deps
}

const userContent = [{ type: "text", text: "hi" }] as never

describe("handleMidStreamError", () => {
	it("abandoned なら何もせず noop（abortStream も呼ばない）", async () => {
		const deps = makeDeps({ abandoned: true })

		const result = await handleMidStreamError(deps as never, new Error("boom"), userContent, 0)

		expect(result).toEqual({ action: "noop" })
		expect(deps.abortStream).not.toHaveBeenCalled()
		expect(deps.abortTask).not.toHaveBeenCalled()
	})

	it("ユーザーキャンセル：user_cancelled で abortStream→abortTask し abortReason を残して noop", async () => {
		const deps = makeDeps({ abort: true })

		const result = await handleMidStreamError(deps as never, new Error("boom"), userContent, 0)

		expect(deps.abortStream).toHaveBeenCalledWith("user_cancelled", undefined)
		expect(deps.host.abortReason).toBe("user_cancelled")
		expect(deps.abortTask).toHaveBeenCalledTimes(1)
		expect(result).toEqual({ action: "noop" })
	})

	it("ストリーム失敗・autoApproval 無効：バックオフせず retryAttempt+1 で continue（abortTask は呼ばない）", async () => {
		const deps = makeDeps({ autoApproval: false })

		const result = await handleMidStreamError(deps as never, new Error("boom"), userContent, 2)

		// streaming_failed の理由でストリームを畳み、失敗メッセージには生のエラー文言が乗る
		expect(deps.abortStream).toHaveBeenCalledWith("streaming_failed", expect.stringContaining("boom"))
		expect(deps.backoffAndAnnounce).not.toHaveBeenCalled()
		expect(deps.abortTask).not.toHaveBeenCalled()
		expect(result).toEqual({
			action: "continue",
			retryStackItem: { userContent, includeFileDetails: false, retryAttempt: 3 },
		})
	})

	it("ストリーム失敗・autoApproval 有効：バックオフ後に retryAttempt+1 で continue", async () => {
		const error = new Error("boom")
		const deps = makeDeps({ autoApproval: true })

		const result = await handleMidStreamError(deps as never, error, userContent, 1)

		expect(deps.backoffAndAnnounce).toHaveBeenCalledWith(1, error)
		expect(result).toEqual({
			action: "continue",
			retryStackItem: { userContent, includeFileDetails: false, retryAttempt: 2 },
		})
	})

	it("autoApproval 有効・バックオフ中に abort されたら abortTask して break", async () => {
		const deps = makeDeps({ autoApproval: true })
		// バックオフ待ちの最中にユーザーがタスクを中断したケースを再現する
		deps.backoffAndAnnounce = vi.fn(async () => {
			deps.host.abort = true
		})

		const result = await handleMidStreamError(deps as never, new Error("boom"), userContent, 0)

		expect(deps.host.abortReason).toBe("user_cancelled")
		expect(deps.abortTask).toHaveBeenCalledTimes(1)
		expect(result).toEqual({ action: "break" })
	})

	it("error.message が無い場合は serializeError で失敗メッセージを組み立てる", async () => {
		const deps = makeDeps({ autoApproval: false })

		await handleMidStreamError(deps as never, { code: "ECONN" } as never, userContent, 0)

		expect(deps.abortStream).toHaveBeenCalledWith("streaming_failed", expect.stringContaining("ECONN"))
	})
})
