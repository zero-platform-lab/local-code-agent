// npx vitest run core/assistant-message/__tests__/describeToolUse.spec.ts

import type { ModeConfig } from "@openai-agent/types"

import type { ToolUse } from "../../../shared/tools"
import { describeToolUse } from "../describeToolUse"

const block = (name: string, params: Record<string, string> = {}, nativeArgs?: unknown) =>
	({ type: "tool_use", name, params, partial: false, nativeArgs }) as unknown as ToolUse

describe("describeToolUse", () => {
	it("names the command for execute_command", () => {
		expect(describeToolUse(block("execute_command", { command: "ls -la" }))).toBe("[execute_command for 'ls -la']")
	})

	it("names the path for write_to_file and list_files", () => {
		expect(describeToolUse(block("write_to_file", { path: "a.ts" }))).toBe("[write_to_file for 'a.ts']")
		expect(describeToolUse(block("list_files", { path: "src" }))).toBe("[list_files for 'src']")
	})

	it("uses nativeArgs.path for read_file when present", () => {
		expect(describeToolUse(block("read_file", { path: "legacy.ts" }, { path: "native.ts" }))).toBe(
			"[read_file for 'native.ts']",
		)
	})

	it("falls back to params for read_file without nativeArgs", () => {
		expect(describeToolUse(block("read_file", { path: "legacy.ts" }))).toBe("[read_file for 'legacy.ts']")
	})

	it("omits the path for apply_diff when it is missing", () => {
		expect(describeToolUse(block("apply_diff", { path: "a.ts" }))).toBe("[apply_diff for 'a.ts']")
		expect(describeToolUse(block("apply_diff"))).toBe("[apply_diff]")
	})

	it("appends the file pattern for search_files only when present", () => {
		expect(describeToolUse(block("search_files", { regex: "foo" }))).toBe("[search_files for 'foo']")
		expect(describeToolUse(block("search_files", { regex: "foo", file_pattern: "*.ts" }))).toBe(
			"[search_files for 'foo' in '*.ts']",
		)
	})

	it.each(["edit", "search_and_replace", "search_replace", "edit_file"] as const)(
		"names file_path for %s",
		(name) => {
			expect(describeToolUse(block(name, { file_path: "a.ts" }))).toBe(`[${name} for 'a.ts']`)
		},
	)

	it.each(["use_mcp_tool", "access_mcp_resource"] as const)("names the server for %s", (name) => {
		expect(describeToolUse(block(name, { server_name: "srv" }))).toBe(`[${name} for 'srv']`)
	})

	it("names the question for ask_followup_question", () => {
		expect(describeToolUse(block("ask_followup_question", { question: "why?" }))).toBe(
			"[ask_followup_question for 'why?']",
		)
	})

	it("appends the reason for switch_mode only when present", () => {
		expect(describeToolUse(block("switch_mode", { mode_slug: "code" }))).toBe("[switch_mode to 'code']")
		expect(describeToolUse(block("switch_mode", { mode_slug: "code", reason: "need edits" }))).toBe(
			"[switch_mode to 'code' because: need edits]",
		)
	})

	it("names the query for codebase_search and the artifact for read_command_output", () => {
		expect(describeToolUse(block("codebase_search", { query: "q" }))).toBe("[codebase_search for 'q']")
		expect(describeToolUse(block("read_command_output", { artifact_id: "a1" }))).toBe(
			"[read_command_output for 'a1']",
		)
	})

	it.each(["apply_patch", "attempt_completion", "update_todo_list"] as const)("shows %s bare", (name) => {
		expect(describeToolUse(block(name, { path: "ignored" }))).toBe(`[${name}]`)
	})

	it("appends args for run_slash_command and skill only when present", () => {
		expect(describeToolUse(block("run_slash_command", { command: "c" }))).toBe("[run_slash_command for 'c']")
		expect(describeToolUse(block("run_slash_command", { command: "c", args: "x" }))).toBe(
			"[run_slash_command for 'c' with args: x]",
		)
		expect(describeToolUse(block("skill", { skill: "s" }))).toBe("[skill for 's']")
		expect(describeToolUse(block("skill", { skill: "s", args: "x" }))).toBe("[skill for 's' with args: x]")
	})

	describe("new_task", () => {
		const customModes = [{ slug: "custom", name: "Custom Mode" }] as ModeConfig[]

		it("resolves the mode display name from customModes", () => {
			expect(describeToolUse(block("new_task", { mode: "custom", message: "go" }), customModes)).toBe(
				"[new_task in Custom Mode mode: 'go']",
			)
		})

		it("falls back to the raw slug for an unknown mode", () => {
			expect(describeToolUse(block("new_task", { mode: "nope", message: "go" }), customModes)).toBe(
				"[new_task in nope mode: 'go']",
			)
		})

		it("substitutes a placeholder message when none is given", () => {
			expect(describeToolUse(block("new_task", { mode: "custom" }), customModes)).toBe(
				"[new_task in Custom Mode mode: '(no message)']",
			)
		})

		it("falls back to the default mode slug when mode is missing", () => {
			const label = describeToolUse(block("new_task", { message: "go" }))

			expect(label).toMatch(/^\[new_task in .+ mode: 'go'\]$/)
		})
	})

	it("shows an unknown tool bare", () => {
		expect(describeToolUse(block("totally_unknown", { a: "b" }))).toBe("[totally_unknown]")
	})

	it("tolerates a block with no params object", () => {
		const noParams = { type: "tool_use", name: "apply_patch", partial: false } as unknown as ToolUse

		expect(describeToolUse(noParams)).toBe("[apply_patch]")
	})
})
