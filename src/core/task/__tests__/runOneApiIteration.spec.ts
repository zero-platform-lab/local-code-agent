import { describe, it, expect, vi, beforeEach } from "vitest"

import { runOneApiIteration } from "../runOneApiIteration"

vi.mock("../runStreamingLoop", () => ({ runStreamingLoop: vi.fn() }))
vi.mock("../handleMidStreamError", () => ({ handleMidStreamError: vi.fn() }))
vi.mock("../finalizeStreamCompletion", () => ({ finalizeStreamCompletion: vi.fn() }))
vi.mock("../processAssistantContentBranch", () => ({ processAssistantContentBranch: vi.fn() }))

import { runStreamingLoop } from "../runStreamingLoop"
import { handleMidStreamError } from "../handleMidStreamError"
import { finalizeStreamCompletion } from "../finalizeStreamCompletion"
import { processAssistantContentBranch } from "../processAssistantContentBranch"

const mockedStreamingLoop = vi.mocked(runStreamingLoop)
const mockedMidStreamError = vi.mocked(handleMidStreamError)
const mockedFinalize = vi.mocked(finalizeStreamCompletion)
const mockedBranch = vi.mocked(processAssistantContentBranch)

function makeDeps(hostOverrides: Record<string, unknown> = {}) {
	const host = {
		taskId: "t1",
		instanceId: "i1",
		abort: false,
		abandoned: false,
		stream: {
			isStreaming: false,
			currentRequestAbortController: {} as unknown,
			didCompleteReadingStream: false,
		},
		...hostOverrides,
	}
	const deps = {
		host,
		presentAssistantMessage: vi.fn(),
		say: vi.fn(async () => {}),
		sayForReasoning: vi.fn(async () => {}),
		ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
		abortStream: vi.fn(async () => {}),
		updateApiReqMsg: vi.fn(),
		updateClineMessage: vi.fn(async () => {}),
		saveClineMessages: vi.fn(async () => {}),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
		addToApiConversationHistory: vi.fn(async () => {}),
		pushToolResultToUserContent: vi.fn(() => true),
		getProviderState: vi.fn(async () => ({ autoApprovalEnabled: false })),
		backoffAndAnnounce: vi.fn(async () => {}),
		abortTask: vi.fn(async () => {}),
	}
	return deps
}

const input = {
	stream: {} as never,
	tokens: {} as never,
	lastApiReqIndex: 0,
	currentUserContent: [{ type: "text", text: "hi" }] as never,
	currentRetryAttempt: 0,
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedStreamingLoop.mockResolvedValue({
		assistantMessage: "hello",
		reasoningMessage: "",
		pendingGroundingSources: [],
	} as never)
	mockedFinalize.mockResolvedValue({ partialBlocks: [] } as never)
	mockedBranch.mockResolvedValue({ action: "continue", nextStackItem: undefined } as never)
})

describe("runOneApiIteration", () => {
	it("正常系：finalize→content 分岐へ進み、ストリーム状態を後始末して continue を返す", async () => {
		const nextStackItem = { userContent: [], includeFileDetails: true }
		mockedBranch.mockResolvedValue({ action: "continue", nextStackItem } as never)
		const deps = makeDeps()

		const result = await runOneApiIteration(deps as never, input)

		expect(result).toEqual({ action: "continue", nextStackItem })
		expect(deps.host.stream.isStreaming).toBe(false)
		expect(deps.host.stream.currentRequestAbortController).toBeUndefined()
		expect(deps.host.stream.didCompleteReadingStream).toBe(true)
		expect(mockedMidStreamError).not.toHaveBeenCalled()
	})

	it("正常系でも content 分岐が break を返せば break を返す", async () => {
		mockedBranch.mockResolvedValue({ action: "break" } as never)

		const result = await runOneApiIteration(makeDeps() as never, input)

		expect(result).toEqual({ action: "break" })
	})

	it("ストリーム後に abort されていたら finalize せず throw する", async () => {
		const deps = makeDeps({ abort: true })

		await expect(runOneApiIteration(deps as never, input)).rejects.toThrow(/aborted/)
		expect(mockedFinalize).not.toHaveBeenCalled()
		// throw する前にストリーム状態は後始末されている
		expect(deps.host.stream.isStreaming).toBe(false)
	})

	it("mid-stream エラーで handleMidStreamError が break を返せば break（状態後始末あり）", async () => {
		mockedStreamingLoop.mockRejectedValue(new Error("boom"))
		mockedMidStreamError.mockResolvedValue({ action: "break" } as never)
		const deps = makeDeps()

		const result = await runOneApiIteration(deps as never, input)

		expect(result).toEqual({ action: "break" })
		expect(deps.host.stream.isStreaming).toBe(false)
		expect(deps.host.stream.currentRequestAbortController).toBeUndefined()
		expect(mockedFinalize).not.toHaveBeenCalled()
	})

	it("mid-stream エラーで continue+retryStackItem なら nextStackItem に載せて continue", async () => {
		mockedStreamingLoop.mockRejectedValue(new Error("boom"))
		const retryStackItem = { userContent: [], includeFileDetails: false, retryAttempt: 1 }
		mockedMidStreamError.mockResolvedValue({ action: "continue", retryStackItem } as never)

		const result = await runOneApiIteration(makeDeps() as never, input)

		expect(result).toEqual({ action: "continue", nextStackItem: retryStackItem })
	})

	it("mid-stream エラーで noop（abandoned / user cancel）なら abandoned を返す", async () => {
		mockedStreamingLoop.mockRejectedValue(new Error("boom"))
		mockedMidStreamError.mockResolvedValue({ action: "noop" } as never)

		const result = await runOneApiIteration(makeDeps() as never, input)

		expect(result).toEqual({ action: "abandoned" })
	})
})
