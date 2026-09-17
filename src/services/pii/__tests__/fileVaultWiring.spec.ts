import type { AgentMessage } from "@openai-agent/types"
import { describe, expect, it } from "vitest"

import { placeholderEntries, readFileTargets } from "../fileVaultWiring"

const call = (callId: string, name: string, args: unknown): AgentMessage =>
	({ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) }) as AgentMessage
const output = (callId: string, text: string): AgentMessage =>
	({ type: "function_call_output", call_id: callId, output: text }) as AgentMessage
const message = (text: string): AgentMessage => ({ type: "message", role: "user", content: text }) as AgentMessage

describe("readFileTargets", () => {
	it("read_file の新形式 path を call_id に紐付ける", () => {
		const targets = readFileTargets([call("c1", "read_file", { path: "docs/note.md" }), output("c1", "本文")])
		expect(targets.get("c1")).toEqual(["docs/note.md"])
	})

	it("レガシーの files[].path を集める", () => {
		const targets = readFileTargets([call("c1", "read_file", { files: [{ path: "a.md" }, { path: "b.md" }] })])
		expect(targets.get("c1")).toEqual(["a.md", "b.md"])
	})

	it("read_file 以外のツールは対象にしない", () => {
		const targets = readFileTargets([
			call("c1", "write_to_file", { path: "a.md", content: "x" }),
			call("c2", "list_files", { path: "src" }),
			call("c3", "search_files", { path: "src", regex: "x" }),
		])
		expect(targets.size).toBe(0)
	})

	it("壊れた引数やパスの無い呼び出しは飛ばす", () => {
		const targets = readFileTargets([
			{ type: "function_call", call_id: "c1", name: "read_file", arguments: "{壊れた" } as AgentMessage,
			call("c2", "read_file", { path: "" }),
			call("c3", "read_file", { files: [{}, { path: 3 }] }),
			message("これは function_call ではない"),
		])
		expect(targets.size).toBe(0)
	})
})

describe("placeholderEntries", () => {
	const table = new Map([
		["{{email-001}}", "taro@corp.example"],
		["{{person-002}}", "森下"],
		["{{email-003}}", "使われていない"],
	])

	it("本文に現れた伏せ字だけを、対応表の値で拾う", () => {
		const entries = placeholderEntries("連絡先は {{email-001}}、担当は {{person-002}}", table)
		expect(entries).toEqual([
			["{{email-001}}", "taro@corp.example"],
			["{{person-002}}", "森下"],
		])
	})

	it("対応表に無い伏せ字は入れない", () => {
		expect(placeholderEntries("{{email-999}} は未知", table)).toEqual([])
	})

	it("同じ伏せ字が 2 回出ても 1 件にする", () => {
		expect(placeholderEntries("{{email-001}} と {{email-001}}", table)).toEqual([
			["{{email-001}}", "taro@corp.example"],
		])
	})

	it("伏せ字が無ければ空", () => {
		expect(placeholderEntries("ふつうの本文", table)).toEqual([])
	})
})
