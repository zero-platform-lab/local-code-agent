import { describe, it, expect, vi, beforeEach } from "vitest"

import { AgentEventName, type ClineMessage } from "@openai-agent/types"

import { runAskFlow } from "../runAskFlow"

vi.mock("../../auto-approval", () => ({ checkAutoApproval: vi.fn() }))
vi.mock("../upsertAskMessage", () => ({ upsertAskMessage: vi.fn() }))
vi.mock("../applyAutoApprovalDecision", () => ({ applyAutoApprovalDecision: vi.fn() }))
vi.mock("../scheduleAskStatusMutation", () => ({ scheduleAskStatusMutation: vi.fn() }))
vi.mock("../drainQueuedMessageForAsk", () => ({ drainQueuedMessageForAsk: vi.fn() }))
vi.mock("../awaitAskResponseAndFinalize", () => ({ awaitAskResponseAndFinalize: vi.fn() }))

import { checkAutoApproval } from "../../auto-approval"
import { upsertAskMessage } from "../upsertAskMessage"
import { applyAutoApprovalDecision } from "../applyAutoApprovalDecision"
import { scheduleAskStatusMutation, type ScheduleAskStatusMutationHost } from "../scheduleAskStatusMutation"
import { drainQueuedMessageForAsk } from "../drainQueuedMessageForAsk"
import { awaitAskResponseAndFinalize } from "../awaitAskResponseAndFinalize"

const mockedCheck = vi.mocked(checkAutoApproval)
const mockedUpsert = vi.mocked(upsertAskMessage)
const mockedApply = vi.mocked(applyAutoApprovalDecision)
const mockedSchedule = vi.mocked(scheduleAskStatusMutation)
const mockedDrain = vi.mocked(drainQueuedMessageForAsk)
const mockedAwait = vi.mocked(awaitAskResponseAndFinalize)

const ASK_TS = 1000
const STATE = { autoApprovalEnabled: true }
const fakeTimeoutA = { tag: "A" } as unknown as NodeJS.Timeout
const fakeTimeoutB = { tag: "B" } as unknown as NodeJS.Timeout

// isStatusMutable=true の分岐で runAskFlow が組み立てた schedule 用 deps closure を
// 実際に叩き、setInteractiveAsk / emit / postMessageToWebview の配線を検証する。
function exerciseScheduleDeps(deps: ScheduleAskStatusMutationHost) {
	const msg = { ts: ASK_TS } as unknown as ClineMessage
	deps.findMessageByTimestamp(ASK_TS)
	deps.setInteractiveAsk(msg)
	deps.setResumableAsk(msg)
	deps.setIdleAsk(msg)
	deps.emit(AgentEventName.TaskInteractive, deps.taskId)
	deps.postMessageToWebview({ type: "interactionRequired" })
}

function makeHost() {
	const provider = {
		getState: vi.fn(async () => STATE),
		postMessageToWebview: vi.fn(),
	}
	const askState = {
		lastMessageTs: undefined as number | undefined,
		askResponse: undefined as string | undefined,
		interactiveAsk: undefined as unknown,
		resumableAsk: undefined as unknown,
		idleAsk: undefined as unknown,
		resetResponse: vi.fn(),
	}
	const host = {
		abort: false,
		taskId: "task-1",
		instanceId: "inst-1",
		messageStore: { clineMessages: [] as unknown[] },
		askState,
		providerRef: { deref: vi.fn((): typeof provider | undefined => provider) },
		addToClineMessages: vi.fn(async () => {}),
		saveClineMessages: vi.fn(async () => {}),
		updateClineMessage: vi.fn(),
		findMessageByTimestamp: vi.fn(),
		emit: vi.fn(),
		messageQueueService: { isEmpty: vi.fn(() => true) },
	}
	return { host, provider, askState }
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedUpsert.mockImplementation(async (deps) => {
		// upsert が本来行う lastMessageTs 更新 / askResponse リセットの closure を叩く
		deps.setLastMessageTs(ASK_TS)
		deps.resetAskResponse()
		return { askTs: ASK_TS }
	})
	mockedCheck.mockResolvedValue({ decision: "ask" })
	mockedApply.mockReturnValue(undefined)
	mockedSchedule.mockReturnValue(undefined)
	mockedDrain.mockReturnValue(undefined)
	mockedAwait.mockResolvedValue({ response: "yesButtonClicked" })
})

describe("runAskFlow", () => {
	it("abort が true なら例外を投げ、upsert に到達しない", async () => {
		const { host } = makeHost()
		host.abort = true

		await expect(runAskFlow({ host } as never, "followup", "hi", undefined, undefined, undefined)).rejects.toThrow(
			"aborted",
		)
		expect(mockedUpsert).not.toHaveBeenCalled()
	})

	it("provider あり・decision=ask で isStatusMutable：apply と schedule の timeout を積んで finalize に渡す", async () => {
		const { host, provider } = makeHost()
		mockedApply.mockReturnValue(fakeTimeoutA)
		mockedSchedule.mockImplementation((deps) => {
			exerciseScheduleDeps(deps)
			return fakeTimeoutB
		})

		const result = await runAskFlow({ host } as never, "followup", "hi", undefined, undefined, undefined)

		expect(mockedApply).toHaveBeenCalledWith(host, { decision: "ask" })
		expect(mockedCheck).toHaveBeenCalledWith({ state: STATE, ask: "followup", text: "hi", isProtected: undefined })
		expect(mockedSchedule).toHaveBeenCalledWith(expect.anything(), "followup", ASK_TS)
		expect(mockedDrain).not.toHaveBeenCalled()
		// schedule deps closure の配線: interactive/emit/webview が host / provider に伝播する
		expect(host.emit).toHaveBeenCalledWith(AgentEventName.TaskInteractive, "task-1")
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "interactionRequired" })
		expect(host.askState.interactiveAsk).toEqual({ ts: ASK_TS })
		// apply / schedule の両 timeout が timeouts に積まれた状態で finalize が呼ばれる
		expect(mockedAwait).toHaveBeenCalledWith(host, {
			askTs: ASK_TS,
			timeouts: [fakeTimeoutA, fakeTimeoutB],
			type: "followup",
			shouldDrainQueuedMessageForAsk: true,
		})
		expect(result).toEqual({ response: "yesButtonClicked" })
	})

	it("provider が deref undefined：state 無しで checkAutoApproval を呼び、postMessageToWebview は no-op（例外にしない）", async () => {
		const { host, provider } = makeHost()
		host.providerRef.deref = vi.fn(() => undefined)
		mockedSchedule.mockImplementation((deps) => {
			exerciseScheduleDeps(deps)
			return undefined
		})

		const result = await runAskFlow({ host } as never, "followup", "hi", undefined, undefined, undefined)

		expect(provider.getState).not.toHaveBeenCalled()
		expect(mockedCheck).toHaveBeenCalledWith(expect.objectContaining({ state: undefined, ask: "followup" }))
		// apply/schedule とも timeout を返さないので timeouts は空のまま finalize
		expect(mockedAwait).toHaveBeenCalledWith(host, expect.objectContaining({ timeouts: [] }))
		expect(result).toEqual({ response: "yesButtonClicked" })
	})

	it("partial=true：isStatusMutable false、queue 空なので schedule も drain も呼ばない", async () => {
		const { host } = makeHost()

		await runAskFlow({ host } as never, "followup", "hi", true, undefined, undefined)

		expect(mockedSchedule).not.toHaveBeenCalled()
		expect(mockedDrain).not.toHaveBeenCalled()
		expect(mockedAwait).toHaveBeenCalledWith(
			host,
			expect.objectContaining({ shouldDrainQueuedMessageForAsk: true }),
		)
	})

	it("queue 非空・command_output 以外：drainQueuedMessageForAsk で queue を消化し schedule はしない", async () => {
		const { host } = makeHost()
		host.messageQueueService.isEmpty = vi.fn(() => false)

		await runAskFlow({ host } as never, "followup", "hi", undefined, undefined, undefined)

		expect(mockedDrain).toHaveBeenCalledWith(host, "followup")
		expect(mockedSchedule).not.toHaveBeenCalled()
		expect(mockedAwait).toHaveBeenCalledWith(
			host,
			expect.objectContaining({ shouldDrainQueuedMessageForAsk: true }),
		)
	})

	it("command_output は terminal flow-control：queue 非空でも drain せず schedule もしない", async () => {
		const { host } = makeHost()
		host.messageQueueService.isEmpty = vi.fn(() => false)

		await runAskFlow({ host } as never, "command_output", "out", undefined, undefined, undefined)

		expect(mockedDrain).not.toHaveBeenCalled()
		expect(mockedSchedule).not.toHaveBeenCalled()
		expect(mockedAwait).toHaveBeenCalledWith(
			host,
			expect.objectContaining({ shouldDrainQueuedMessageForAsk: false, type: "command_output" }),
		)
	})

	it("decision が ask 以外（approve）：isStatusMutable false で schedule も drain もしない", async () => {
		const { host } = makeHost()
		mockedCheck.mockResolvedValue({ decision: "approve" })

		await runAskFlow({ host } as never, "followup", "hi", undefined, undefined, undefined)

		expect(mockedSchedule).not.toHaveBeenCalled()
		expect(mockedDrain).not.toHaveBeenCalled()
	})

	it("askResponse が既にある：isBlocking false で isStatusMutable false", async () => {
		const { host } = makeHost()
		host.askState.askResponse = "messageResponse"

		await runAskFlow({ host } as never, "followup", "hi", undefined, undefined, undefined)

		expect(mockedSchedule).not.toHaveBeenCalled()
		expect(mockedDrain).not.toHaveBeenCalled()
	})

	it("lastMessageTs が askTs と不一致：isBlocking false（superseded 相当）で isStatusMutable false", async () => {
		const { host } = makeHost()
		mockedUpsert.mockImplementationOnce(async (deps) => {
			deps.setLastMessageTs(111)
			deps.resetAskResponse()
			return { askTs: 222 }
		})

		await runAskFlow({ host } as never, "followup", "hi", undefined, undefined, undefined)

		expect(mockedSchedule).not.toHaveBeenCalled()
		expect(mockedDrain).not.toHaveBeenCalled()
	})
})
