// npx vitest run core/prompts/tools/native-tools/__tests__/native-tools.spec.ts

import type OpenAI from "openai"

import { getNativeTools, nativeTools } from "../index"

// 各ツール定義から function 部分を取り出すヘルパー
type FunctionTool = OpenAI.Chat.ChatCompletionTool & { type: "function" }
const fn = (tool: OpenAI.Chat.ChatCompletionTool) => (tool as FunctionTool).function

// index.ts が集約している全ネイティブツールの正規名。
// ここが欠けると System Prompt のツールカタログが壊れるので固定する。
const EXPECTED_TOOL_NAMES = [
	"access_mcp_resource",
	"apply_diff",
	"apply_patch",
	"ask_followup_question",
	"attempt_completion",
	"codebase_search",
	"execute_command",
	"list_files",
	"new_task",
	"read_command_output",
	"read_file",
	"run_slash_command",
	"skill",
	"search_replace",
	"edit_file",
	"edit",
	"search_files",
	"update_todo_list",
	"write_to_file",
]

describe("getNativeTools", () => {
	it("既定オプション（引数なし）で全ネイティブツールを返す", () => {
		// getNativeTools() は options 既定値 {} を使う分岐を通る
		const tools = getNativeTools()
		const names = tools.map((t) => fn(t).name)

		for (const expected of EXPECTED_TOOL_NAMES) {
			expect(names).toContain(expected)
		}
	})

	it("ツール名が一意である（重複は API エラーを招く不変条件）", () => {
		const names = getNativeTools().map((t) => fn(t).name)
		const unique = new Set(names)
		expect(unique.size).toBe(names.length)
	})

	it("全ツールが type:function と name/description を備える", () => {
		for (const tool of getNativeTools()) {
			expect(tool.type).toBe("function")
			expect(typeof fn(tool).name).toBe("string")
			expect(fn(tool).name.length).toBeGreaterThan(0)
			expect(typeof fn(tool).description).toBe("string")
		}
	})

	it("supportsImages:true で read_file 説明に画像対応の記述が入る", () => {
		// options を明示的に渡す分岐 + supportsImages を渡す分岐を通る
		const tools = getNativeTools({ supportsImages: true })
		const readFile = tools.find((t) => fn(t).name === "read_file")!
		expect(fn(readFile).description).toContain("returns image files")
	})

	it("supportsImages 未指定（既定 false）では画像対応の記述を含まない", () => {
		const tools = getNativeTools({})
		const readFile = tools.find((t) => fn(t).name === "read_file")!
		expect(fn(readFile).description).not.toContain("returns image files")
	})

	it("nativeTools（後方互換のデフォルトエクスポート）も同じ集合を返す", () => {
		const names = nativeTools.map((t) => fn(t).name)
		for (const expected of EXPECTED_TOOL_NAMES) {
			expect(names).toContain(expected)
		}
	})
})
