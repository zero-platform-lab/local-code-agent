// npx vitest run shared/__tests__/todo.spec.ts

import type { ClineMessage } from "@openai-agent/types"

import { getLatestTodo } from "../todo"

const msg = (partial: Partial<ClineMessage>): ClineMessage => ({ ts: 0, ...partial }) as ClineMessage

describe("getLatestTodo", () => {
	it("ask/tool メッセージの updateTodoList から todos を取り出す", () => {
		const todos = [{ id: "1", content: "do it", status: "pending" }]
		const messages = [msg({ type: "ask", ask: "tool", text: JSON.stringify({ tool: "updateTodoList", todos }) })]
		expect(getLatestTodo(messages)).toEqual(todos)
	})

	it("say/user_edit_todos メッセージも対象にする", () => {
		const todos = [{ id: "a", content: "x", status: "completed" }]
		const messages = [
			msg({ type: "say", say: "user_edit_todos", text: JSON.stringify({ tool: "updateTodoList", todos }) }),
		]
		expect(getLatestTodo(messages)).toEqual(todos)
	})

	it("複数ある場合は最後の todos を返す", () => {
		const first = [{ id: "1", content: "first", status: "pending" }]
		const last = [{ id: "2", content: "last", status: "pending" }]
		const messages = [
			msg({ type: "ask", ask: "tool", text: JSON.stringify({ tool: "updateTodoList", todos: first }) }),
			msg({ type: "ask", ask: "tool", text: JSON.stringify({ tool: "updateTodoList", todos: last }) }),
		]
		expect(getLatestTodo(messages)).toEqual(last)
	})

	it("壊れた JSON は無視される（catch → null）", () => {
		const messages = [msg({ type: "ask", ask: "tool", text: "{ not valid json" })]
		expect(getLatestTodo(messages)).toEqual([])
	})

	it("text 未設定なら '{}' として解釈され対象外", () => {
		const messages = [msg({ type: "ask", ask: "tool" })]
		expect(getLatestTodo(messages)).toEqual([])
	})

	it("別ツール名や todos 非配列は除外される", () => {
		const messages = [
			msg({ type: "ask", ask: "tool", text: JSON.stringify({ tool: "otherTool", todos: [] }) }),
			msg({ type: "ask", ask: "tool", text: JSON.stringify({ tool: "updateTodoList", todos: "nope" }) }),
		]
		expect(getLatestTodo(messages)).toEqual([])
	})

	it("該当メッセージが無ければ空配列", () => {
		const messages = [msg({ type: "say", say: "text", text: "hello" })]
		expect(getLatestTodo(messages)).toEqual([])
	})
})
