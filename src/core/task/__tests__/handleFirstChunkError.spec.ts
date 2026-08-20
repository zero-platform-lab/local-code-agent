import { describe, it, expect, vi, beforeEach } from "vitest"

import { handleFirstChunkError } from "../apiRequestOrchestrator"

vi.mock("../../context-management", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../context-management")>()),
	manageContext: vi.fn(),
	willManageContext: vi.fn(),
}))
vi.mock("../../../shared/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../shared/api")>()),
	getModelMaxOutputTokens: vi.fn(() => 8192),
}))
vi.mock("../../context/context-management/context-error-handling", () => ({
	checkContextWindowExceededError: vi.fn(),
}))

import { manageContext } from "../../context-management"
import { checkContextWindowExceededError } from "../../context/context-management/context-error-handling"

const mockedManageContext = vi.mocked(manageContext)
const mockedCheckContextWindow = vi.mocked(checkContextWindowExceededError)

function makeDeps(overrides: { abort?: boolean; askResponse?: string } = {}) {
	const history = [{ role: "user", content: "hi" }]
	return {
		getProviderState: vi.fn(async () => ({}) as never),
		getTokenUsage: vi.fn(() => ({ contextTokens: 1000 })),
		getCurrentProfileId: vi.fn(() => "profile1"),
		getSystemPrompt: vi.fn(async () => "sys"),
		getEnvironmentDetails: vi.fn(async () => "env"),
		buildTools: vi.fn(async () => ({ tools: [] })),
		postCondenseTaskContext: vi.fn(async () => {}),
		overwriteApiConversationHistory: vi.fn(async () => {}),
		backoffAndAnnounce: vi.fn(async () => {}),
		log: vi.fn(),
		ask: vi.fn(async () => ({ response: overrides.askResponse ?? "yesButtonClicked" })),
		say: vi.fn(async () => {}),
		host: {
			api: { getModel: () => ({ id: "m", info: { contextWindow: 100000 } }) },
			apiConfiguration: {},
			taskId: "task-1",
			instanceId: "inst-1",
			abort: overrides.abort ?? false,
			cwd: "/cwd",
			rooIgnoreController: undefined,
			messageStore: { apiConversationHistory: history },
			stream: { isWaitingForFirstChunk: true, currentRequestAbortController: {} },
		},
	} as never
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedManageContext.mockResolvedValue({ messages: [] } as never)
})

describe("handleFirstChunkError", () => {
	it("先頭で first-chunk 待ちフラグと abort controller を必ずリセットする", async () => {
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps()

		await handleFirstChunkError(deps, new Error("x"), 0, true)

		expect((deps as any).host.stream.isWaitingForFirstChunk).toBe(false)
		expect((deps as any).host.stream.currentRequestAbortController).toBeUndefined()
	})

	it("コンテキスト超過かつ上限未満なら切り詰めて retryAttempt+1 を返す", async () => {
		mockedCheckContextWindow.mockReturnValue(true)
		const deps = makeDeps()

		const result = await handleFirstChunkError(deps, new Error("ctx"), 1, false)

		expect(result).toEqual({ nextRetryAttempt: 2 })
		expect(mockedManageContext).toHaveBeenCalled() // handleContextWindowExceededError 経由の切り詰め
	})

	it("コンテキスト超過でも上限到達なら自動承認バックオフ側へ落ちる", async () => {
		mockedCheckContextWindow.mockReturnValue(true)
		const deps = makeDeps()

		const result = await handleFirstChunkError(deps, new Error("ctx"), 3, true)

		expect((deps as any).backoffAndAnnounce).toHaveBeenCalledWith(3, expect.any(Error))
		expect(result).toEqual({ nextRetryAttempt: 4 })
	})

	it("タイムアウトはリトライせず終端エラーとして再スローする（自動承認でも）", async () => {
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps()
		const timeoutErr = new Error("OpenAI completion error: request timed out after 30000ms\n[sent] model=x")

		// autoApproval=true でも backoff/リトライに入らず throw する。
		await expect(handleFirstChunkError(deps, timeoutErr, 0, true)).rejects.toBe(timeoutErr)
		expect((deps as any).backoffAndAnnounce).not.toHaveBeenCalled()
	})

	it("HTTP 400 はリトライせず終端エラーとして再スローする（自動承認でも）", async () => {
		// サーバは一瞬で 400 を返すのに、無限リトライすると「無音ハング」に化ける。
		// 4xx（クライアントエラー）は終端化して即表面化させる。
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps()
		const err = Object.assign(new Error("Bad Request\n[sent] reasoning_effort=medium, tools=5"), { status: 400 })

		await expect(handleFirstChunkError(deps, err, 0, true)).rejects.toBe(err)
		expect((deps as any).backoffAndAnnounce).not.toHaveBeenCalled()
	})

	it("HTTP 429（レート制限）はリトライ対象に残す（自動承認）", async () => {
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps()
		const err = Object.assign(new Error("Too Many Requests"), { status: 429 })

		const result = await handleFirstChunkError(deps, err, 1, true)

		expect((deps as any).backoffAndAnnounce).toHaveBeenCalledWith(1, err)
		expect(result).toEqual({ nextRetryAttempt: 2 })
	})

	it("HTTP 500（サーバエラー）はリトライする（自動承認）", async () => {
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps()
		const err = Object.assign(new Error("Server Error"), { status: 500 })

		const result = await handleFirstChunkError(deps, err, 0, true)

		expect((deps as any).backoffAndAnnounce).toHaveBeenCalled()
		expect(result).toEqual({ nextRetryAttempt: 1 })
	})

	it("コンテキスト超過は 4xx でも専用処理（切り詰め）に回りリトライする", async () => {
		mockedCheckContextWindow.mockReturnValue(true)
		const deps = makeDeps()
		const err = Object.assign(new Error("context length exceeded"), { status: 400 })

		const result = await handleFirstChunkError(deps, err, 0, false)

		expect(result).toEqual({ nextRetryAttempt: 1 })
		expect(mockedManageContext).toHaveBeenCalled() // 終端化せず切り詰めた
	})

	it("自動承認あり・中断なしはバックオフ後 retryAttempt+1 を返す", async () => {
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps()

		const result = await handleFirstChunkError(deps, new Error("x"), 2, true)

		expect((deps as any).backoffAndAnnounce).toHaveBeenCalledWith(2, expect.any(Error))
		expect(result).toEqual({ nextRetryAttempt: 3 })
	})

	it("自動承認あり・バックオフ中に中断されたら throw する", async () => {
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps({ abort: true })

		await expect(handleFirstChunkError(deps, new Error("x"), 0, true)).rejects.toThrow("aborted during retry")
	})

	it("自動承認なし・ユーザー承認なら retry をリセット(0)して再試行する", async () => {
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps({ askResponse: "yesButtonClicked" })

		const result = await handleFirstChunkError(deps, new Error("x"), 5, false)

		expect((deps as any).say).toHaveBeenCalledWith("api_req_retried")
		expect(result).toEqual({ nextRetryAttempt: 0 })
	})

	it("自動承認なし・message の無いエラーは serializeError を JSON 化して ask する（?? 右側）", async () => {
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps({ askResponse: "yesButtonClicked" })

		// message を持たないエラー（プレーンオブジェクト）→ `err.message ?? JSON.stringify(...)` の右側
		const result = await handleFirstChunkError(deps, { code: "E_WEIRD" } as never, 0, false)

		expect(result).toEqual({ nextRetryAttempt: 0 })
		const askArg = (deps as any).ask.mock.calls[0][1] as string
		expect(askArg).toContain("E_WEIRD")
	})

	it("自動承認なし・ユーザー拒否なら throw する", async () => {
		mockedCheckContextWindow.mockReturnValue(false)
		const deps = makeDeps({ askResponse: "noButtonClicked" })

		await expect(handleFirstChunkError(deps, new Error("x"), 0, false)).rejects.toThrow("API request failed")
	})
})
