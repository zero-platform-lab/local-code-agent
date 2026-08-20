// npx vitest run core/task/__tests__/handleContextWindowExceededError.spec.ts
//
// コンテキストウィンドウ超過を API が返したときの緊急切り詰め。
//
// 動機:
//   attemptApiRequest の catch から呼ばれる復旧経路だが、専用テストが無かった。
//   実際に踏むのは「長い会話でモデルが 400 を返した」ときで、ここが壊れていると
//   タスクが復旧不能になる。特に finally のスピナー解除を落とすと webview が
//   待ちっぱなしになる。

import { describe, it, expect, vi, beforeEach } from "vitest"

import { FORCED_CONTEXT_REDUCTION_PERCENT, handleContextWindowExceededError } from "../apiRequestOrchestrator"

vi.mock("../../context-management", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../context-management")>()),
	manageContext: vi.fn(),
}))
vi.mock("../../../shared/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../shared/api")>()),
	getModelMaxOutputTokens: vi.fn(() => 8192),
}))

import { manageContext } from "../../context-management"

const mockedManageContext = vi.mocked(manageContext)

const history = [{ type: "message", role: "user", content: "hi", ts: 1 }]

function makeDeps() {
	const api = {
		getModel: () => ({ id: "test-model", info: { contextWindow: 100000, supportsPromptCache: false } }),
		countTokens: vi.fn(async () => 10),
	}
	return {
		getProviderState: vi.fn(async () => ({ mode: "code" })),
		getTokenUsage: vi.fn(() => ({ contextTokens: 90000 })),
		getCurrentProfileId: vi.fn(() => "profile1"),
		getSystemPrompt: vi.fn(async () => "SYS"),
		postCondenseTaskContext: vi.fn(async () => {}),
		buildTools: vi.fn(async () => ({ tools: [] })),
		getEnvironmentDetails: vi.fn(async () => "env"),
		overwriteApiConversationHistory: vi.fn(async () => {}),
		say: vi.fn(async () => {}),
		host: {
			api,
			apiConfiguration: {},
			taskId: "task-1",
			cwd: "/cwd",
			rooIgnoreController: undefined,
			messageStore: { apiConversationHistory: history },
		},
	} as never
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedManageContext.mockResolvedValue({ messages: history, prevContextTokens: 0, cost: 0 } as never)
})

describe("handleContextWindowExceededError", () => {
	it("強制切り詰めの割合は FORCED_CONTEXT_REDUCTION_PERCENT を使う", async () => {
		const deps = makeDeps()
		await handleContextWindowExceededError(deps)

		expect(mockedManageContext).toHaveBeenCalledWith(
			expect.objectContaining({
				autoCondenseContext: true,
				autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT,
			}),
		)
		// 緊急経路なので、ユーザー設定の autoCondenseContext には従わない
		expect(FORCED_CONTEXT_REDUCTION_PERCENT).toBe(75)
	})

	it("in-progress を出してから畳む", async () => {
		const deps = makeDeps()
		await handleContextWindowExceededError(deps)

		const calls = (deps as never as { postCondenseTaskContext: { mock: { calls: boolean[][] } } })
			.postCondenseTaskContext.mock.calls
		expect(calls.map((c) => c[0])).toEqual([true, false])
	})

	it("manageContext が投げても finally でスピナーを必ず畳む", async () => {
		mockedManageContext.mockRejectedValue(new Error("boom"))
		const deps = makeDeps()

		await expect(handleContextWindowExceededError(deps)).rejects.toThrow("boom")

		const calls = (deps as never as { postCondenseTaskContext: { mock: { calls: boolean[][] } } })
			.postCondenseTaskContext.mock.calls
		expect(calls.map((c) => c[0])).toEqual([true, false])
	})

	it("履歴が変わったときだけ差し替える", async () => {
		const deps = makeDeps()
		await handleContextWindowExceededError(deps)
		expect(
			(deps as never as { overwriteApiConversationHistory: { mock: { calls: unknown[] } } })
				.overwriteApiConversationHistory.mock.calls,
		).toHaveLength(0)

		const newHistory = [{ type: "message", role: "user", content: "new" }]
		mockedManageContext.mockResolvedValue({ messages: newHistory, prevContextTokens: 0, cost: 0 } as never)
		const deps2 = makeDeps()
		await handleContextWindowExceededError(deps2)
		expect(
			(deps2 as never as { overwriteApiConversationHistory: { mock: { calls: unknown[][] } } })
				.overwriteApiConversationHistory.mock.calls[0][0],
		).toBe(newHistory)
	})

	it("要約が返れば condense_context を流す", async () => {
		mockedManageContext.mockResolvedValue({
			messages: history,
			summary: "まとめ",
			cost: 0.5,
			prevContextTokens: 90000,
			newContextTokens: 1000,
		} as never)
		const deps = makeDeps()
		await handleContextWindowExceededError(deps)

		const say = (deps as never as { say: { mock: { calls: unknown[][] } } }).say.mock.calls[0]
		expect(say[0]).toBe("condense_context")
		expect(say[7]).toMatchObject({ summary: "まとめ", prevContextTokens: 90000, newContextTokens: 1000 })
	})

	it("state 未取得・contextTokens 未取得でも既定にフォールバックする（?? {} / || 0）", async () => {
		const deps = makeDeps()
		;(deps as any).getProviderState.mockResolvedValue(undefined)
		;(deps as any).getTokenUsage.mockReturnValue({})

		await handleContextWindowExceededError(deps)

		expect(mockedManageContext).toHaveBeenCalledWith(
			expect.objectContaining({ totalTokens: 0, profileThresholds: {} }),
		)
	})

	it("messagesRemoved / newContextTokensAfterTruncation 未指定でも 0 として流す（?? 0）", async () => {
		mockedManageContext.mockResolvedValue({
			messages: history,
			cost: 0,
			prevContextTokens: 90000,
			truncationId: "t2",
		} as never)
		const deps = makeDeps()

		await handleContextWindowExceededError(deps)

		const say = (deps as never as { say: { mock: { calls: unknown[][] } } }).say.mock.calls[0]
		expect(say[0]).toBe("sliding_window_truncation")
		expect(say[8]).toMatchObject({ truncationId: "t2", messagesRemoved: 0, newContextTokens: 0 })
	})

	it("要約が無く切り詰めだけなら sliding_window_truncation を流す", async () => {
		mockedManageContext.mockResolvedValue({
			messages: history,
			cost: 0,
			prevContextTokens: 90000,
			truncationId: "t1",
			messagesRemoved: 4,
			newContextTokensAfterTruncation: 500,
		} as never)
		const deps = makeDeps()
		await handleContextWindowExceededError(deps)

		const say = (deps as never as { say: { mock: { calls: unknown[][] } } }).say.mock.calls[0]
		expect(say[0]).toBe("sliding_window_truncation")
		expect(say[8]).toMatchObject({ truncationId: "t1", messagesRemoved: 4, newContextTokens: 500 })
	})
})
