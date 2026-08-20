import { describe, it, expect } from "vitest"

import type { ApiMessage } from "../../task-persistence"
import { messageToAgentItems } from "../../task-persistence/migrateLegacyApiMessages"
import { buildCleanConversationHistory } from "../buildCleanConversationHistory"

const run = (messages: ApiMessage[], preserve = false) => buildCleanConversationHistory(messages, preserve)

// 会話履歴自体が AgentMessage（Responses item 列）になったので、この関数は
// 「Anthropic 形式 → item 列」の変換ではなく、送信直前の**フィルタ**になった。
// 残る仕事は (1) 拡張独自メタデータを落とす (2) 送れない reasoning を捨てる の 2 つだけ。
describe("buildCleanConversationHistory", () => {
	it("message item は content をそのままに、拡張独自メタデータだけ落とす", () => {
		const out = run([
			{
				type: "message",
				role: "user",
				content: "hi",
				ts: 1,
				isSummary: true,
				condenseId: "c1",
				truncationParent: "t1",
			},
		])
		expect(out).toEqual([{ type: "message", role: "user", content: "hi" }])
	})

	it("content パート配列は加工せずそのまま通す", () => {
		const content = [
			{ type: "input_text" as const, text: "これは？" },
			{ type: "input_image" as const, image_url: "data:image/png;base64,AAA" },
		]
		const out = run([{ type: "message", role: "user", content, ts: 2 }])
		expect(out).toEqual([{ type: "message", role: "user", content }])
	})

	it("function_call / function_call_output もメタを落として通す", () => {
		const out = run([
			{
				type: "function_call",
				call_id: "t1",
				name: "read_file",
				arguments: JSON.stringify({ path: "a" }),
				ts: 3,
				// `id` は AgentMessageMeta と同じキーなのでメタ扱いで落ちる（送信には不要）
				id: "fc_1",
			},
			{ type: "function_call_output", call_id: "t1", output: "file body", ts: 4 },
		])
		expect(out).toEqual([
			{ type: "function_call", call_id: "t1", name: "read_file", arguments: JSON.stringify({ path: "a" }) },
			{ type: "function_call_output", call_id: "t1", output: "file body" },
		])
	})

	it("reasoning: encrypted_content があり preserveReasoning=true なら summary/id ごと送る", () => {
		const out = run([{ type: "reasoning", encrypted_content: "enc", summary: ["s"], id: "r1", ts: 5 }], true)
		expect(out).toEqual([{ type: "reasoning", encrypted_content: "enc", summary: ["s"], id: "r1" }])
	})

	it("reasoning: summary 未指定なら summary キー自体を足さない", () => {
		const out = run([{ type: "reasoning", encrypted_content: "enc" }], true)
		expect(out).toEqual([{ type: "reasoning", encrypted_content: "enc" }])
		expect("summary" in out[0]).toBe(false)
	})

	it("reasoning: preserveReasoning=false なら暗号化済みでも送らない", () => {
		const out = run([{ type: "reasoning", encrypted_content: "enc", id: "r1" }], false)
		expect(out).toEqual([])
	})

	it("reasoning: encrypted_content が無ければ preserveReasoning=true でも捨てる", () => {
		// Responses API は暗号化された reasoning しか受け付けない
		const out = run([{ type: "reasoning", summary: ["s"], id: "r1" }], true)
		expect(out).toEqual([])
	})

	it("reasoning を捨てても前後の item の順序は保たれる", () => {
		const out = run(
			[
				{ type: "message", role: "user", content: "q", ts: 1 },
				{ type: "reasoning", summary: [], ts: 2 },
				{ type: "message", role: "assistant", content: "a", ts: 3 },
			],
			true,
		)
		expect(out).toEqual([
			{ type: "message", role: "user", content: "q" },
			{ type: "message", role: "assistant", content: "a" },
		])
	})

	it("preserveReasoning は reasoning 以外の item に影響しない", () => {
		const history: ApiMessage[] = [
			{ type: "message", role: "assistant", content: "answer", ts: 1 },
			{ type: "function_call", call_id: "t1", name: "read_file", arguments: "{}", ts: 1 },
			{ type: "function_call_output", call_id: "t1", output: "body", ts: 2 },
		]
		expect(run(history, true)).toEqual(run(history, false))
	})

	it("元の配列と item を破壊しない", () => {
		const item: ApiMessage = { type: "message", role: "user", content: "hi", ts: 1 }
		const history = [item]
		run(history, true)
		expect(history).toEqual([{ type: "message", role: "user", content: "hi", ts: 1 }])
		expect(item.ts).toBe(1)
	})
})

// 旧形式（Anthropic の `{role, content}`）は読み込み時に messageToAgentItems で item 列へ
// 落ちる。その結果がこのフィルタを素通りできることを、経路として 1 本だけ確認する。
describe("buildCleanConversationHistory - 旧形式から移行した履歴", () => {
	it("image は input_image (data URL) のまま送信形に残る", () => {
		const migrated = messageToAgentItems(
			"user",
			[
				{ type: "text", text: "これは？" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
			],
			{ ts: 1 },
		)

		expect(run(migrated)).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "これは？" },
					{ type: "input_image", image_url: "data:image/png;base64,AAA" },
				],
			},
		])
	})

	it("tool_use / tool_result は独立 item のまま送信形に残る", () => {
		const assistant = messageToAgentItems(
			"assistant",
			[
				{ type: "text", text: "call tool" },
				{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
			],
			{ ts: 1 },
		)
		const user = messageToAgentItems("user", [{ type: "tool_result", tool_use_id: "t1", content: "file body" }], {
			ts: 2,
		})

		expect(run([...assistant, ...user])).toEqual([
			{ type: "message", role: "assistant", content: "call tool" },
			{
				type: "function_call",
				call_id: "t1",
				name: "read_file",
				arguments: JSON.stringify({ path: "a" }),
			},
			{ type: "function_call_output", call_id: "t1", output: "file body" },
		])
	})
})
