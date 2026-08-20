// npx vitest run core/assistant-message/__tests__/toolDispatch.spec.ts

import type { ToolName } from "@openai-agent/types"

import type { ToolUse } from "../../../shared/tools"
import { toolDispatch, type ToolDispatchContext } from "../toolDispatch"

const context = (block: Partial<ToolUse> = {}): ToolDispatchContext => ({
	block: { type: "tool_use", name: "new_task", params: {}, partial: false, ...block } as ToolUse,
	askFinishSubTaskApproval: vi.fn(async () => true),
	toolDescription: vi.fn(() => "[desc]"),
})

describe("toolDispatch — coverage", () => {
	it("routes every tool the old switch handled", () => {
		expect(Object.keys(toolDispatch).sort()).toEqual(
			[
				"access_mcp_resource",
				"apply_diff",
				"apply_patch",
				"ask_followup_question",
				"attempt_completion",
				"codebase_search",
				"edit",
				"edit_file",
				"execute_command",
				"list_files",
				"new_task",
				"read_command_output",
				"read_file",
				"run_slash_command",
				"search_and_replace",
				"search_files",
				"search_replace",
				"skill",
				"switch_mode",
				"update_todo_list",
				"use_mcp_tool",
				"web_fetch",
				"write_to_file",
			].sort(),
		)
	})

	it("gives every entry a callable handler", () => {
		for (const [name, spec] of Object.entries(toolDispatch)) {
			expect(typeof spec!.handle, `${name}.handle`).toBe("function")
		}
	})

	it("has no entry for an unknown tool, so the caller falls through to the error path", () => {
		expect(toolDispatch["totally_unknown" as ToolName]).toBeUndefined()
	})
})

describe("toolDispatch — checkpoint policy", () => {
	// checkpoint を取る tool = ワークスペースのファイルを書き換える tool。分割前は
	// switch の各 case に `await checkpointSaveAndMark(cline)` が散っていて一覧できなかった。
	const expected = [
		"apply_diff",
		"apply_patch",
		"edit",
		"edit_file",
		"new_task",
		"search_and_replace",
		"search_replace",
		"write_to_file",
	]

	it("saves a checkpoint for exactly the file-mutating tools", () => {
		const actual = Object.entries(toolDispatch)
			.filter(([, spec]) => spec!.savesCheckpoint)
			.map(([name]) => name)
			.sort()

		expect(actual).toEqual(expected.sort())
	})

	it("does not save a checkpoint for read-only tools", () => {
		for (const name of ["read_file", "list_files", "search_files", "codebase_search", "execute_command"] as const) {
			expect(toolDispatch[name]!.savesCheckpoint, name).toBeUndefined()
		}
	})
})

describe("toolDispatch — extra callbacks", () => {
	it("passes the tool_use id through for new_task", () => {
		const ctx = context({ id: "call_1" })

		expect(toolDispatch.new_task!.extraCallbacks!(ctx)).toEqual({ toolCallId: "call_1" })
	})

	it("passes the subtask approval and description callbacks for attempt_completion", () => {
		const ctx = context()
		const extras = toolDispatch.attempt_completion!.extraCallbacks!(ctx)

		expect(extras.askFinishSubTaskApproval).toBe(ctx.askFinishSubTaskApproval)
		expect(extras.toolDescription).toBe(ctx.toolDescription)
	})

	it("adds nothing for the other tools", () => {
		for (const [name, spec] of Object.entries(toolDispatch)) {
			if (name === "new_task" || name === "attempt_completion") {
				continue
			}

			expect(spec!.extraCallbacks, name).toBeUndefined()
		}
	})
})

describe("toolDispatch — handler wiring", () => {
	it("forwards task, block and callbacks to the underlying tool", async () => {
		const task = { id: "task" }
		const block = { type: "tool_use", name: "read_file" } as ToolUse
		const callbacks = { askApproval: vi.fn() }
		const spy = vi.spyOn(
			await import("../../tools/ReadFileTool").then((m) => m.readFileTool),
			"handle",
		) as unknown as ReturnType<typeof vi.fn>
		spy.mockResolvedValue(undefined as never)

		await toolDispatch.read_file!.handle(task, block, callbacks)

		expect(spy).toHaveBeenCalledWith(task, block, callbacks)
		spy.mockRestore()
	})

	it("routes edit and search_and_replace to the same tool", async () => {
		const { editTool } = await import("../../tools/EditTool")
		const spy = vi.spyOn(editTool, "handle") as unknown as ReturnType<typeof vi.fn>
		spy.mockResolvedValue(undefined as never)

		await toolDispatch.edit!.handle({}, {}, {})
		await toolDispatch.search_and_replace!.handle({}, {}, {})

		expect(spy).toHaveBeenCalledTimes(2)
		spy.mockRestore()
	})
})
