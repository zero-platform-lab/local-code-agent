// npx vitest run core/task-persistence/__tests__/agentMessageUtils.spec.ts
//
// item 列を扱うナローイング群。ここの分類を各所が前提にしているので直接固める。
//
// 特に turnRole は「1 ターンが複数 item に割れる」ことを吸収する要で、
// function_call_output を user ターンとして扱う。これを itemRole（message item の
// role しか見ない）で代用したせいで、rewind がレースコンディション時に
// assistant メッセージを誤って削除するバグを出した。

import { describe, it, expect } from "vitest"

import type { AgentMessage } from "@openai-agent/types"

import {
	isAssistantTurn,
	isMessageItem,
	isUserTurn,
	itemRole,
	itemText,
	textMessage,
	turnRole,
	withText,
} from "../agentMessageUtils"

const userMsg: AgentMessage = { type: "message", role: "user", content: "u" }
const assistantMsg: AgentMessage = { type: "message", role: "assistant", content: "a" }
const systemMsg: AgentMessage = { type: "message", role: "system", content: "s" }
const developerMsg: AgentMessage = { type: "message", role: "developer", content: "d" }
const call: AgentMessage = { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a"}' }
const output: AgentMessage = { type: "function_call_output", call_id: "c1", output: "body" }
const reasoning: AgentMessage = { type: "reasoning", encrypted_content: "BLOB" }

describe("turnRole", () => {
	it("message item は自分の role（system / developer は user 側に寄せる）", () => {
		expect(turnRole(userMsg)).toBe("user")
		expect(turnRole(assistantMsg)).toBe("assistant")
		expect(turnRole(systemMsg)).toBe("user")
		expect(turnRole(developerMsg)).toBe("user")
	})

	it("function_call と reasoning は assistant が出したもの", () => {
		expect(turnRole(call)).toBe("assistant")
		expect(turnRole(reasoning)).toBe("assistant")
	})

	it("function_call_output は user ターンに属する", () => {
		// ツール実行結果は「こちら側が返すもの」。ここを assistant 扱いにすると
		// 「直前が assistant か」の判定が狂い、tool_result の検証経路が壊れる。
		expect(turnRole(output)).toBe("user")
	})

	it("undefined は undefined", () => {
		expect(turnRole(undefined)).toBeUndefined()
	})

	it("isUserTurn / isAssistantTurn は turnRole と一致する", () => {
		for (const item of [userMsg, assistantMsg, systemMsg, developerMsg, call, output, reasoning]) {
			expect(isUserTurn(item)).toBe(turnRole(item) === "user")
			expect(isAssistantTurn(item)).toBe(turnRole(item) === "assistant")
		}
	})
})

describe("itemRole", () => {
	it("message item だけ role を返す", () => {
		expect(itemRole(userMsg)).toBe("user")
		expect(itemRole(developerMsg)).toBe("developer")
	})

	it("message 以外は undefined（turnRole との違い）", () => {
		// turnRole は "user" を返すが itemRole は undefined。
		// 「ターンの話者」を知りたい場面で itemRole を使うのは誤り。
		expect(itemRole(output)).toBeUndefined()
		expect(turnRole(output)).toBe("user")
		expect(itemRole(call)).toBeUndefined()
		expect(itemRole(reasoning)).toBeUndefined()
	})
})

describe("isMessageItem", () => {
	it("message item だけ true", () => {
		expect(isMessageItem(userMsg)).toBe(true)
		expect(isMessageItem(call)).toBe(false)
		expect(isMessageItem(output)).toBe(false)
		expect(isMessageItem(reasoning)).toBe(false)
		expect(isMessageItem(undefined)).toBe(false)
	})
})

describe("itemText", () => {
	it("文字列 content はそのまま", () => {
		expect(itemText(userMsg)).toBe("u")
	})

	it("parts 配列はテキストを連結し、画像はマーカーにする", () => {
		expect(
			itemText({
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "a" },
					{ type: "input_image", image_url: "data:x" },
					{ type: "output_text", text: "b" },
				],
			}),
		).toBe("a\n[image]\nb")
	})

	it("function_call は name(arguments) 形式", () => {
		expect(itemText(call)).toBe('read_file({"path":"a"})')
	})

	it("function_call_output は output そのもの", () => {
		expect(itemText(output)).toBe("body")
	})

	it("reasoning は空文字（暗号化された不透明値なのでトークン概算に載せない）", () => {
		expect(itemText(reasoning)).toBe("")
	})

	it("undefined は空文字", () => {
		expect(itemText(undefined)).toBe("")
	})
})

describe("textMessage / withText", () => {
	it("メタを載せた message item を作れる", () => {
		expect(textMessage("user", "hi", { ts: 5, isSummary: true })).toEqual({
			type: "message",
			role: "user",
			content: "hi",
			ts: 5,
			isSummary: true,
		})
	})

	it("withText は content だけ差し替えてメタを保つ", () => {
		const src = textMessage("assistant", "old", { ts: 1, condenseParent: "c" })
		expect(withText(src, "new")).toEqual({
			type: "message",
			role: "assistant",
			content: "new",
			ts: 1,
			condenseParent: "c",
		})
	})
})
