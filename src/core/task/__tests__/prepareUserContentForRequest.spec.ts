import { describe, it, expect, vi, beforeEach } from "vitest"

import { defaultModeSlug } from "../../../shared/modes"

vi.mock("../../mentions/processUserContentMentions", () => ({
	processUserContentMentions: vi.fn(),
}))

import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import { prepareUserContentForRequest } from "../prepareUserContentForRequest"

const mockedMentions = vi.mocked(processUserContentMentions)

interface ProviderState {
	showAgentIgnoredFiles?: boolean
	includeDiagnosticMessages?: boolean
	maxDiagnosticMessages?: number
	mode?: string
}

function makeDeps(
	opts: {
		state?: ProviderState | undefined
		withProvider?: boolean
		skills?: unknown
	} = {},
) {
	const say = vi.fn((..._a: unknown[]) => Promise.resolve())
	const getState = vi.fn((..._a: unknown[]) => Promise.resolve(opts.state))
	const getSkillsManager = vi.fn((..._a: unknown[]) => opts.skills)
	const provider = opts.withProvider === false ? undefined : { getState, getSkillsManager }
	const host = { cwd: "/repo", fileContextTracker: { tag: "fct" }, rooIgnoreController: { tag: "ignore" } }
	const deps = { host, provider, say }
	return { deps, say, getState, getSkillsManager, host }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("prepareUserContentForRequest", () => {
	it("provider あり・state 全指定：設定をそのまま mention 展開へ渡し、false/0 も既定で上書きしない", async () => {
		const skills = { lookup: "sk" }
		const { deps, say, getSkillsManager, host } = makeDeps({
			state: {
				showAgentIgnoredFiles: true,
				includeDiagnosticMessages: false,
				maxDiagnosticMessages: 0,
				mode: "architect",
			},
			skills,
		})
		mockedMentions.mockResolvedValue({ content: [{ type: "text", text: "parsed" }], mode: "code" } as never)
		const userContent = [{ type: "text", text: "hi" }]

		const result = await prepareUserContentForRequest(deps as never, userContent as never, "anthropic" as never)

		expect(say).toHaveBeenCalledWith("api_req_started", JSON.stringify({ apiProtocol: "anthropic" }))
		expect(mockedMentions).toHaveBeenCalledTimes(1)
		const arg = mockedMentions.mock.calls[0][0] as Record<string, unknown>
		expect(arg).toMatchObject({
			userContent,
			cwd: "/repo",
			fileContextTracker: host.fileContextTracker,
			rooIgnoreController: host.rooIgnoreController,
			showAgentIgnoredFiles: true,
			includeDiagnosticMessages: false,
			maxDiagnosticMessages: 0,
			currentMode: "architect",
			skillsManager: skills,
		})
		expect(getSkillsManager).toHaveBeenCalledTimes(1)
		expect(result).toEqual({ parsedUserContent: [{ type: "text", text: "parsed" }], slashCommandMode: "code" })
	})

	it("provider あり・getState が undefined：既定値（false / true / 50 / defaultModeSlug）で mention を呼ぶ", async () => {
		const { deps, getSkillsManager } = makeDeps({ state: undefined })
		mockedMentions.mockResolvedValue({ content: [], mode: undefined } as never)

		await prepareUserContentForRequest(deps as never, [] as never, "openai" as never)

		const arg = mockedMentions.mock.calls[0][0] as Record<string, unknown>
		expect(arg.showAgentIgnoredFiles).toBe(false)
		expect(arg.includeDiagnosticMessages).toBe(true)
		expect(arg.maxDiagnosticMessages).toBe(50)
		expect(arg.currentMode).toBe(defaultModeSlug)
		expect(getSkillsManager).toHaveBeenCalledTimes(1)
	})

	it("provider 無し：getState/getSkillsManager を呼ばず、既定値と skillsManager=undefined で mention を呼ぶ", async () => {
		const { deps, say } = makeDeps({ withProvider: false })
		mockedMentions.mockResolvedValue({ content: [], mode: undefined } as never)

		const result = await prepareUserContentForRequest(deps as never, [] as never, "anthropic" as never)

		expect(say).toHaveBeenCalledTimes(1)
		const arg = mockedMentions.mock.calls[0][0] as Record<string, unknown>
		expect(arg.showAgentIgnoredFiles).toBe(false)
		expect(arg.includeDiagnosticMessages).toBe(true)
		expect(arg.maxDiagnosticMessages).toBe(50)
		expect(arg.currentMode).toBe(defaultModeSlug)
		expect(arg.skillsManager).toBeUndefined()
		expect(result.slashCommandMode).toBeUndefined()
	})

	it("say('api_req_started') → getState → mention の順で実行する", async () => {
		const { deps, say, getState } = makeDeps({ state: {} })
		mockedMentions.mockResolvedValue({ content: [], mode: undefined } as never)

		await prepareUserContentForRequest(deps as never, [] as never, "anthropic" as never)

		expect(say.mock.invocationCallOrder[0]).toBeLessThan(getState.mock.invocationCallOrder[0])
		expect(getState.mock.invocationCallOrder[0]).toBeLessThan(mockedMentions.mock.invocationCallOrder[0])
	})
})
