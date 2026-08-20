// npx vitest run core/task/__tests__/attemptApiRequest.spec.ts
//
// attemptApiRequest generator の streaming 本体（AbortController 準備 → first-chunk
// レース → yield* iterator、および first-chunk エラーのリトライ/中断）を検証する。
// buildRequestHistory / context 管理 / context-error 判定はモックし、generator の
// 制御フローだけに絞る。

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../buildRequestHistory", () => ({ buildRequestHistory: vi.fn(() => []) }))
vi.mock("../../context-management", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../context-management")>()),
	manageContext: vi.fn(),
	willManageContext: vi.fn(() => false),
}))
vi.mock("../../../shared/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../shared/api")>()),
	getModelMaxOutputTokens: vi.fn(() => 8192),
}))
vi.mock("../../context/context-management/context-error-handling", () => ({
	checkContextWindowExceededError: vi.fn(() => false),
}))

import { attemptApiRequest } from "../apiRequestOrchestrator"
import { manageContext } from "../../context-management"

const mockedManageContext = vi.mocked(manageContext)

/** 完了する async iterable（chunks を順に yield し、その後 done）。 */
function successStream(chunks: unknown[]) {
	let i = 0
	const it = {
		next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
		[Symbol.asyncIterator]() {
			return this
		},
	}
	return { [Symbol.asyncIterator]: () => it }
}

/** next() が同期的に controller.abort() してから never-resolve を返す。 */
function syncAbortStream(deps: any) {
	const it = {
		next: () => {
			deps.host.stream.currentRequestAbortController?.abort()
			return new Promise(() => {})
		},
		[Symbol.asyncIterator]() {
			return this
		},
	}
	return { [Symbol.asyncIterator]: () => it }
}

/** next() が microtask で controller.abort() する（レース設定後に abort が届くケース）。 */
function microtaskAbortStream(deps: any) {
	const it = {
		next: () => {
			Promise.resolve().then(() => deps.host.stream.currentRequestAbortController?.abort())
			return new Promise(() => {})
		},
		[Symbol.asyncIterator]() {
			return this
		},
	}
	return { [Symbol.asyncIterator]: () => it }
}

function makeDeps(opts: any = {}) {
	const api = {
		getModel: () => ({ id: "m", info: { contextWindow: 100000 } }),
		countTokens: vi.fn(async () => 5),
		createMessage: vi.fn(() => successStream([])),
	}
	const host = {
		api,
		apiConfiguration: {},
		taskId: "t1",
		instanceId: "i1",
		abort: false,
		cwd: "/cwd",
		rooIgnoreController: undefined,
		messageStore: { apiConversationHistory: [], clineMessages: [{}, {}] },
		autoApprovalHandler: {
			checkAutoApprovalLimits: vi.fn(async () => ({ shouldProceed: opts.shouldProceed ?? true })),
		},
		stream: {
			isWaitingForFirstChunk: false,
			currentRequestAbortController: undefined as AbortController | undefined,
		},
	}
	return {
		host,
		getProviderState: vi.fn(async () =>
			"state" in opts ? opts.state : { autoApprovalEnabled: true, mode: "code" },
		),
		maybeWaitForProviderRateLimit: vi.fn(async () => {}),
		stampLastGlobalApiRequestTime: vi.fn(),
		log: vi.fn(),
		getSystemPrompt: vi.fn(async () => "SYS"),
		getTokenUsage: vi.fn(() => ({ contextTokens: opts.contextTokens ?? 0 })),
		getCurrentProfileId: vi.fn(() => "p1"),
		buildTools: vi.fn(async () => ({ tools: opts.tools ?? [] })),
		getEnvironmentDetails: vi.fn(async () => "env"),
		getFilesReadByAgentSafely: vi.fn(async () => []),
		overwriteApiConversationHistory: vi.fn(async () => {}),
		combineMessages: vi.fn((m: unknown) => m),
		backoffAndAnnounce: vi.fn(async () => {}),
		ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
		say: vi.fn(async () => {}),
		processQueuedMessages: vi.fn(),
		postCondenseTaskContext: vi.fn(async () => {}),
	} as any
}

async function drain(gen: AsyncIterable<unknown>) {
	const out: unknown[] = []
	for await (const c of gen) out.push(c)
	return out
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("attemptApiRequest (streaming 本体)", () => {
	it("state 無し・tools あり: first chunk を yield し残りも流し切る", async () => {
		const deps = makeDeps({ state: undefined, tools: [{ type: "function", function: { name: "x" } }] })
		deps.host.api.createMessage = vi.fn(() =>
			successStream([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		)

		const chunks = await drain(attemptApiRequest(deps))

		expect(chunks).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		])
		// tools ありなので metadata に tools/tool_choice を載せて createMessage を呼ぶ
		const meta = deps.host.api.createMessage.mock.calls[0][2]
		expect(meta).toMatchObject({ tool_choice: "auto", parallelToolCalls: true })
		expect(meta.tools).toHaveLength(1)
	})

	it("contextTokens があれば in-request context 管理を走らせてから streaming する", async () => {
		const deps = makeDeps({ contextTokens: 5000 })
		mockedManageContext.mockResolvedValue({ messages: deps.host.messageStore.apiConversationHistory } as never)
		deps.host.api.createMessage = vi.fn(() => successStream([{ type: "text", text: "z" }]))

		const chunks = await drain(attemptApiRequest(deps))

		expect(mockedManageContext).toHaveBeenCalled()
		expect(chunks).toEqual([{ type: "text", text: "z" }])
	})

	it("auto-approval 上限で shouldProceed=false なら throw する（streaming に入らない）", async () => {
		const deps = makeDeps({ shouldProceed: false })

		await expect(drain(attemptApiRequest(deps))).rejects.toThrow("Auto-approval limit reached")
		expect(deps.host.api.createMessage).not.toHaveBeenCalled()
	})

	it("first chunk 待ちの前に既に abort 済みなら即キャンセルして中断へ落ちる", async () => {
		const deps = makeDeps()
		deps.host.api.createMessage = vi.fn(() => syncAbortStream(deps))
		deps.backoffAndAnnounce = vi.fn(async () => {
			deps.host.abort = true // countdown 中に中断された状況
		})

		await expect(drain(attemptApiRequest(deps))).rejects.toThrow("aborted during retry")
	})

	it("レース設定後に abort が届いてもキャンセルして中断へ落ちる", async () => {
		const deps = makeDeps()
		deps.host.api.createMessage = vi.fn(() => microtaskAbortStream(deps))
		deps.backoffAndAnnounce = vi.fn(async () => {
			deps.host.abort = true
		})

		await expect(drain(attemptApiRequest(deps))).rejects.toThrow("aborted during retry")
	})

	it("first chunk エラーは handleFirstChunkError 経由で自己再帰リトライする", async () => {
		const deps = makeDeps()
		let call = 0
		deps.host.api.createMessage = vi.fn(() => {
			call++
			if (call === 1) {
				const it = {
					next: async () => {
						throw new Error("net")
					},
					[Symbol.asyncIterator]() {
						return this
					},
				}
				return { [Symbol.asyncIterator]: () => it }
			}
			return successStream([{ type: "text", text: "ok" }])
		})

		const chunks = await drain(attemptApiRequest(deps))

		expect(deps.host.api.createMessage).toHaveBeenCalledTimes(2)
		expect(deps.backoffAndAnnounce).toHaveBeenCalledWith(0, expect.any(Error))
		expect(chunks).toEqual([{ type: "text", text: "ok" }])
	})
})
