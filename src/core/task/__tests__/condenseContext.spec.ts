// npx vitest run core/task/__tests__/condenseContext.spec.ts
//
// ユーザーが明示的に発火させる condense（/condense 相当）。
//
// 動機:
//   専用テストが無かった。自動 condense（applyInRequestContextManagement）とは
//   別経路で、こちらは失敗しても履歴を壊さないことが要件。
//   特に「要約前に保留中の tool 結果を必ず履歴へ流す」順序は、守らないと
//   tool ペアが欠けた状態で要約に入る。

import { describe, it, expect, vi, beforeEach } from "vitest"

import { condenseContext } from "../apiRequestOrchestrator"

vi.mock("../../condense", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../condense")>()),
	summarizeConversation: vi.fn(),
}))

import { summarizeConversation } from "../../condense"

const mockedSummarize = vi.mocked(summarizeConversation)

const history = [{ type: "message", role: "user", content: "hi", ts: 1 }]

function makeDeps() {
	const order: string[] = []
	const api = {
		getModel: () => ({ id: "m", info: { contextWindow: 100000, supportsPromptCache: false } }),
		countTokens: vi.fn(async () => 10),
	}
	const deps = {
		flushPendingToolResultsToHistory: vi.fn(async () => {
			order.push("flush")
		}),
		getSystemPrompt: vi.fn(async () => "SYS"),
		getProviderState: vi.fn(async () => ({ mode: "code" })),
		getTokenUsage: vi.fn(() => ({ contextTokens: 5000 })),
		getCurrentProfileId: vi.fn(() => "p1"),
		buildTools: vi.fn(async () => ({ tools: [] })),
		getEnvironmentDetails: vi.fn(async () => "env"),
		getFilesReadByAgentSafely: vi.fn(async () => ["a.ts"]),
		overwriteApiConversationHistory: vi.fn(async () => {
			order.push("overwrite")
		}),
		say: vi.fn(async (..._args: unknown[]) => {}),
		processQueuedMessages: vi.fn(),
		host: {
			api,
			apiConfiguration: {},
			taskId: "t1",
			cwd: "/cwd",
			rooIgnoreController: undefined,
			messageStore: { apiConversationHistory: history },
		},
	}
	mockedSummarize.mockImplementation(async () => {
		order.push("summarize")
		return { messages: history, summary: "まとめ", cost: 0.1, newContextTokens: 100, condenseId: "c1" } as never
	})
	return { deps: deps as never, order, raw: deps }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("condenseContext", () => {
	it("要約より先に保留中の tool 結果を履歴へ流す", async () => {
		// これを守らないと tool ペアが欠けたまま要約に入る
		const { deps, order } = makeDeps()
		await condenseContext(deps)
		expect(order.indexOf("flush")).toBeLessThan(order.indexOf("summarize"))
	})

	it("手動発火なので isAutomaticTrigger は false", async () => {
		const { deps } = makeDeps()
		await condenseContext(deps)
		expect(mockedSummarize).toHaveBeenCalledWith(expect.objectContaining({ isAutomaticTrigger: false }))
	})

	it("成功したら履歴を差し替え、condense_context を流し、キューを処理する", async () => {
		const { deps, raw, order } = makeDeps()
		await condenseContext(deps)

		expect(order).toContain("overwrite")
		const say = raw.say.mock.calls[0]
		expect(say[0]).toBe("condense_context")
		expect(say[7]).toMatchObject({
			summary: "まとめ",
			cost: 0.1,
			newContextTokens: 100,
			prevContextTokens: 5000,
			condenseId: "c1",
		})
		expect(raw.processQueuedMessages).toHaveBeenCalledTimes(1)
	})

	it("エラー時は履歴を差し替えず、キュー処理もしない", async () => {
		mockedSummarize.mockResolvedValue({ messages: history, error: "失敗", cost: 0 } as never)
		const { deps, raw } = makeDeps()
		mockedSummarize.mockResolvedValue({ messages: history, error: "失敗", cost: 0 } as never)

		await condenseContext(deps)

		expect(raw.overwriteApiConversationHistory).not.toHaveBeenCalled()
		expect(raw.processQueuedMessages).not.toHaveBeenCalled()
		expect(raw.say.mock.calls[0][0]).toBe("condense_context_error")
		expect(raw.say.mock.calls[0][1]).toBe("失敗")
	})

	it("環境詳細と既読ファイルを要約の入力に渡す", async () => {
		const { deps } = makeDeps()
		await condenseContext(deps)
		expect(mockedSummarize).toHaveBeenCalledWith(
			expect.objectContaining({ environmentDetails: "env", filesReadByAgent: ["a.ts"] }),
		)
	})

	it("customSupportPrompts.CONDENSE があれば要約に渡す", async () => {
		const { deps, raw } = makeDeps()
		raw.getProviderState.mockResolvedValue({
			mode: "code",
			customSupportPrompts: { CONDENSE: "custom prompt" },
		} as never)

		await condenseContext(deps)

		expect(mockedSummarize).toHaveBeenCalledWith(
			expect.objectContaining({ customCondensingPrompt: "custom prompt" }),
		)
	})

	it("prevContextTokens が未取得なら 0 として反映する（?? 0）", async () => {
		const { deps, raw } = makeDeps()
		raw.getTokenUsage.mockReturnValue({} as never)

		await condenseContext(deps)

		expect(raw.say.mock.calls[0][7]).toMatchObject({ prevContextTokens: 0 })
	})
})
