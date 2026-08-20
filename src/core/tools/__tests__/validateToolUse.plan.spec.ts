// npx vitest run src/core/tools/__tests__/validateToolUse.plan.spec.ts
//
// The read-only autonomy mode (Plan) blocks mutating tools at the validation layer,
// regardless of the role mode (here: "code", which normally allows everything).
import type { ToolName } from "@openai-agent/types"

import { validateToolUse, isToolAllowedInReadOnlyMode } from "../validateToolUse"

const asTool = (t: string) => t as ToolName

describe("Plan (read-only) autonomy gate", () => {
	describe("isToolAllowedInReadOnlyMode", () => {
		it("allows reads, mcp, and always-available tools", () => {
			for (const tool of [
				"read_file",
				"search_files",
				"list_files",
				"codebase_search",
				"use_mcp_tool",
				"ask_followup_question",
				"attempt_completion",
				"update_todo_list",
			]) {
				expect(isToolAllowedInReadOnlyMode(tool)).toBe(true)
			}
		})

		it("blocks edits and commands", () => {
			for (const tool of ["write_to_file", "apply_diff", "execute_command"]) {
				expect(isToolAllowedInReadOnlyMode(tool)).toBe(false)
			}
		})
	})

	describe("validateToolUse with autonomyMode=plan (role=code)", () => {
		it("throws for write_to_file even though code mode allows it", () => {
			expect(() =>
				validateToolUse(asTool("write_to_file"), "code", [], undefined, {}, undefined, undefined, "plan"),
			).toThrow(/Plan \(read-only\) mode/)
		})

		it("throws for execute_command in plan mode", () => {
			expect(() =>
				validateToolUse(asTool("execute_command"), "code", [], undefined, {}, undefined, undefined, "plan"),
			).toThrow(/Plan \(read-only\) mode/)
		})

		it("allows read_file in plan mode", () => {
			expect(() =>
				validateToolUse(asTool("read_file"), "code", [], undefined, {}, undefined, undefined, "plan"),
			).not.toThrow()
		})

		it("does NOT block edits when autonomy mode is auto", () => {
			expect(() =>
				validateToolUse(asTool("write_to_file"), "code", [], undefined, {}, undefined, undefined, "auto"),
			).not.toThrow()
		})
	})
})
