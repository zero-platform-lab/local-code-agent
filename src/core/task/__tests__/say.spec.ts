// npx vitest run core/task/__tests__/say.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ClineMessage } from "@openai-agent/types"

import { say } from "../say"

function makeHost(opts: { abort?: boolean; clineMessages?: ClineMessage[] } = {}) {
	const clineMessages: ClineMessage[] = opts.clineMessages ?? []
	const askState = { lastMessageTs: undefined as number | undefined }
	const host = {
		abort: opts.abort ?? false,
		taskId: "t1",
		instanceId: "i1",
		messageStore: { clineMessages },
		askState,
		addToClineMessages: vi.fn(async (m: ClineMessage) => {
			clineMessages.push(m)
		}),
		updateClineMessage: vi.fn(),
		saveClineMessages: vi.fn(async () => {}),
	}
	return { host, askState, clineMessages }
}

const partial = (say: string): ClineMessage =>
	({ ts: 111, type: "say", say, text: "old", partial: true }) as ClineMessage

beforeEach(() => {
	vi.clearAllMocks()
})

describe("say", () => {
	it("abort 済みなら throw して何もしない", async () => {
		const { host } = makeHost({ abort: true })

		await expect(say({ host } as never, "text", "hi")).rejects.toThrow(/aborted/)
		expect(host.addToClineMessages).not.toHaveBeenCalled()
	})

	it("partial=true・直前が同種 partial なら更新する（新規追加しない）", async () => {
		const { host } = makeHost({ clineMessages: [partial("text")] })

		await say({ host } as never, "text", "new", undefined, true)

		expect(host.addToClineMessages).not.toHaveBeenCalled()
		expect(host.updateClineMessage).toHaveBeenCalled()
		expect(host.messageStore.clineMessages[0].text).toBe("new")
	})

	it("partial=true・新規なら partial として追加し lastMessageTs を進める", async () => {
		const { host, askState } = makeHost()

		await say({ host } as never, "text", "hi", undefined, true)

		expect(host.addToClineMessages).toHaveBeenCalledWith(expect.objectContaining({ partial: true, text: "hi" }))
		expect(askState.lastMessageTs).toBeTypeOf("number")
	})

	it("partial=true・新規・isNonInteractive なら lastMessageTs を進めない", async () => {
		const { host, askState } = makeHost()

		await say({ host } as never, "text", "hi", undefined, true, undefined, undefined, { isNonInteractive: true })

		expect(askState.lastMessageTs).toBeUndefined()
	})

	it("partial=false・直前 partial を完成版で置き換え、保存してから更新する", async () => {
		const { host, askState } = makeHost({ clineMessages: [partial("text")] })

		await say({ host } as never, "text", "done", undefined, false)

		expect(host.saveClineMessages).toHaveBeenCalled()
		expect(host.updateClineMessage).toHaveBeenCalled()
		expect(host.messageStore.clineMessages[0].partial).toBe(false)
		expect(host.messageStore.clineMessages[0].text).toBe("done")
		expect(askState.lastMessageTs).toBe(111) // 元 partial の ts を採用
	})

	it("partial=false・完成置き換え・isNonInteractive なら lastMessageTs を触らない", async () => {
		const { host, askState } = makeHost({ clineMessages: [partial("text")] })

		await say({ host } as never, "text", "done", undefined, false, undefined, undefined, { isNonInteractive: true })

		expect(askState.lastMessageTs).toBeUndefined()
	})

	it("partial=false・直前が非対応なら新規の完成メッセージとして追加し lastMessageTs を進める", async () => {
		const { host, askState } = makeHost()

		await say({ host } as never, "text", "hi", undefined, false)

		expect(host.addToClineMessages).toHaveBeenCalledWith(
			expect.objectContaining({ type: "say", say: "text", text: "hi" }),
		)
		expect(askState.lastMessageTs).toBeTypeOf("number")
	})

	it("partial=false・新規完成・isNonInteractive なら lastMessageTs を進めない", async () => {
		const { host, askState } = makeHost()

		await say({ host } as never, "text", "hi", undefined, false, undefined, undefined, { isNonInteractive: true })

		expect(host.addToClineMessages).toHaveBeenCalled()
		expect(askState.lastMessageTs).toBeUndefined()
	})

	it("partial 未指定なら通常の新規メッセージとして追加する", async () => {
		const { host, askState } = makeHost()

		await say({ host } as never, "text", "hi", undefined, undefined, { cp: 1 })

		expect(host.addToClineMessages).toHaveBeenCalledWith(
			expect.objectContaining({ type: "say", say: "text", text: "hi", checkpoint: { cp: 1 } }),
		)
		expect(askState.lastMessageTs).toBeTypeOf("number")
	})

	it("partial 未指定・isNonInteractive なら lastMessageTs を進めない", async () => {
		const { host, askState } = makeHost()

		await say({ host } as never, "text", "hi", undefined, undefined, undefined, undefined, {
			isNonInteractive: true,
		})

		expect(askState.lastMessageTs).toBeUndefined()
	})
})
