import { describe, it, expect, vi, beforeEach } from "vitest"

// buildAssistantHistoryContent はこのモジュールの唯一の重い collaborator。
// 「どんな deps でどの本文を渡して呼ぶか」だけを pin したいのでモック化する。
// パスは spec(core/task/__tests__) からの相対で、ソースの `./buildAssistantHistoryContent` を +1 段した `../buildAssistantHistoryContent`。
vi.mock("../buildAssistantHistoryContent", () => ({ buildAssistantHistoryContent: vi.fn() }))
// i18n を差し替えてキーをそのまま返す。
// ソースの `../../i18n` を +1 段した `../../../i18n`。
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

import { persistAssistantContentIfAny } from "../persistAssistantContentIfAny"
import { buildAssistantHistoryContent } from "../buildAssistantHistoryContent"

const mockedBuild = vi.mocked(buildAssistantHistoryContent)

function makeDeps() {
	const host = {
		taskId: "task-1",
		stream: {
			assistantMessageContent: [{ type: "text", text: "hi" }],
			assistantMessageSavedToHistory: false,
		},
		graceRetry: { noAssistantMessages: 5 },
	}
	const say = vi.fn((..._a: unknown[]) => Promise.resolve())
	const addToApiConversationHistory = vi.fn((..._a: unknown[]) => Promise.resolve())
	const pushToolResultToUserContent = vi.fn(() => true)
	const deps = { host, say, addToApiConversationHistory, pushToolResultToUserContent }
	return { deps, host, say, addToApiConversationHistory, pushToolResultToUserContent }
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedBuild.mockResolvedValue(undefined)
})

describe("persistAssistantContentIfAny", () => {
	it("counter リセット後に buildAssistantHistoryContent を実行する", async () => {
		const { deps, host, say } = makeDeps()

		await persistAssistantContentIfAny(deps as never, "assistant text", "reasoning text")

		expect(host.graceRetry.noAssistantMessages).toBe(0)
		expect(say).not.toHaveBeenCalled()
		expect(mockedBuild).toHaveBeenCalledTimes(1)
	})

	it("buildAssistantHistoryContent には host 由来の taskId/stream・collaborator・assistant/reasoning 本文を渡す", async () => {
		const { deps, host } = makeDeps()

		await persistAssistantContentIfAny(deps as never, "assistant text", "reasoning text")

		const buildDeps = mockedBuild.mock.calls[0][0] as any
		expect(buildDeps.taskId).toBe("task-1")
		expect(buildDeps.stream).toBe(host.stream)
		expect(buildDeps.addToApiConversationHistory).toBe(deps.addToApiConversationHistory)
		expect(buildDeps.pushToolResultToUserContent).toBe(deps.pushToolResultToUserContent)
		// 本文はそのまま透過して渡る
		expect(mockedBuild.mock.calls[0][1]).toBe("assistant text")
		expect(mockedBuild.mock.calls[0][2]).toBe("reasoning text")
	})

	it("buildAssistantHistoryContent へ渡す setAssistantMessageSavedToHistory は host.stream のフラグを書き換える", async () => {
		const { deps, host } = makeDeps()

		await persistAssistantContentIfAny(deps as never, "assistant text", "reasoning text")

		const buildDeps = mockedBuild.mock.calls[0][0] as any
		expect(host.stream.assistantMessageSavedToHistory).toBe(false)
		buildDeps.setAssistantMessageSavedToHistory(true)
		expect(host.stream.assistantMessageSavedToHistory).toBe(true)
	})
})
