// npx vitest run src/components/chat/__tests__/chatRowTodos.spec.ts

import type { ClineMessage } from "@openai-agent/types"

import { getPreviousTodos } from "../chatRowTodos"

const todoAsk = (ts: number, todos: unknown): ClineMessage =>
	({ type: "ask", ask: "tool", ts, text: JSON.stringify({ tool: "updateTodoList", todos }) }) as ClineMessage

const otherAsk = (ts: number, tool: string): ClineMessage =>
	({ type: "ask", ask: "tool", ts, text: JSON.stringify({ tool, path: "a.ts" }) }) as ClineMessage

const say = (ts: number): ClineMessage => ({ type: "say", say: "text", ts, text: "hi" }) as ClineMessage

const TODOS_A = [{ id: "1", content: "first", status: "pending" }]
const TODOS_B = [{ id: "2", content: "second", status: "completed" }]

describe("getPreviousTodos", () => {
	it("returns an empty list when there is no earlier update", () => {
		expect(getPreviousTodos([todoAsk(100, TODOS_A)], 100)).toEqual([])
	})

	it("returns an empty list for an empty history", () => {
		expect(getPreviousTodos([], 100)).toEqual([])
	})

	it("finds the update immediately before the current message", () => {
		const messages = [todoAsk(10, TODOS_A), todoAsk(20, TODOS_B)]

		expect(getPreviousTodos(messages, 20)).toEqual(TODOS_A)
	})

	it("picks the most recent earlier update, not the oldest", () => {
		const messages = [todoAsk(10, TODOS_A), todoAsk(20, TODOS_B), todoAsk(30, [])]

		expect(getPreviousTodos(messages, 30)).toEqual(TODOS_B)
	})

	it("ignores updates at or after the current timestamp", () => {
		// 同じ ts は「前」に含めない。自分自身と比較すると差分が空になってしまう。
		const messages = [todoAsk(10, TODOS_A), todoAsk(20, TODOS_B), todoAsk(30, [])]

		expect(getPreviousTodos(messages, 20)).toEqual(TODOS_A)
	})

	it("skips other tool calls in between", () => {
		const messages = [todoAsk(10, TODOS_A), otherAsk(15, "readFile"), todoAsk(20, TODOS_B)]

		expect(getPreviousTodos(messages, 20)).toEqual(TODOS_A)
	})

	it("skips say messages in between", () => {
		const messages = [todoAsk(10, TODOS_A), say(15), todoAsk(20, TODOS_B)]

		expect(getPreviousTodos(messages, 20)).toEqual(TODOS_A)
	})

	it("ignores a tool ask for a different tool entirely", () => {
		expect(getPreviousTodos([otherAsk(10, "readFile")], 20)).toEqual([])
	})

	it("ignores a say that happens to mention updateTodoList", () => {
		const lookalike = {
			type: "say",
			say: "text",
			ts: 10,
			text: JSON.stringify({ tool: "updateTodoList", todos: TODOS_A }),
		} as ClineMessage

		expect(getPreviousTodos([lookalike], 20)).toEqual([])
	})

	it("returns an empty list when the earlier update has no todos field", () => {
		const noTodos = { type: "ask", ask: "tool", ts: 10, text: JSON.stringify({ tool: "updateTodoList" }) }

		expect(getPreviousTodos([noTodos as ClineMessage], 20)).toEqual([])
	})

	it("survives malformed JSON in a candidate message", () => {
		const broken = { type: "ask", ask: "tool", ts: 15, text: "{not json" } as ClineMessage
		const messages = [todoAsk(10, TODOS_A), broken]

		expect(getPreviousTodos(messages, 20)).toEqual(TODOS_A)
	})

	it("survives a missing text payload", () => {
		const noText = { type: "ask", ask: "tool", ts: 15 } as ClineMessage

		expect(getPreviousTodos([noText], 20)).toEqual([])
	})

	it("does not mutate or reorder the input", () => {
		const messages = [todoAsk(10, TODOS_A), todoAsk(20, TODOS_B)]
		const snapshot = [...messages]

		getPreviousTodos(messages, 30)

		expect(messages).toEqual(snapshot)
		expect(messages[0].ts).toBe(10)
	})
})
