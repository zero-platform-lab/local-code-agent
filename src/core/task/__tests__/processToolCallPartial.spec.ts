import { describe, it, expect, vi, beforeEach } from "vitest"

import { processToolCallPartial } from "../processToolCallPartial"

vi.mock("../../assistant-message/NativeToolCallParser", () => ({
	NativeToolCallParser: {
		processRawChunk: vi.fn(),
		startStreamingToolCall: vi.fn(),
		processStreamingChunk: vi.fn(),
		finalizeStreamingToolCall: vi.fn(),
	},
}))

import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

const parser = NativeToolCallParser as unknown as {
	processRawChunk: ReturnType<typeof vi.fn>
	startStreamingToolCall: ReturnType<typeof vi.fn>
	processStreamingChunk: ReturnType<typeof vi.fn>
	finalizeStreamingToolCall: ReturnType<typeof vi.fn>
}

function makeDeps(assistantMessageContent: unknown[] = [], indices = new Map<string, number>()) {
	const host = {
		taskId: "t1",
		stream: {
			streamingToolCallIndices: indices,
			assistantMessageContent,
			userMessageContentReady: true,
		},
	}
	return { deps: { host, presentAssistantMessage: vi.fn() } as never, host }
}

beforeEach(() => {
	vi.clearAllMocks()
	parser.processRawChunk.mockReturnValue([])
})

describe("processToolCallPartial", () => {
	it("tool_call_start: 部分 tool_use を積んで index を記録し、present する", () => {
		parser.processRawChunk.mockReturnValue([{ type: "tool_call_start", id: "a1", name: "read_file" }])
		const { deps, host } = makeDeps()

		processToolCallPartial(deps, { index: 0 })

		expect(host.stream.assistantMessageContent).toEqual([
			{ type: "tool_use", name: "read_file", params: {}, partial: true, id: "a1" },
		])
		expect(host.stream.streamingToolCallIndices.get("a1")).toBe(0)
		expect(host.stream.userMessageContentReady).toBe(false)
		expect(parser.startStreamingToolCall).toHaveBeenCalledWith("a1", "read_file")
		expect((deps as any).presentAssistantMessage).toHaveBeenCalled()
	})

	it("同じ ID の tool_call_start が重複したら無視する（API 400 対策）", () => {
		parser.processRawChunk.mockReturnValue([{ type: "tool_call_start", id: "a1", name: "read_file" }])
		const { deps, host } = makeDeps([], new Map([["a1", 0]]))

		processToolCallPartial(deps, { index: 0 })

		expect(host.stream.assistantMessageContent).toEqual([]) // 積まれない
		expect(parser.startStreamingToolCall).not.toHaveBeenCalled()
	})

	it("tool_call_start は直前の partial text ブロックを確定させる", () => {
		parser.processRawChunk.mockReturnValue([{ type: "tool_call_start", id: "a1", name: "read_file" }])
		const text = { type: "text", text: "hi", partial: true }
		const { deps, host } = makeDeps([text])

		processToolCallPartial(deps, { index: 0 })

		expect(text.partial).toBe(false)
		expect(host.stream.streamingToolCallIndices.get("a1")).toBe(1) // text の後ろ
	})

	it("tool_call_delta: 該当 index の tool_use を差し替える", () => {
		parser.processRawChunk.mockReturnValue([{ type: "tool_call_delta", id: "a1", delta: "{" }])
		const updated = { type: "tool_use", name: "read_file", params: { path: "x" }, partial: true }
		parser.processStreamingChunk.mockReturnValue(updated)
		const { deps, host } = makeDeps([{ type: "tool_use", partial: true }], new Map([["a1", 0]]))

		processToolCallPartial(deps, { index: 0 })

		expect(host.stream.assistantMessageContent[0]).toEqual({ ...updated, id: "a1" })
	})

	it("tool_call_end: finalize 成功なら partial を最終形に置換し tracking を消す", () => {
		parser.processRawChunk.mockReturnValue([{ type: "tool_call_end", id: "a1" }])
		const final = { type: "tool_use", name: "read_file", params: { path: "x" }, partial: false }
		parser.finalizeStreamingToolCall.mockReturnValue(final)
		const { deps, host } = makeDeps([{ type: "tool_use", partial: true }], new Map([["a1", 0]]))

		processToolCallPartial(deps, { index: 0 })

		expect(host.stream.assistantMessageContent[0]).toEqual({ ...final, id: "a1" })
		expect(host.stream.streamingToolCallIndices.has("a1")).toBe(false)
	})

	it("tool_call_end: finalize が null（malformed）なら既存を partial=false にして検証側へ回す", () => {
		parser.processRawChunk.mockReturnValue([{ type: "tool_call_end", id: "a1" }])
		parser.finalizeStreamingToolCall.mockReturnValue(null)
		const existing = { type: "tool_use", name: "read_file", params: {}, partial: true }
		const { deps, host } = makeDeps([existing], new Map([["a1", 0]]))

		processToolCallPartial(deps, { index: 0 })

		expect(existing.partial).toBe(false)
		expect((existing as any).id).toBe("a1")
		expect(host.stream.streamingToolCallIndices.has("a1")).toBe(false)
	})
})

describe("伏せ字を元の値へ戻す（FR-PII-02a）", () => {
	/**
	 * **本物の host はクラスである。** `vi.fn()` を挿すと `this` を辿らないので、束縛の
	 * 抜けを見逃す。`this` を使う実装で確かめる。
	 */
	class Restorer {
		readonly table = new Map([["{{email-001}}", "taro@corp.example"]])
		taskId = "t1"
		stream = {
			streamingToolCallIndices: new Map<string, number>(),
			assistantMessageContent: [] as unknown[],
			userMessageContentReady: true,
		}
		unmask(text: string): string {
			return text.replace("{{email-001}}", this.table.get("{{email-001}}")!)
		}
	}

	/** 生の chunk を渡すと、parser が事象へ変える。事象は parser のモックが決める。 */
	const call = (host: Restorer, events: Record<string, unknown>[]) => {
		parser.processRawChunk.mockReturnValue(events)
		processToolCallPartial({ host, presentAssistantMessage: () => {} } as never, { index: 0 } as never)
	}

	it("途中の形にも戻し方を渡す。逐次の内容はそのまま差分の画面へ流れる", () => {
		const host = new Restorer()
		parser.processStreamingChunk.mockReturnValue({ type: "tool_use", name: "write_to_file", params: {} })

		call(host, [{ type: "tool_call_delta", id: "call_1", delta: '{"content":"' }])

		const passed = parser.processStreamingChunk.mock.calls.at(-1)?.[2] as (text: string) => string
		// 外して渡すと、ここで TypeError になる。
		expect(passed('{"content":"{{email-001}}"}')).toBe('{"content":"taro@corp.example"}')
	})

	it("完成のときも戻し方を渡す", () => {
		const host = new Restorer()
		host.stream.streamingToolCallIndices.set("call_1", 0)
		host.stream.assistantMessageContent.push({ type: "tool_use", name: "write_to_file", partial: true })
		parser.finalizeStreamingToolCall.mockReturnValue({ type: "tool_use", name: "write_to_file" })

		call(host, [{ type: "tool_call_end", id: "call_1" }])

		const passed = parser.finalizeStreamingToolCall.mock.calls.at(-1)?.[1] as (text: string) => string
		expect(passed("{{email-001}}")).toBe("taro@corp.example")
	})
})
