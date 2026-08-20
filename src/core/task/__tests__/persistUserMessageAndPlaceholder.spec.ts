import { describe, it, expect, vi } from "vitest"

import {
	persistUserMessageAndPlaceholder,
	type PersistUserMessageAndPlaceholderInput,
} from "../persistUserMessageAndPlaceholder"

function makeDeps(
	clineMessages: Array<{ say?: string; text?: string }> = [{ say: "api_req_started", text: "placeholder" }],
) {
	const host = { messageStore: { clineMessages } }
	const addToApiConversationHistory = vi.fn((_m: unknown) => Promise.resolve())
	const saveClineMessages = vi.fn((..._a: unknown[]) => Promise.resolve())
	const postStateToWebviewWithoutTaskHistory = vi.fn((..._a: unknown[]) => Promise.resolve())

	const deps = {
		host,
		addToApiConversationHistory,
		saveClineMessages,
		postStateToWebviewWithoutTaskHistory,
	}
	return {
		deps,
		host,
		clineMessages,
		addToApiConversationHistory,
		saveClineMessages,
		postStateToWebviewWithoutTaskHistory,
	}
}

function makeInput(over: Partial<PersistUserMessageAndPlaceholderInput> = {}): PersistUserMessageAndPlaceholderInput {
	return {
		contentWithoutEnvDetails: [{ type: "text", text: "hello" }],
		environmentDetails: "<env>details</env>",
		retryAttempt: 0,
		userMessageWasRemoved: false,
		isEmptyOriginalUserContent: false,
		apiProtocol: "openai",
		...over,
	}
}

describe("persistUserMessageAndPlaceholder", () => {
	it("初回・user content あり: env_details を末尾 text ブロックに積んで user message を会話履歴へ追加する", async () => {
		const { deps, addToApiConversationHistory } = makeDeps()

		await persistUserMessageAndPlaceholder(deps as never, makeInput())

		expect(addToApiConversationHistory).toHaveBeenCalledTimes(1)
		expect(addToApiConversationHistory).toHaveBeenCalledWith({
			role: "user",
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: "<env>details</env>" },
			],
		})
	})

	it("空 user content（委譲再開）: retryAttempt 0 でも user message を再追加しない", async () => {
		const { deps, addToApiConversationHistory } = makeDeps()

		await persistUserMessageAndPlaceholder(deps as never, makeInput({ isEmptyOriginalUserContent: true }))

		expect(addToApiConversationHistory).not.toHaveBeenCalled()
	})

	it("retry 中（retryAttempt>0）: 連続 user message を避けるため履歴追加しない", async () => {
		const { deps, addToApiConversationHistory } = makeDeps()

		await persistUserMessageAndPlaceholder(deps as never, makeInput({ retryAttempt: 1 }))

		expect(addToApiConversationHistory).not.toHaveBeenCalled()
	})

	it("前段で user message を削除済みなら、retry 中かつ空 content でも再追加する", async () => {
		const { deps, addToApiConversationHistory } = makeDeps()

		await persistUserMessageAndPlaceholder(
			deps as never,
			makeInput({ retryAttempt: 2, isEmptyOriginalUserContent: true, userMessageWasRemoved: true }),
		)

		expect(addToApiConversationHistory).toHaveBeenCalledTimes(1)
	})

	it("最後の api_req_started placeholder を apiProtocol の JSON で上書きし、その index を返す", async () => {
		const clineMessages = [
			{ say: "api_req_started", text: "old-first" },
			{ say: "text", text: "keep" },
			{ say: "api_req_started", text: "placeholder" },
		]
		const { deps } = makeDeps(clineMessages)

		const result = await persistUserMessageAndPlaceholder(deps as never, makeInput({ apiProtocol: "openai" }))

		expect(result).toEqual({ lastApiReqIndex: 2 })
		// 直近の placeholder のみ更新、手前の api_req_started は不変
		expect(clineMessages[2].text).toBe(JSON.stringify({ apiProtocol: "openai" }))
		expect(clineMessages[0].text).toBe("old-first")
		expect(clineMessages[1].text).toBe("keep")
	})

	it("api_req_started placeholder が無い履歴でも throw せず、index -1 を返して text 更新をスキップする", async () => {
		// 呼び出し順が崩れた/壊れた再開経路を模す（placeholder 未積み）
		const clineMessages = [{ say: "text", text: "keep" }]
		const { deps, saveClineMessages, postStateToWebviewWithoutTaskHistory } = makeDeps(clineMessages)

		const result = await persistUserMessageAndPlaceholder(deps as never, makeInput())

		expect(result).toEqual({ lastApiReqIndex: -1 })
		// clineMessages[-1] への代入が起きず、既存メッセージは不変
		expect(clineMessages[0].text).toBe("keep")
		// 永続化と通知は通常どおり行う
		expect(saveClineMessages).toHaveBeenCalledTimes(1)
		expect(postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(1)
	})

	it("永続化と webview 通知を saveClineMessages→postStateToWebviewWithoutTaskHistory の順で行う", async () => {
		const order: string[] = []
		const { deps, saveClineMessages, postStateToWebviewWithoutTaskHistory } = makeDeps()
		saveClineMessages.mockImplementation(() => {
			order.push("save")
			return Promise.resolve()
		})
		postStateToWebviewWithoutTaskHistory.mockImplementation(() => {
			order.push("postState")
			return Promise.resolve()
		})

		await persistUserMessageAndPlaceholder(deps as never, makeInput())

		expect(order).toEqual(["save", "postState"])
	})
})
