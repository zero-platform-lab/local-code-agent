import { describe, it, expect, vi, beforeEach } from "vitest"

import { finalizeStreamingToolCalls } from "../finalizeStreamingToolCalls"

vi.mock("../../assistant-message/NativeToolCallParser", () => ({
	NativeToolCallParser: {
		finalizeStreamingToolCall: vi.fn(),
	},
}))

import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

const parser = NativeToolCallParser as unknown as {
	finalizeStreamingToolCall: ReturnType<typeof vi.fn>
}

function makeDeps(
	opts: {
		indices?: Array<[string, number]>
		content?: unknown[]
		ready?: boolean
	} = {},
) {
	const host = {
		stream: {
			streamingToolCallIndices: new Map<string, number>(opts.indices ?? []),
			assistantMessageContent: (opts.content ?? []) as unknown[],
			userMessageContentReady: opts.ready ?? true,
		},
	}
	const presentAssistantMessage = vi.fn()
	return { deps: { host, presentAssistantMessage }, host, presentAssistantMessage }
}

const endEvent = (id: string) => ({ type: "tool_call_end", id })

beforeEach(() => {
	vi.clearAllMocks()
})

describe("finalizeStreamingToolCalls", () => {
	it("tool_call_end 以外のイベントは finalize せずスキップし present も呼ばない", () => {
		const { deps, presentAssistantMessage } = makeDeps()

		finalizeStreamingToolCalls([{ type: "tool_call_delta", id: "x", delta: "{" }] as never, deps as never)

		expect(parser.finalizeStreamingToolCall).not.toHaveBeenCalled()
		expect(presentAssistantMessage).not.toHaveBeenCalled()
	})

	it("finalize 成功・index 登録あり：partial ブロックを完成版へ置換し id 上書き・追跡削除・ready=false・present 呼ぶ", () => {
		const partial = { type: "tool_use", name: "read_file", partial: true }
		const { deps, host, presentAssistantMessage } = makeDeps({
			indices: [["call_1", 0]],
			content: [partial],
			ready: true,
		})
		// parser が別 id を返しても event.id で上書きされる（tool_result 参照整合の要）
		const finalToolUse = { type: "tool_use", name: "read_file", id: "stale" }
		parser.finalizeStreamingToolCall.mockReturnValue(finalToolUse)

		finalizeStreamingToolCalls([endEvent("call_1")] as never, deps as never)

		expect(parser.finalizeStreamingToolCall).toHaveBeenCalledWith("call_1")
		expect(host.stream.assistantMessageContent[0]).toBe(finalToolUse)
		expect(finalToolUse.id).toBe("call_1")
		expect(host.stream.streamingToolCallIndices.has("call_1")).toBe(false)
		expect(host.stream.userMessageContentReady).toBe(false)
		expect(presentAssistantMessage).toHaveBeenCalledTimes(1)
	})

	it("finalize 成功・index 未登録：content は置換しないが id は付与し ready=false・present 呼ぶ", () => {
		const original = { type: "text", text: "keep" }
		const { deps, host, presentAssistantMessage } = makeDeps({ content: [original] })
		const finalToolUse = { type: "tool_use", id: "stale" }
		parser.finalizeStreamingToolCall.mockReturnValue(finalToolUse)

		finalizeStreamingToolCalls([endEvent("call_missing")] as never, deps as never)

		// index が無いので既存 content は温存される
		expect(host.stream.assistantMessageContent).toEqual([original])
		// それでも finalToolUse には id が付く（後段 native protocol 整合のため）
		expect(finalToolUse.id).toBe("call_missing")
		expect(host.stream.userMessageContentReady).toBe(false)
		expect(presentAssistantMessage).toHaveBeenCalledTimes(1)
	})

	it("finalize 失敗(null)・既存が tool_use：partial=false と id を書き込み・追跡削除・present 呼ぶ", () => {
		const existing = { type: "tool_use", name: "read_file", partial: true } as {
			type: string
			partial: boolean
			id?: string
		}
		const { deps, host, presentAssistantMessage } = makeDeps({
			indices: [["call_1", 0]],
			content: [existing],
		})
		parser.finalizeStreamingToolCall.mockReturnValue(null)

		finalizeStreamingToolCalls([endEvent("call_1")] as never, deps as never)

		expect(existing.partial).toBe(false)
		expect(existing.id).toBe("call_1")
		expect(host.stream.streamingToolCallIndices.has("call_1")).toBe(false)
		expect(host.stream.userMessageContentReady).toBe(false)
		expect(presentAssistantMessage).toHaveBeenCalledTimes(1)
	})

	it("finalize 失敗(null)・既存が tool_use でない：partial には触れず追跡削除と present だけ行う", () => {
		const existing = { type: "text", text: "hi" } as { type: string; partial?: boolean }
		const { deps, host, presentAssistantMessage } = makeDeps({
			indices: [["call_1", 0]],
			content: [existing],
		})
		parser.finalizeStreamingToolCall.mockReturnValue(null)

		finalizeStreamingToolCalls([endEvent("call_1")] as never, deps as never)

		expect(existing.partial).toBeUndefined()
		expect(host.stream.streamingToolCallIndices.has("call_1")).toBe(false)
		expect(host.stream.userMessageContentReady).toBe(false)
		expect(presentAssistantMessage).toHaveBeenCalledTimes(1)
	})

	it("finalize 失敗(null)・index はあるが content が空スロット：追跡削除と present だけ行う", () => {
		const { deps, host, presentAssistantMessage } = makeDeps({
			indices: [["call_1", 3]], // 配列長を超える index → existingToolUse は undefined
			content: [],
		})
		parser.finalizeStreamingToolCall.mockReturnValue(null)

		finalizeStreamingToolCalls([endEvent("call_1")] as never, deps as never)

		expect(host.stream.streamingToolCallIndices.has("call_1")).toBe(false)
		expect(host.stream.userMessageContentReady).toBe(false)
		expect(presentAssistantMessage).toHaveBeenCalledTimes(1)
	})

	it("finalize 失敗(null)・index も未登録：完全な no-op（present も ready 変更もしない）", () => {
		const { deps, host, presentAssistantMessage } = makeDeps({ ready: true })
		parser.finalizeStreamingToolCall.mockReturnValue(null)

		finalizeStreamingToolCalls([endEvent("call_unknown")] as never, deps as never)

		expect(host.stream.userMessageContentReady).toBe(true)
		expect(presentAssistantMessage).not.toHaveBeenCalled()
	})

	it("複数の tool_call_end を順に処理し、確定するたびに present を呼ぶ", () => {
		const { deps, host, presentAssistantMessage } = makeDeps({
			indices: [
				["call_1", 0],
				["call_2", 1],
			],
			content: [
				{ type: "tool_use", partial: true },
				{ type: "tool_use", partial: true },
			],
		})
		parser.finalizeStreamingToolCall
			.mockReturnValueOnce({ type: "tool_use", id: "a" })
			.mockReturnValueOnce({ type: "tool_use", id: "b" })

		finalizeStreamingToolCalls([endEvent("call_1"), endEvent("call_2")] as never, deps as never)

		expect(presentAssistantMessage).toHaveBeenCalledTimes(2)
		expect(host.stream.streamingToolCallIndices.size).toBe(0)
	})
})
