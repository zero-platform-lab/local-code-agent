import { describe, it, expect, vi, beforeEach } from "vitest"

import {
	resetStreamingStateForNewApiRequest,
	type TaskStreamingStateHost,
} from "../resetStreamingStateForNewApiRequest"

vi.mock("../../assistant-message/NativeToolCallParser", () => ({
	NativeToolCallParser: {
		clearAllStreamingToolCalls: vi.fn(),
		clearRawChunkState: vi.fn(),
	},
}))

import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

const mockedClearAll = vi.mocked(NativeToolCallParser.clearAllStreamingToolCalls)
const mockedClearRaw = vi.mocked(NativeToolCallParser.clearRawChunkState)

/**
 * 全フィールドを「非デフォルトの汚れた値」で埋めた host を作る。
 * reset 後に 1 つずつ期待値へ戻ることを検証するための出発点。
 */
function makeDirtyHost() {
	const diffReset = vi.fn(() => Promise.resolve())
	const streamingToolCallIndices = new Map<string, number>([
		["call-1", 3],
		["call-2", 7],
	])
	const host: TaskStreamingStateHost = {
		stream: {
			currentStreamingContentIndex: 5,
			currentStreamingDidCheckpoint: true,
			assistantMessageContent: [{ type: "text", content: "leftover", partial: true }] as never,
			didCompleteReadingStream: true,
			userMessageContent: [{ type: "text", text: "leftover" }],
			userMessageContentReady: true,
			didRejectTool: true,
			didAlreadyUseTool: true,
			assistantMessageSavedToHistory: true,
			didToolFailInCurrentTurn: true,
			presentAssistantMessageLocked: true,
			presentAssistantMessageHasPendingUpdates: true,
			streamingToolCallIndices,
		},
		diffViewProvider: { reset: diffReset },
	}
	return { host, diffReset, streamingToolCallIndices }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("resetStreamingStateForNewApiRequest", () => {
	it("streaming フラグ / index 系フィールドをそれぞれ初期値へリセットする", async () => {
		const { host } = makeDirtyHost()

		await resetStreamingStateForNewApiRequest(host)

		expect(host.stream.currentStreamingContentIndex).toBe(0)
		expect(host.stream.currentStreamingDidCheckpoint).toBe(false)
		expect(host.stream.assistantMessageContent).toEqual([])
		expect(host.stream.didCompleteReadingStream).toBe(false)
		expect(host.stream.userMessageContent).toEqual([])
		expect(host.stream.userMessageContentReady).toBe(false)
		expect(host.stream.didRejectTool).toBe(false)
		expect(host.stream.didAlreadyUseTool).toBe(false)
		expect(host.stream.assistantMessageSavedToHistory).toBe(false)
		expect(host.stream.didToolFailInCurrentTurn).toBe(false)
		expect(host.stream.presentAssistantMessageLocked).toBe(false)
		expect(host.stream.presentAssistantMessageHasPendingUpdates).toBe(false)
	})

	it("assistantMessageContent / userMessageContent は新しい空配列に差し替える", async () => {
		const { host } = makeDirtyHost()
		const prevAssistant = host.stream.assistantMessageContent
		const prevUser = host.stream.userMessageContent

		await resetStreamingStateForNewApiRequest(host)

		// 中身を空にするだけでなく参照ごと差し替える（新規配列）
		expect(host.stream.assistantMessageContent).not.toBe(prevAssistant)
		expect(host.stream.userMessageContent).not.toBe(prevUser)
	})

	it("streamingToolCallIndices は同一 Map インスタンスを clear する（差し替えではない）", async () => {
		const { host, streamingToolCallIndices } = makeDirtyHost()

		await resetStreamingStateForNewApiRequest(host)

		expect(host.stream.streamingToolCallIndices).toBe(streamingToolCallIndices)
		expect(host.stream.streamingToolCallIndices.size).toBe(0)
	})

	it("NativeToolCallParser の残留 streaming / raw chunk state を各 1 回クリアする", async () => {
		const { host } = makeDirtyHost()

		await resetStreamingStateForNewApiRequest(host)

		expect(mockedClearAll).toHaveBeenCalledTimes(1)
		expect(mockedClearRaw).toHaveBeenCalledTimes(1)
	})

	it("最後に diffViewProvider.reset を await する", async () => {
		const { host, diffReset } = makeDirtyHost()

		await resetStreamingStateForNewApiRequest(host)

		expect(diffReset).toHaveBeenCalledTimes(1)
	})

	it("void（undefined）で解決する", async () => {
		const { host } = makeDirtyHost()

		await expect(resetStreamingStateForNewApiRequest(host)).resolves.toBeUndefined()
	})
})
