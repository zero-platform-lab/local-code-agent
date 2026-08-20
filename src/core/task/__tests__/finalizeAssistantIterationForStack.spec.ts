import { describe, it, expect, vi, beforeEach } from "vitest"

import { finalizeAssistantIterationForStack } from "../finalizeAssistantIterationForStack"

vi.mock("p-wait-for", () => ({ default: vi.fn(async () => {}) }))
vi.mock("../handleNoToolUseFollowup", () => ({
	handleAssistantToolUseFollowup: vi.fn(async () => {}),
}))

import pWaitFor from "p-wait-for"
import { handleAssistantToolUseFollowup } from "../handleNoToolUseFollowup"

const mockedPWaitFor = vi.mocked(pWaitFor)
const mockedFollowup = vi.mocked(handleAssistantToolUseFollowup)

function makeHost(opts: { content?: unknown[]; ready?: boolean; paused?: boolean } = {}) {
	return {
		stream: {
			userMessageContent: (opts.content ?? []) as unknown[],
			userMessageContentReady: opts.ready ?? true,
		},
		isPaused: opts.paused ?? false,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("finalizeAssistantIterationForStack", () => {
	it("userMessageContent に内容があれば StackItem を返す（userContent はコピー・includeFileDetails=false）", async () => {
		const content = [{ type: "text", text: "hi" }]
		const host = makeHost({ content })

		const result = await finalizeAssistantIterationForStack(host as never)

		expect(result?.includeFileDetails).toBe(false)
		expect(result?.userContent).toEqual(content)
		// 元配列を直接載せず必ずコピーする（後続イテレーションでの相互汚染防止）
		expect(result?.userContent).not.toBe(content)
	})

	it("content が空でも isPaused=true なら空の StackItem を返す（一時停止チェックへループを進めるため）", async () => {
		const host = makeHost({ content: [], paused: true })

		const result = await finalizeAssistantIterationForStack(host as never)

		expect(result).toEqual({ userContent: [], includeFileDetails: false })
	})

	it("content が空で isPaused=false なら undefined（stack に積まない＝ループ終了）", async () => {
		const host = makeHost({ content: [], paused: false })

		const result = await finalizeAssistantIterationForStack(host as never)

		expect(result).toBeUndefined()
	})

	it("pWaitFor で userMessageContentReady を待ってから followup を反映する（順序契約）", async () => {
		const host = makeHost({ content: [{ type: "text", text: "x" }], ready: true })

		await finalizeAssistantIterationForStack(host as never)

		// pWaitFor に渡す述語は host.stream.userMessageContentReady を参照する
		const predicate = mockedPWaitFor.mock.calls[0]?.[0]
		expect(predicate?.()).toBe(true)

		// followup には host 実体がそのまま渡る
		expect(mockedFollowup.mock.calls[0]?.[0]).toBe(host)

		// pWaitFor → followup の順で呼ばれる（未確定のまま followup を反映しない）
		expect(mockedPWaitFor.mock.invocationCallOrder[0]).toBeLessThan(mockedFollowup.mock.invocationCallOrder[0])
	})
})
