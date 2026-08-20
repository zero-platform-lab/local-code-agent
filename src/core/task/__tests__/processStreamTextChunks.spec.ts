import { describe, it, expect, vi } from "vitest"

import { processReasoningChunk, processTextChunk, type ProcessTextChunkStateHost } from "../processStreamTextChunks"

describe("processReasoningChunk", () => {
	it("current + chunk を連結して say に partial=reasoning で流し、連結後の raw を返す", async () => {
		const say = vi.fn(async () => {})
		const deps = { say }

		const result = await processReasoningChunk(deps, "world", "hello ")

		expect(result).toBe("hello world")
		// 整形対象の ** が無いので raw と同じ文字列が say される
		expect(say).toHaveBeenCalledTimes(1)
		expect(say).toHaveBeenCalledWith("reasoning", "hello world", undefined, true)
	})

	it("文末記号の直後に **Title** があるとき say には改行挿入済みを渡すが、返り値は raw のまま", async () => {
		const say = vi.fn(async () => {})
		const deps = { say }

		const result = await processReasoningChunk(deps, "**Title**", "end.")

		// 返り値は整形前（改行を挿入しない）
		expect(result).toBe("end.**Title**")
		// webview には section header を見やすくした整形版を流す
		expect(say).toHaveBeenCalledWith("reasoning", "end.\n\n**Title**", undefined, true)
	})

	it("! や ? の直後の **Title** も改行挿入される", async () => {
		const say = vi.fn(async () => {})
		const deps = { say }

		await processReasoningChunk(deps, "", "done!**A** more?**B**")

		expect(say).toHaveBeenCalledWith("reasoning", "done!\n\n**A** more?\n\n**B**", undefined, true)
	})

	it("** はあっても文末記号が直前に無ければ整形されない（includes 分岐 true・regex 非マッチ）", async () => {
		const say = vi.fn(async () => {})
		const deps = { say }

		const result = await processReasoningChunk(deps, "", "some **bold** text")

		expect(result).toBe("some **bold** text")
		expect(say).toHaveBeenCalledWith("reasoning", "some **bold** text", undefined, true)
	})
})

function makeTextDeps(content: unknown[], userMessageContentReady: boolean) {
	const host: ProcessTextChunkStateHost = {
		stream: {
			assistantMessageContent: content as never,
			userMessageContentReady,
		},
	}
	const presentAssistantMessage = vi.fn()
	return { deps: { host, presentAssistantMessage }, host, presentAssistantMessage }
}

describe("processTextChunk", () => {
	it("末尾が partial text block ならその content を上書きし、新規 push しない・ready も触らない", () => {
		const { deps, host, presentAssistantMessage } = makeTextDeps(
			[{ type: "text", content: "old", partial: true }],
			true,
		)

		const result = processTextChunk(deps, "add", "acc-")

		expect(result).toBe("acc-add")
		expect(host.stream.assistantMessageContent).toHaveLength(1)
		expect(host.stream.assistantMessageContent[0]).toEqual({ type: "text", content: "acc-add", partial: true })
		// 上書き分岐では userMessageContentReady を false にしない（true のまま）
		expect(host.stream.userMessageContentReady).toBe(true)
		expect(presentAssistantMessage).toHaveBeenCalledTimes(1)
	})

	it("末尾ブロックが無い（空配列）なら新規 text block を push し ready=false にする", () => {
		const { deps, host, presentAssistantMessage } = makeTextDeps([], true)

		const result = processTextChunk(deps, "hi", "acc ")

		expect(result).toBe("acc hi")
		expect(host.stream.assistantMessageContent).toEqual([{ type: "text", content: "acc hi", partial: true }])
		expect(host.stream.userMessageContentReady).toBe(false)
		expect(presentAssistantMessage).toHaveBeenCalledTimes(1)
	})

	it("末尾が text だが partial=false なら新規 push（上書きしない）", () => {
		const { deps, host } = makeTextDeps([{ type: "text", content: "done", partial: false }], true)

		processTextChunk(deps, "x", "y")

		expect(host.stream.assistantMessageContent).toHaveLength(2)
		expect(host.stream.assistantMessageContent[1]).toEqual({ type: "text", content: "yx", partial: true })
		expect(host.stream.userMessageContentReady).toBe(false)
	})

	it("末尾が text 以外（tool_use）なら新規 text block を push する", () => {
		const { deps, host } = makeTextDeps([{ type: "tool_use", name: "t", partial: true }], true)

		processTextChunk(deps, "b", "a")

		expect(host.stream.assistantMessageContent).toHaveLength(2)
		expect(host.stream.assistantMessageContent[1]).toEqual({ type: "text", content: "ab", partial: true })
		expect(host.stream.userMessageContentReady).toBe(false)
	})
})
