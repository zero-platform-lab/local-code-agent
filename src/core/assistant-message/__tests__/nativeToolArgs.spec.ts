// npx vitest run core/assistant-message/__tests__/nativeToolArgs.spec.ts

import type { ToolName } from "@openai-agent/types"

import {
	buildNativeArgs,
	coerceOptionalBoolean,
	coerceOptionalNumber,
	convertFileEntries,
	nativeArgsSpecs,
} from "../nativeToolArgs"

describe("coerceOptionalBoolean", () => {
	it("passes booleans through", () => {
		expect(coerceOptionalBoolean(true)).toBe(true)
		expect(coerceOptionalBoolean(false)).toBe(false)
	})

	it('accepts "true"/"false" strings regardless of case and padding', () => {
		expect(coerceOptionalBoolean(" TRUE ")).toBe(true)
		expect(coerceOptionalBoolean("False")).toBe(false)
	})

	it("returns undefined for anything else", () => {
		for (const value of [undefined, null, 1, 0, "yes", "", {}]) {
			expect(coerceOptionalBoolean(value)).toBeUndefined()
		}
	})
})

describe("coerceOptionalNumber", () => {
	it("passes finite numbers through, including 0", () => {
		expect(coerceOptionalNumber(0)).toBe(0)
		expect(coerceOptionalNumber(-3.5)).toBe(-3.5)
	})

	it("parses numeric strings", () => {
		expect(coerceOptionalNumber("42")).toBe(42)
	})

	it("rejects non-finite and non-numeric values", () => {
		for (const value of [NaN, Infinity, "abc", undefined, null, {}]) {
			expect(coerceOptionalNumber(value)).toBeUndefined()
		}
	})
})

describe("convertFileEntries", () => {
	it("keeps a bare path with no ranges", () => {
		expect(convertFileEntries([{ path: "a.ts" }])).toEqual([{ path: "a.ts" }])
	})

	it("converts tuple ranges", () => {
		expect(convertFileEntries([{ path: "a.ts", line_ranges: [[1, 50]] }])).toEqual([
			{ path: "a.ts", lineRanges: [{ start: 1, end: 50 }] },
		])
	})

	it("converts object ranges", () => {
		expect(convertFileEntries([{ path: "a.ts", line_ranges: [{ start: 1, end: 50 }] }])).toEqual([
			{ path: "a.ts", lineRanges: [{ start: 1, end: 50 }] },
		])
	})

	it("converts legacy string ranges", () => {
		expect(convertFileEntries([{ path: "a.ts", line_ranges: ["1-50"] }])).toEqual([
			{ path: "a.ts", lineRanges: [{ start: 1, end: 50 }] },
		])
	})

	it("drops ranges it cannot understand but keeps the rest", () => {
		const result = convertFileEntries([{ path: "a.ts", line_ranges: ["nope", [1, 2], 7] }])

		expect(result).toEqual([{ path: "a.ts", lineRanges: [{ start: 1, end: 2 }] }])
	})
})

describe("buildNativeArgs — required-key gating", () => {
	it("needs every required key when finalizing", () => {
		expect(buildNativeArgs("apply_diff", { path: "a.ts" }, "final")).toBeUndefined()
		expect(buildNativeArgs("apply_diff", { path: "a.ts", diff: "d" }, "final")).toEqual({ path: "a.ts", diff: "d" })
	})

	it("needs only one required key while streaming", () => {
		expect(buildNativeArgs("apply_diff", { path: "a.ts" }, "partial")).toEqual({ path: "a.ts", diff: undefined })
	})

	it("builds nothing while streaming when no required key has arrived", () => {
		expect(buildNativeArgs("apply_diff", { unrelated: 1 }, "partial")).toBeUndefined()
	})

	it("treats an empty string as present for defined-style tools", () => {
		expect(buildNativeArgs("codebase_search", { query: "" }, "final")).toEqual({ query: "", path: undefined })
	})

	it("treats an empty string as absent for truthy-style tools", () => {
		expect(buildNativeArgs("attempt_completion", { result: "" }, "final")).toBeUndefined()
		expect(buildNativeArgs("execute_command", { command: "" }, "final")).toBeUndefined()
	})

	it("returns undefined for a tool with no spec", () => {
		expect(buildNativeArgs("definitely_not_a_tool" as ToolName, { a: 1 }, "final")).toBeUndefined()
	})
})

describe("buildNativeArgs — write_to_file's partial/final asymmetry", () => {
	it("requires both keys to be defined when finalizing", () => {
		expect(buildNativeArgs("write_to_file", { path: "a.ts" }, "final")).toBeUndefined()
		expect(buildNativeArgs("write_to_file", { path: "a.ts", content: "" }, "final")).toEqual({
			path: "a.ts",
			content: "",
		})
	})

	it("uses truthiness while streaming, so an empty string alone does not start it", () => {
		expect(buildNativeArgs("write_to_file", { path: "", content: "" }, "partial")).toBeUndefined()
		expect(buildNativeArgs("write_to_file", { path: "a.ts" }, "partial")).toEqual({
			path: "a.ts",
			content: undefined,
		})
	})
})

describe("buildNativeArgs — tools that are final-only", () => {
	it.each(["read_command_output", "access_mcp_resource"] as const)("skips %s while streaming", (name) => {
		expect(buildNativeArgs(name, { artifact_id: "x", server_name: "s", uri: "u" }, "partial")).toBeUndefined()
	})

	it("still builds read_command_output when finalizing", () => {
		expect(buildNativeArgs("read_command_output", { artifact_id: "x" }, "final")).toEqual({
			artifact_id: "x",
			search: undefined,
			offset: undefined,
			limit: undefined,
		})
	})

	it("still builds access_mcp_resource when finalizing", () => {
		expect(buildNativeArgs("access_mcp_resource", { server_name: "s", uri: "u" }, "final")).toEqual({
			server_name: "s",
			uri: "u",
		})
	})
})

describe("buildNativeArgs — ask_followup_question's partial override", () => {
	it("keeps follow_up verbatim when finalizing", () => {
		expect(buildNativeArgs("ask_followup_question", { question: "q", follow_up: "not-an-array" }, "final")).toEqual(
			{
				question: "q",
				follow_up: "not-an-array",
			},
		)
	})

	it("drops a half-streamed follow_up that is not yet an array", () => {
		expect(
			buildNativeArgs("ask_followup_question", { question: "q", follow_up: "not-an-array" }, "partial"),
		).toEqual({ question: "q", follow_up: undefined })
	})

	it("keeps follow_up once it is an array", () => {
		expect(buildNativeArgs("ask_followup_question", { question: "q", follow_up: ["a"] }, "partial")).toEqual({
			question: "q",
			follow_up: ["a"],
		})
	})
})

describe("buildNativeArgs — read_file", () => {
	it("builds the new path form", () => {
		expect(buildNativeArgs("read_file", { path: "a.ts", mode: "slice", offset: "2", limit: 5 }, "final")).toEqual({
			path: "a.ts",
			mode: "slice",
			offset: 2,
			limit: 5,
			indentation: undefined,
		})
	})

	it("builds the legacy files form and flags it", () => {
		const result = buildNativeArgs("read_file", { files: [{ path: "a.ts" }] }, "final") as any

		expect(result.files).toEqual([{ path: "a.ts" }])
		expect(result._legacyFormat).toBe(true)
	})

	it("parses a double-stringified files array", () => {
		const result = buildNativeArgs("read_file", { files: JSON.stringify([{ path: "a.ts" }]) }, "final") as any

		expect(result._legacyFormat).toBe(true)
		expect(result.files).toEqual([{ path: "a.ts" }])
	})

	it("ignores a files string that is not valid JSON and falls through to the path form", () => {
		// files が文字列だが JSON として壊れている場合、catch で握りつぶして
		// legacy 経路には入らず、新形式（path）へフォールバックする。
		const result = buildNativeArgs("read_file", { files: "not-json{", path: "a.ts" }, "final") as any

		expect(result._legacyFormat).toBeUndefined()
		expect(result.path).toBe("a.ts")
	})

	it("builds nothing when files is an unparsable string and no path is given", () => {
		expect(buildNativeArgs("read_file", { files: "still-not-json{" }, "final")).toBeUndefined()
	})

	it("falls through to the path form when files is an empty array", () => {
		const result = buildNativeArgs("read_file", { files: [], path: "a.ts" }, "final") as any

		expect(result._legacyFormat).toBeUndefined()
		expect(result.path).toBe("a.ts")
	})

	it("builds nothing when neither form is present", () => {
		expect(buildNativeArgs("read_file", { mode: "slice" }, "final")).toBeUndefined()
	})

	it("coerces the indentation sub-object", () => {
		const result = buildNativeArgs(
			"read_file",
			{ path: "a.ts", indentation: { anchor_line: "10", max_levels: 2, include_siblings: "true" } },
			"final",
		) as any

		expect(result.indentation).toEqual({
			anchor_line: 10,
			max_levels: 2,
			max_lines: undefined,
			include_siblings: true,
			include_header: undefined,
		})
	})
})

describe("buildNativeArgs — per-tool shapes", () => {
	it("coerces replace_all for edit-family tools", () => {
		for (const name of ["edit", "search_and_replace"] as const) {
			expect(
				buildNativeArgs(
					name,
					{ file_path: "a", old_string: "o", new_string: "n", replace_all: "true" },
					"final",
				),
			).toEqual({ file_path: "a", old_string: "o", new_string: "n", replace_all: true })
		}
	})

	it("does not add replace_all to search_replace", () => {
		expect(
			buildNativeArgs(
				"search_replace",
				{ file_path: "a", old_string: "o", new_string: "n", replace_all: true },
				"final",
			),
		).toEqual({ file_path: "a", old_string: "o", new_string: "n" })
	})

	it("passes expected_replacements through for edit_file", () => {
		expect(
			buildNativeArgs(
				"edit_file",
				{ file_path: "a", old_string: "o", new_string: "n", expected_replacements: 3 },
				"final",
			),
		).toEqual({ file_path: "a", old_string: "o", new_string: "n", expected_replacements: 3 })
	})

	it("coerces recursive for list_files", () => {
		expect(buildNativeArgs("list_files", { path: "a", recursive: "false" }, "final")).toEqual({
			path: "a",
			recursive: false,
		})
	})

	it("carries optional extras for the remaining tools", () => {
		expect(buildNativeArgs("execute_command", { command: "ls", cwd: "/x", timeout: 5 }, "final")).toEqual({
			command: "ls",
			cwd: "/x",
			timeout: 5,
		})
		expect(buildNativeArgs("search_files", { path: "a", regex: "r", file_pattern: "*.ts" }, "final")).toEqual({
			path: "a",
			regex: "r",
			file_pattern: "*.ts",
		})
		expect(buildNativeArgs("use_mcp_tool", { server_name: "s", tool_name: "t", arguments: {} }, "final")).toEqual({
			server_name: "s",
			tool_name: "t",
			arguments: {},
		})
		expect(buildNativeArgs("new_task", { mode: "code", message: "m", todos: [] }, "final")).toEqual({
			mode: "code",
			message: "m",
			todos: [],
		})
		expect(buildNativeArgs("run_slash_command", { command: "c", args: "a" }, "final")).toEqual({
			command: "c",
			args: "a",
		})
		expect(buildNativeArgs("skill", { skill: "s", args: "a" }, "final")).toEqual({ skill: "s", args: "a" })
		expect(buildNativeArgs("update_todo_list", { todos: [] }, "final")).toEqual({ todos: [] })
		expect(buildNativeArgs("apply_patch", { patch: "p" }, "final")).toEqual({ patch: "p" })
	})
})

describe("nativeArgsSpecs table", () => {
	const names = Object.keys(nativeArgsSpecs) as ToolName[]

	it("covers every tool that used to have a case in the finalize switch", () => {
		expect(names.sort()).toEqual(
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
				"update_todo_list",
				"use_mcp_tool",
				"write_to_file",
			].sort(),
		)
	})

	it("builds something for every tool once its required keys are supplied", () => {
		for (const name of names) {
			const spec = nativeArgsSpecs[name]!
			const args = Object.fromEntries(spec.required.map((key) => [key, "x"]))
			// read_file はゲート無し（required 空）なので path を明示的に与える。
			const filled = spec.required.length > 0 ? args : { path: "a.ts" }

			expect(buildNativeArgs(name, filled, "final"), `${name} should build`).toBeDefined()
		}
	})

	it("builds nothing for every gated tool when no argument is supplied", () => {
		for (const name of names) {
			if (nativeArgsSpecs[name]!.required.length === 0) {
				continue
			}

			expect(buildNativeArgs(name, {}, "final"), `${name} should not build`).toBeUndefined()
		}
	})
})
