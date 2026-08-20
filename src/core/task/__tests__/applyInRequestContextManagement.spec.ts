import { describe, it, expect, vi, beforeEach } from "vitest"

import { applyInRequestContextManagement } from "../apiRequestOrchestrator"

vi.mock("../../context-management", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../context-management")>()),
	manageContext: vi.fn(),
	willManageContext: vi.fn(),
}))
vi.mock("../../../shared/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../shared/api")>()),
	getModelMaxOutputTokens: vi.fn(() => 8192),
}))

import { manageContext, willManageContext } from "../../context-management"

const mockedManageContext = vi.mocked(manageContext)
const mockedWillManageContext = vi.mocked(willManageContext)

function makeApi() {
	return {
		getModel: () => ({ id: "test-model", info: { contextWindow: 100000, supportsPromptCache: false } }),
		countTokens: vi.fn(async () => 10),
	} as never
}

function makeDeps(history: unknown[], api: ReturnType<typeof makeApi>) {
	return {
		getCurrentProfileId: vi.fn(() => "profile1"),
		postCondenseTaskContext: vi.fn(async () => {}),
		buildTools: vi.fn(async () => ({ tools: [] })),
		getEnvironmentDetails: vi.fn(async () => "env-details"),
		getFilesReadByAgentSafely: vi.fn(async () => []),
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

const state = { mode: "code" } as never

beforeEach(() => {
	vi.clearAllMocks()
})

describe("applyInRequestContextManagement", () => {
	it("threshold 未満なら in-progress を出さず、env/files も取らない", async () => {
		const history = [{ role: "user", content: "hi" }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(false)
		mockedManageContext.mockResolvedValue({ messages: history } as never)

		await applyInRequestContextManagement(deps, state, api, 500, "sys")

		expect((deps as any).postCondenseTaskContext).not.toHaveBeenCalled()
		expect((deps as any).getEnvironmentDetails).not.toHaveBeenCalled()
		expect((deps as any).getFilesReadByAgentSafely).not.toHaveBeenCalled()
		expect(mockedManageContext).toHaveBeenCalledWith(
			expect.objectContaining({ environmentDetails: undefined, filesReadByAgent: undefined }),
		)
		expect((deps as any).say).not.toHaveBeenCalled()
	})

	it("threshold 到達で started→complete を出し、env を取得する", async () => {
		const history = [{ role: "user", content: "hi" }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(true)
		mockedManageContext.mockResolvedValue({ messages: history } as never)

		await applyInRequestContextManagement(deps, state, api, 90000, "sys")

		expect((deps as any).postCondenseTaskContext).toHaveBeenNthCalledWith(1, true)
		expect((deps as any).postCondenseTaskContext).toHaveBeenNthCalledWith(2, false)
		expect((deps as any).getEnvironmentDetails).toHaveBeenCalledWith(true)
	})

	it("要約が返れば履歴を差し替え condense_context を流す", async () => {
		const history = [{ role: "user", content: "hi" }]
		const newHistory = [{ role: "user", content: "summarized" }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(true)
		mockedManageContext.mockResolvedValue({
			messages: newHistory,
			summary: "sum",
			cost: 0.1,
			prevContextTokens: 100,
			newContextTokens: 40,
			condenseId: "c1",
		} as never)

		await applyInRequestContextManagement(deps, state, api, 90000, "sys")

		expect((deps as any).overwriteApiConversationHistory).toHaveBeenCalledWith(newHistory)
		expect((deps as any).say).toHaveBeenCalledWith(
			"condense_context",
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
			expect.objectContaining({ summary: "sum", condenseId: "c1" }),
		)
	})

	it("切り詰めが起きたら sliding_window_truncation を流す", async () => {
		const history = [{ role: "user", content: "hi" }]
		const newHistory = [{ role: "user", content: "trimmed" }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(true)
		mockedManageContext.mockResolvedValue({
			messages: newHistory,
			truncationId: "tr1",
			messagesRemoved: 2,
			prevContextTokens: 100,
			newContextTokensAfterTruncation: 40,
		} as never)

		await applyInRequestContextManagement(deps, state, api, 90000, "sys")

		expect((deps as any).say).toHaveBeenCalledWith(
			"sliding_window_truncation",
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
			undefined,
			expect.objectContaining({ truncationId: "tr1", messagesRemoved: 2 }),
		)
	})

	it("要約エラーは condense_context_error を出すが履歴は差し替えない", async () => {
		const history = [{ role: "user", content: "hi" }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(true)
		mockedManageContext.mockResolvedValue({ messages: history, error: "boom" } as never)

		await applyInRequestContextManagement(deps, state, api, 90000, "sys")

		expect((deps as any).say).toHaveBeenCalledWith("condense_context_error", "boom")
		expect((deps as any).overwriteApiConversationHistory).not.toHaveBeenCalled()
	})

	it("state が undefined でも既定にフォールバックする（state ?? {}）", async () => {
		const history = [{ role: "user", content: "hi" }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(false)
		mockedManageContext.mockResolvedValue({ messages: history } as never)

		await applyInRequestContextManagement(deps, undefined, api, 500, "sys")

		expect(mockedManageContext).toHaveBeenCalledWith(
			expect.objectContaining({
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				profileThresholds: {},
			}),
		)
	})

	it("customSupportPrompts.CONDENSE があれば manageContext に渡す", async () => {
		const history = [{ role: "user", content: "hi" }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(true)
		mockedManageContext.mockResolvedValue({ messages: history } as never)

		await applyInRequestContextManagement(
			deps,
			{ mode: "code", customSupportPrompts: { CONDENSE: "cp" } } as never,
			api,
			90000,
			"sys",
		)

		expect(mockedManageContext).toHaveBeenCalledWith(expect.objectContaining({ customCondensingPrompt: "cp" }))
	})

	it("末尾メッセージに本文があれば countTokens で lastMessageTokens を数える", async () => {
		// itemText が非空を返す末尾 item を置き、`if (lastMessageText)` の true 側を踏む。
		const history = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi there" }] }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(false)
		mockedManageContext.mockResolvedValue({ messages: history } as never)

		await applyInRequestContextManagement(deps, state, api, 500, "sys")

		expect((api as any).countTokens).toHaveBeenCalledWith([{ type: "text", text: "hi there" }])
	})

	it("messagesRemoved / newContextTokensAfterTruncation 未指定でも 0 で流す（?? 0）", async () => {
		const history = [{ role: "user", content: "hi" }]
		const newHistory = [{ role: "user", content: "trimmed" }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(true)
		mockedManageContext.mockResolvedValue({
			messages: newHistory,
			truncationId: "tr2",
			prevContextTokens: 100,
		} as never)

		await applyInRequestContextManagement(deps, state, api, 90000, "sys")

		expect((deps as any).say).toHaveBeenCalledWith(
			"sliding_window_truncation",
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			{ isNonInteractive: true },
			undefined,
			expect.objectContaining({ truncationId: "tr2", messagesRemoved: 0, newContextTokens: 0 }),
		)
	})

	it("manageContext が投げても finally で in-progress を必ず畳む", async () => {
		const history = [{ role: "user", content: "hi" }]
		const api = makeApi()
		const deps = makeDeps(history, api)
		mockedWillManageContext.mockReturnValue(true)
		mockedManageContext.mockRejectedValue(new Error("kaboom"))

		await expect(applyInRequestContextManagement(deps, state, api, 90000, "sys")).rejects.toThrow("kaboom")

		expect((deps as any).postCondenseTaskContext).toHaveBeenNthCalledWith(2, false)
	})
})
