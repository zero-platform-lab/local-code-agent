import { describe, it, expect } from "vitest"

import type { McpTool } from "@openai-agent/types"

import { applyToolConfigFlags, toggleToolInList } from "../mcpToolConfig"

const tool = (name: string): McpTool => ({ name, description: `${name} desc` }) as McpTool

describe("applyToolConfigFlags", () => {
	it("alwaysAllow に載っているツールだけ自動承認にする", () => {
		const tools = applyToolConfigFlags([tool("a"), tool("b")], { alwaysAllow: ["a"] })

		expect(tools.find((t) => t.name === "a")?.alwaysAllow).toBe(true)
		expect(tools.find((t) => t.name === "b")?.alwaysAllow).toBe(false)
	})

	it('ワイルドカード "*" は全ツールを自動承認にする', () => {
		const tools = applyToolConfigFlags([tool("a"), tool("b")], { alwaysAllow: ["*"] })

		expect(tools.every((t) => t.alwaysAllow)).toBe(true)
	})

	it("disabledTools のツールは enabledForPrompt が false", () => {
		const tools = applyToolConfigFlags([tool("a"), tool("b")], { disabledTools: ["b"] })

		expect(tools.find((t) => t.name === "a")?.enabledForPrompt).toBe(true)
		expect(tools.find((t) => t.name === "b")?.enabledForPrompt).toBe(false)
	})

	it("設定が空でも全ツールが「非自動承認・プロンプトに載せる」になる", () => {
		const tools = applyToolConfigFlags([tool("a")], {})

		expect(tools[0]).toMatchObject({ alwaysAllow: false, enabledForPrompt: true })
	})

	it("元のツール定義（description 等）を保つ", () => {
		const tools = applyToolConfigFlags([tool("a")], { alwaysAllow: ["a"] })

		expect(tools[0].description).toBe("a desc")
	})

	it("空配列を渡しても壊れない", () => {
		expect(applyToolConfigFlags([], { alwaysAllow: ["*"] })).toEqual([])
	})
})

describe("toggleToolInList", () => {
	it("追加は冪等（重複を作らない）", () => {
		const list = ["a"]

		expect(toggleToolInList(list, "b", true)).toEqual(["a", "b"])
		expect(toggleToolInList(list, "b", true)).toEqual(["a", "b"])
	})

	it("削除は冪等（無ければ何もしない）", () => {
		const list = ["a", "b"]

		expect(toggleToolInList(list, "b", false)).toEqual(["a"])
		expect(toggleToolInList(list, "b", false)).toEqual(["a"])
	})

	it("未定義のリストは空から始める", () => {
		expect(toggleToolInList(undefined, "a", true)).toEqual(["a"])
		expect(toggleToolInList(undefined, "a", false)).toEqual([])
	})

	it("既存配列は同一参照のまま書き換える（呼び出し側が設定オブジェクトに載せ直せる）", () => {
		const list: string[] = []

		expect(toggleToolInList(list, "a", true)).toBe(list)
	})
})
