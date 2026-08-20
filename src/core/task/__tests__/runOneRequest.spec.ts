import { describe, it, expect, vi, beforeEach } from "vitest"

import { runOneRequest } from "../runOneRequest"

vi.mock("../resetStreamingStateForNewApiRequest", () => ({ resetStreamingStateForNewApiRequest: vi.fn() }))
vi.mock("../makeStreamClosures", () => ({ makeStreamClosures: vi.fn() }))
vi.mock("../runOneApiIteration", () => ({ runOneApiIteration: vi.fn() }))

import { resetStreamingStateForNewApiRequest } from "../resetStreamingStateForNewApiRequest"
import { makeStreamClosures } from "../makeStreamClosures"
import { runOneApiIteration } from "../runOneApiIteration"

const mockedReset = vi.mocked(resetStreamingStateForNewApiRequest)
const mockedClosures = vi.mocked(makeStreamClosures)
const mockedIteration = vi.mocked(runOneApiIteration)

const modelInfo = { info: { contextWindow: 200_000 }, id: "some-model" }

function makeHost() {
	return {
		api: { getModel: vi.fn(() => modelInfo) },
		stream: {},
		say: vi.fn(),
		ask: vi.fn(),
		updateClineMessage: vi.fn(),
		saveClineMessages: vi.fn(),
		addToApiConversationHistory: vi.fn(),
		pushToolResultToUserContent: vi.fn(),
		backoffAndAnnounce: vi.fn(),
		abortTask: vi.fn(),
		postStateToWebviewWithoutTaskHistory: vi.fn(),
		providerRef: { deref: () => ({ getState: vi.fn() }) },
		attemptApiRequest: vi.fn(() => "STREAM"),
	}
}

const input = {
	lastApiReqIndex: 7,
	currentUserContent: [{ type: "text", text: "hi" }] as never,
	currentRetryAttempt: 2,
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedReset.mockResolvedValue(undefined as never)
	mockedClosures.mockReturnValue({ updateApiReqMsg: vi.fn(), abortStream: vi.fn() } as never)
	mockedIteration.mockResolvedValue({ action: "break" } as never)
})

describe("runOneRequest", () => {
	it("streaming state をリセットし、model info を stream にキャッシュする", async () => {
		const host = makeHost()

		await runOneRequest({ host, presentAssistantMessage: vi.fn() } as never, input)

		expect(mockedReset).toHaveBeenCalledWith(host)
		expect(host.api.getModel).toHaveBeenCalledTimes(1)
		expect((host.stream as any).cachedStreamingModel).toBe(modelInfo)
	})

	it("makeStreamClosures に model info と初期化済み token accumulator を渡す", async () => {
		const host = makeHost()

		await runOneRequest({ host, presentAssistantMessage: vi.fn() } as never, input)

		const [passedHost, opts] = mockedClosures.mock.calls[0] as [unknown, any]
		expect(passedHost).toBe(host)
		expect(opts.lastApiReqIndex).toBe(7)
		expect(opts.streamModelInfo).toBe(modelInfo.info)
		expect(opts.getTokens()).toEqual({
			input: 0,
			output: 0,
			cacheWrite: 0,
			cacheRead: 0,
			total: undefined,
		})
	})

	it("attemptApiRequest を skipProviderRateLimit=true・現 retry で呼び、その stream を iteration に渡す", async () => {
		const host = makeHost()

		await runOneRequest({ host, presentAssistantMessage: vi.fn() } as never, input)

		expect(host.attemptApiRequest).toHaveBeenCalledWith(2, { skipProviderRateLimit: true })
		const iterationInput = mockedIteration.mock.calls[0][1] as any
		expect(iterationInput.stream).toBe("STREAM")
		expect(iterationInput.lastApiReqIndex).toBe(7)
		expect(iterationInput.currentUserContent).toBe(input.currentUserContent)
		expect(iterationInput.currentRetryAttempt).toBe(2)
	})

	it("runOneApiIteration の結果をそのまま返す", async () => {
		mockedIteration.mockResolvedValue({ action: "continue", nextStackItem: { retryAttempt: 3 } } as never)

		const result = await runOneRequest({ host: makeHost(), presentAssistantMessage: vi.fn() } as never, input)

		expect(result).toEqual({ action: "continue", nextStackItem: { retryAttempt: 3 } })
	})

	it("同じ token accumulator が closures と iteration の双方へ共有される", async () => {
		await runOneRequest({ host: makeHost(), presentAssistantMessage: vi.fn() } as never, input)

		const closuresTokens = (mockedClosures.mock.calls[0][1] as any).getTokens()
		const iterationTokens = (mockedIteration.mock.calls[0][1] as any).tokens
		expect(closuresTokens).toBe(iterationTokens)
	})

	it("iteration へ渡す getProviderState は providerRef 経由で state を引く", async () => {
		const host = makeHost()
		const getState = vi.fn(async () => ({ autoApprovalEnabled: true }))
		host.providerRef = { deref: () => ({ getState }) }

		await runOneRequest({ host, presentAssistantMessage: vi.fn() } as never, input)

		const iterationDeps = mockedIteration.mock.calls[0][0] as any
		await expect(iterationDeps.getProviderState()).resolves.toEqual({ autoApprovalEnabled: true })
		expect(getState).toHaveBeenCalledTimes(1)
	})
})
