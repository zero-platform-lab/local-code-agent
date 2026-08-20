import { describe, it, expect, vi } from "vitest"

import { buildAssistantHistoryContent } from "../buildAssistantHistoryContent"

function makeDeps(assistantMessageContent: unknown[] = []) {
	return {
		taskId: "t1",
		stream: { assistantMessageContent },
		addToApiConversationHistory: vi.fn(async () => {}),
		pushToolResultToUserContent: vi.fn(() => true),
		setAssistantMessageSavedToHistory: vi.fn(),
	} as never
}

const savedContent = (deps: unknown) =>
	((deps as any).addToApiConversationHistory.mock.calls[0][0] as { content: unknown[] }).content

describe("buildAssistantHistoryContent", () => {
	it("text と tool_use を組み立てて履歴に保存し、保存済みフラグを立てる", async () => {
		const deps = makeDeps([{ type: "tool_use", id: "a1", name: "read_file", params: { path: "x" } }])

		await buildAssistantHistoryContent(deps, "hello", "reasoning-text")

		expect(savedContent(deps)).toEqual([
			{ type: "text", text: "hello" },
			{ type: "tool_use", id: "a1", name: "read_file", input: { path: "x" } },
		])
		// reasoning は 2 引数目で渡す
		expect((deps as any).addToApiConversationHistory.mock.calls[0][1]).toBe("reasoning-text")
		expect((deps as any).setAssistantMessageSavedToHistory).toHaveBeenCalledWith(true)
	})

	it("assistantMessage が空なら text ブロックを作らない", async () => {
		const deps = makeDeps([{ type: "tool_use", id: "a1", name: "read_file", params: {} }])

		await buildAssistantHistoryContent(deps, "", undefined)

		expect(savedContent(deps)).toEqual([{ type: "tool_use", id: "a1", name: "read_file", input: {} }])
	})

	it("nativeArgs があれば params より優先し、originalName を履歴名に使う", async () => {
		const deps = makeDeps([
			{
				type: "tool_use",
				id: "a1",
				name: "edit",
				originalName: "edit_file",
				params: { p: 1 },
				nativeArgs: { p: 2 },
			},
		])

		await buildAssistantHistoryContent(deps, "", undefined)

		expect(savedContent(deps)).toEqual([{ type: "tool_use", id: "a1", name: "edit_file", input: { p: 2 } }])
	})

	it("同一 tool_use ID は重複排除する（API 400 対策）", async () => {
		const deps = makeDeps([
			{ type: "tool_use", id: "dup", name: "read_file", params: {} },
			{ type: "tool_use", id: "dup", name: "read_file", params: {} },
		])

		await buildAssistantHistoryContent(deps, "", undefined)

		const content = savedContent(deps) as unknown[]
		expect(content.filter((b: any) => b.type === "tool_use")).toHaveLength(1)
	})

	it("mcp_tool_use は name と arguments を使って tool_use に変換する", async () => {
		const deps = makeDeps([{ type: "mcp_tool_use", id: "m1", name: "mcp_srv_do", arguments: { a: 1 } }])

		await buildAssistantHistoryContent(deps, "", undefined)

		expect(savedContent(deps)).toEqual([{ type: "tool_use", id: "m1", name: "mcp_srv_do", input: { a: 1 } }])
	})

	it("同一 ID の mcp_tool_use も重複排除する（2 件目を落とす）", async () => {
		const deps = makeDeps([
			{ type: "mcp_tool_use", id: "dup", name: "mcp_srv_do", arguments: { a: 1 } },
			{ type: "mcp_tool_use", id: "dup", name: "mcp_srv_do", arguments: { a: 2 } },
		])

		await buildAssistantHistoryContent(deps, "", undefined)

		const content = savedContent(deps) as unknown[]
		expect(content.filter((b: any) => b.type === "tool_use")).toHaveLength(1)
		// 先勝ち: 最初の arguments が残る
		expect(content[0]).toEqual({ type: "tool_use", id: "dup", name: "mcp_srv_do", input: { a: 1 } })
	})

	it("id の無い tool_use は落とす", async () => {
		const deps = makeDeps([{ type: "tool_use", name: "read_file", params: {} }])

		await buildAssistantHistoryContent(deps, "text", undefined)

		expect(savedContent(deps)).toEqual([{ type: "text", text: "text" }])
	})

	it("new_task の後にツールがあれば truncate し、後続に not-executed の tool_result を積む", async () => {
		const deps = makeDeps([
			{ type: "tool_use", id: "nt", name: "new_task", params: {} },
			{ type: "tool_use", id: "after", name: "read_file", params: {} },
		])

		await buildAssistantHistoryContent(deps, "", undefined)

		// 履歴には new_task までしか残らない
		const content = savedContent(deps) as any[]
		expect(content.map((b) => b.name)).toEqual(["new_task"])
		// 後続ツールにはエラー tool_result
		expect((deps as any).pushToolResultToUserContent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "tool_result", tool_use_id: "after", is_error: true }),
		)
		// 実行用配列も truncate される
		expect((deps as any).stream.assistantMessageContent).toHaveLength(1)
	})
})
