import { describe, it, expect, vi, beforeEach } from "vitest"

import { processCompleteToolCall } from "../processCompleteToolCall"

vi.mock("../../assistant-message/NativeToolCallParser", () => ({
	NativeToolCallParser: {
		parseToolCall: vi.fn(),
	},
}))

import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

const parser = NativeToolCallParser as unknown as {
	parseToolCall: ReturnType<typeof vi.fn>
}

function makeDeps() {
	const host = {
		taskId: "task-1",
		stream: {
			assistantMessageContent: [] as unknown[],
			userMessageContentReady: true,
		},
	}
	const presentAssistantMessage = vi.fn()
	return { deps: { host, presentAssistantMessage } as never, host, presentAssistantMessage }
}

const chunk = { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }

beforeEach(() => {
	vi.clearAllMocks()
})

describe("processCompleteToolCall", () => {
	it("chunk の id/name/arguments をそのまま parseToolCall に渡す", () => {
		const { deps } = makeDeps()
		parser.parseToolCall.mockReturnValue({ type: "tool_use" })

		processCompleteToolCall(deps, chunk)

		expect(parser.parseToolCall).toHaveBeenCalledWith({
			id: "call_1",
			name: "read_file",
			arguments: '{"path":"a.ts"}',
		})
	})

	it("成功時：toolUse.id を chunk.id で上書きし、assistantMessageContent へ push、userMessageContentReady=false、present を呼ぶ", () => {
		const { deps, host, presentAssistantMessage } = makeDeps()
		// parser が別 id を持って返しても chunk.id で上書きされる（tool_result 参照整合の要）
		const toolUse = { type: "tool_use", name: "read_file", id: "stale-id" }
		parser.parseToolCall.mockReturnValue(toolUse)

		processCompleteToolCall(deps, chunk)

		expect(toolUse.id).toBe("call_1")
		expect(host.stream.assistantMessageContent).toEqual([toolUse])
		expect(host.stream.userMessageContentReady).toBe(false)
		expect(presentAssistantMessage).toHaveBeenCalledTimes(1)
	})

	it("present は push と userMessageContentReady=false を終えた後に呼ばれる（順序契約）", () => {
		const host = {
			taskId: "t",
			stream: { assistantMessageContent: [] as unknown[], userMessageContentReady: true },
		}
		const seen: { len: number; ready: boolean }[] = []
		const presentAssistantMessage = vi.fn(() => {
			seen.push({
				len: host.stream.assistantMessageContent.length,
				ready: host.stream.userMessageContentReady,
			})
		})
		parser.parseToolCall.mockReturnValue({ type: "tool_use", id: "x" })

		processCompleteToolCall({ host, presentAssistantMessage } as never, chunk)

		// present が呼ばれた時点で、既に content へ push 済み・ready=false になっている
		expect(seen).toEqual([{ len: 1, ready: false }])
	})

	it("parseToolCall が null：taskId 付きで console.error し early return、push も present もしない", () => {
		const { deps, host, presentAssistantMessage } = makeDeps()
		parser.parseToolCall.mockReturnValue(null)
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		processCompleteToolCall(deps, chunk)

		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("task-1"), chunk)
		expect(host.stream.assistantMessageContent).toEqual([])
		// 未処理なので ready フラグは触らない（true のまま）
		expect(host.stream.userMessageContentReady).toBe(true)
		expect(presentAssistantMessage).not.toHaveBeenCalled()

		errSpy.mockRestore()
	})
})
