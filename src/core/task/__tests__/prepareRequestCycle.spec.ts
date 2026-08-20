import { describe, it, expect, vi, beforeEach } from "vitest"

import {
	prepareRequestCycle,
	type PrepareRequestCycleDeps,
	type PrepareRequestCycleInput,
} from "../prepareRequestCycle"

vi.mock("../prepareUserContentForRequest", () => ({ prepareUserContentForRequest: vi.fn() }))
vi.mock("../applySlashCommandModeSwitch", () => ({ applySlashCommandModeSwitch: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", () => ({ getEnvironmentDetails: vi.fn() }))
vi.mock("../persistUserMessageAndPlaceholder", () => ({ persistUserMessageAndPlaceholder: vi.fn() }))
vi.mock("../stripDuplicateEnvironmentDetails", () => ({ stripDuplicateEnvironmentDetails: vi.fn() }))

import { prepareUserContentForRequest } from "../prepareUserContentForRequest"
import { applySlashCommandModeSwitch } from "../applySlashCommandModeSwitch"
import { getEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { persistUserMessageAndPlaceholder } from "../persistUserMessageAndPlaceholder"
import { stripDuplicateEnvironmentDetails } from "../stripDuplicateEnvironmentDetails"

const mockedPrepare = vi.mocked(prepareUserContentForRequest)
const mockedApply = vi.mocked(applySlashCommandModeSwitch)
const mockedEnv = vi.mocked(getEnvironmentDetails)
const mockedPersist = vi.mocked(persistUserMessageAndPlaceholder)
const mockedStrip = vi.mocked(stripDuplicateEnvironmentDetails)

const PARSED = [{ type: "text", text: "parsed" }] as never
const STRIPPED = [{ type: "text", text: "stripped" }] as never
const PERSIST_RESULT = { lastApiReqIndex: 42 }

function makeDeps() {
	const provider = { marker: "provider" }
	const host = {
		cwd: "/repo",
		say: vi.fn((..._a: unknown[]) => Promise.resolve()),
		maybeWaitForProviderRateLimit: vi.fn((..._a: unknown[]) => Promise.resolve()),
		addToApiConversationHistory: vi.fn((..._a: unknown[]) => Promise.resolve()),
		saveClineMessages: vi.fn((..._a: unknown[]) => Promise.resolve()),
		postStateToWebviewWithoutTaskHistory: vi.fn((..._a: unknown[]) => Promise.resolve()),
	}
	const stampLastGlobalApiRequestTime = vi.fn()
	return { host, provider, stampLastGlobalApiRequestTime }
}

const input: PrepareRequestCycleInput = {
	currentUserContent: [{ type: "text", text: "hi" }] as never,
	retryAttempt: 3,
	userMessageWasRemoved: true,
	isEmptyOriginalUserContent: false,
	includeFileDetails: true,
	apiProtocol: "openai",
}

async function run(deps: ReturnType<typeof makeDeps>) {
	return prepareRequestCycle(deps as unknown as PrepareRequestCycleDeps, input)
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedPrepare.mockResolvedValue({ parsedUserContent: PARSED, slashCommandMode: "code-mode" })
	mockedStrip.mockReturnValue(STRIPPED)
	mockedEnv.mockResolvedValue("ENVDETAILS")
	mockedApply.mockResolvedValue(undefined)
	mockedPersist.mockResolvedValue(PERSIST_RESULT)
})

describe("prepareRequestCycle", () => {
	it("rate limit 待機 → stamp → 準備 collaborator 群を定義順に一度ずつ呼ぶ", async () => {
		const deps = makeDeps()

		await run(deps)

		expect(deps.host.maybeWaitForProviderRateLimit).toHaveBeenCalledTimes(1)
		expect(deps.stampLastGlobalApiRequestTime).toHaveBeenCalledTimes(1)
		expect(mockedPrepare).toHaveBeenCalledTimes(1)
		expect(mockedApply).toHaveBeenCalledTimes(1)
		expect(mockedEnv).toHaveBeenCalledTimes(1)
		expect(mockedStrip).toHaveBeenCalledTimes(1)
		expect(mockedPersist).toHaveBeenCalledTimes(1)

		const order = [
			deps.host.maybeWaitForProviderRateLimit.mock.invocationCallOrder[0],
			deps.stampLastGlobalApiRequestTime.mock.invocationCallOrder[0],
			mockedPrepare.mock.invocationCallOrder[0],
			mockedApply.mock.invocationCallOrder[0],
			mockedEnv.mock.invocationCallOrder[0],
			mockedPersist.mock.invocationCallOrder[0],
		]
		expect(order).toEqual([...order].sort((a, b) => a - b))
	})

	it("maybeWaitForProviderRateLimit に retryAttempt を渡し、その後で stamp を呼ぶ", async () => {
		const deps = makeDeps()

		await run(deps)

		expect(deps.host.maybeWaitForProviderRateLimit).toHaveBeenCalledWith(3)
		// rate limit 待機のあとに last request 時刻を stamp する順序を pin する
		expect(deps.host.maybeWaitForProviderRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
			deps.stampLastGlobalApiRequestTime.mock.invocationCallOrder[0],
		)
	})

	it("prepareUserContentForRequest に host/provider と currentUserContent/apiProtocol を渡す", async () => {
		const deps = makeDeps()

		await run(deps)

		const [prepDeps, content, protocol] = mockedPrepare.mock.calls[0]
		expect((prepDeps as { host: unknown }).host).toBe(deps.host)
		expect((prepDeps as { provider: unknown }).provider).toBe(deps.provider)
		expect(typeof (prepDeps as { say: unknown }).say).toBe("function")
		expect(content).toBe(input.currentUserContent)
		expect(protocol).toBe("openai")
	})

	it("prepareUserContentForRequest が返した slashCommandMode を provider とともに mode 切替へ渡す", async () => {
		const deps = makeDeps()

		await run(deps)

		expect(mockedApply).toHaveBeenCalledWith(deps.provider, "code-mode")
	})

	it("getEnvironmentDetails に host と includeFileDetails を渡す", async () => {
		const deps = makeDeps()

		await run(deps)

		expect(mockedEnv).toHaveBeenCalledWith(deps.host, true)
	})

	it("parsedUserContent を stripDuplicateEnvironmentDetails に通してから persist へ渡す", async () => {
		const deps = makeDeps()

		await run(deps)

		expect(mockedStrip).toHaveBeenCalledWith(PARSED)
		const persistInput = mockedPersist.mock.calls[0][1]
		expect(persistInput.contentWithoutEnvDetails).toBe(STRIPPED)
	})

	it("persist に env_details と passthrough フィールド一式を渡す", async () => {
		const deps = makeDeps()

		await run(deps)

		const [persistDeps, persistInput] = mockedPersist.mock.calls[0]
		expect((persistDeps as { host: unknown }).host).toBe(deps.host)
		expect(typeof (persistDeps as { addToApiConversationHistory: unknown }).addToApiConversationHistory).toBe(
			"function",
		)
		expect(typeof (persistDeps as { saveClineMessages: unknown }).saveClineMessages).toBe("function")
		expect(
			typeof (persistDeps as { postStateToWebviewWithoutTaskHistory: unknown })
				.postStateToWebviewWithoutTaskHistory,
		).toBe("function")

		expect(persistInput.environmentDetails).toBe("ENVDETAILS")
		expect(persistInput.retryAttempt).toBe(3)
		expect(persistInput.userMessageWasRemoved).toBe(true)
		expect(persistInput.isEmptyOriginalUserContent).toBe(false)
		expect(persistInput.apiProtocol).toBe("openai")
	})

	it("persistUserMessageAndPlaceholder の結果（lastApiReqIndex）をそのまま返す", async () => {
		const deps = makeDeps()

		const result = await run(deps)

		expect(result).toBe(PERSIST_RESULT)
	})
})
