// npx vitest run api/providers/__tests__/chatCompletionsInvariants.spec.ts
//
// Chat Completions の **送信 body そのもの** が満たすべき条件を検証する。
//
// 動機:
//   agentMessagesToChatCompletion は実際に API に渡す messages を組み立てる関数だが、
//   直接のテストが 1 件も無かった。実機検証で orphan な tool メッセージが現れたのは
//   まさにこの関数の出力で、item 列側の不変条件テストだけでは届かない層。
//
//   OpenAI の制約:
//   - role:"tool" は、先行する assistant.tool_calls のいずれかに対応していなければならない
//   - assistant.tool_calls は、次の assistant ターンまでに全部応答されている必要がある
//   破ると 400。互換サーバによっては黙って無視されて挙動が壊れる。

import { describe, it, expect, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: () => undefined }) },
}))

import type { AgentMessage } from "@openai-agent/types"

import { OpenAiHandler } from "../openai"

type ChatMessage = {
	role: string
	content?: unknown
	tool_calls?: Array<{ id: string }>
	tool_call_id?: string
}

const convert = (messages: AgentMessage[]): ChatMessage[] => {
	const handler = new OpenAiHandler({
		openAiBaseUrl: "http://127.0.0.1:1/v1",
		openAiApiKey: "k",
		openAiModelId: "gpt-4o",
	}) as unknown as { agentMessagesToChatCompletion: (m: AgentMessage[]) => ChatMessage[] }
	return handler.agentMessagesToChatCompletion(messages)
}

function assertValidChatBody(msgs: ChatMessage[], label: string) {
	const announced = new Set<string>()
	const pendingCalls = new Set<string>()

	for (const m of msgs) {
		if (m.role === "assistant") {
			// 前の assistant ターンの呼び出しが未応答のまま次の assistant に進んでいないか
			expect([...pendingCalls], `${label}: 未応答の tool_calls を残したまま次の assistant`).toEqual([])
			for (const tc of m.tool_calls ?? []) {
				announced.add(tc.id)
				pendingCalls.add(tc.id)
			}
			// tool_calls を持つなら空配列ではない
			if ("tool_calls" in m) expect((m.tool_calls ?? []).length, `${label}: 空の tool_calls`).toBeGreaterThan(0)
		}

		if (m.role === "tool") {
			const id = m.tool_call_id as string
			expect(announced.has(id), `${label}: orphan な tool メッセージ (${id})`).toBe(true)
			pendingCalls.delete(id)
			// tool メッセージの content は文字列でなければならない
			expect(typeof m.content, `${label}: tool.content が文字列でない`).toBe("string")
		}
	}

	expect([...pendingCalls], `${label}: 末尾に未応答の tool_calls が残っている`).toEqual([])
}

/** tool ペア入りの item 列。env details を挟むのは実際の履歴と同じ形。 */
function makeItems(pairs: number): AgentMessage[] {
	const out: AgentMessage[] = [{ type: "message", role: "user", content: "task" }]
	for (let i = 1; i <= pairs; i++) {
		out.push({ type: "function_call", call_id: `c${i}`, name: "read_file", arguments: "{}" })
		out.push({ type: "function_call_output", call_id: `c${i}`, output: "body" })
		out.push({ type: "message", role: "user", content: "<environment_details>" })
	}
	return out
}

describe("Chat Completions 送信 body の不変条件", () => {
	for (const pairs of [1, 2, 3, 5]) {
		it(`tool ペア ${pairs} 組をそのまま変換`, () => {
			assertValidChatBody(convert(makeItems(pairs)), `pairs=${pairs}`)
		})
	}

	it("同一 assistant ターンの複数呼び出しは 1 メッセージに束ね、全部に応答が付く", () => {
		const items: AgentMessage[] = [
			{ type: "message", role: "user", content: "task" },
			{ type: "function_call", call_id: "a", name: "read_file", arguments: "{}" },
			{ type: "function_call", call_id: "b", name: "list_files", arguments: "{}" },
			{ type: "function_call_output", call_id: "a", output: "A" },
			{ type: "function_call_output", call_id: "b", output: "B" },
		]
		const msgs = convert(items)
		assertValidChatBody(msgs, "parallel calls")

		const assistant = msgs.find((m) => m.role === "assistant")
		expect(assistant?.tool_calls?.map((t) => t.id)).toEqual(["a", "b"])
	})

	it("reasoning item は Chat Completions では落とす", () => {
		const msgs = convert([
			{ type: "message", role: "user", content: "hi" },
			{ type: "reasoning", encrypted_content: "BLOB" },
			{ type: "message", role: "assistant", content: "answer" },
		])
		assertValidChatBody(msgs, "reasoning")
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
	})

	it("developer / system role は system に寄せる", () => {
		const msgs = convert([
			{ type: "message", role: "developer", content: "dev" },
			{ type: "message", role: "system", content: "sys" },
			{ type: "message", role: "user", content: "hi" },
		])
		expect(msgs.map((m) => m.role)).toEqual(["system", "system", "user"])
	})

	it("orphan が入力に混ざれば不正な body になる（責任境界の確認）", () => {
		// この関数は item 列を忠実に変換するだけなので、orphan の除去は上流の責務。
		// ここでは「検出器が空振りしていない」ことと、責任境界を明示しておく。
		const msgs = convert([
			{ type: "message", role: "user", content: "hi" },
			// 対応する function_call が無い応答
			{ type: "function_call_output", call_id: "ghost", output: "x" },
		])
		expect(msgs.some((m) => m.role === "tool" && m.tool_call_id === "ghost")).toBe(true)
		expect(() => assertValidChatBody(msgs, "orphan probe")).toThrow()
	})

	it("未応答の呼び出しを残したまま次の assistant に進めば検出される", () => {
		const msgs = convert([
			{ type: "message", role: "user", content: "hi" },
			{ type: "function_call", call_id: "a", name: "read_file", arguments: "{}" },
			// 応答を返さずに次の assistant 本文へ
			{ type: "message", role: "assistant", content: "next" },
		])
		expect(() => assertValidChatBody(msgs, "unanswered probe")).toThrow()
	})

	it("画像パートは image_url に変換される", () => {
		const msgs = convert([
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "これは？" },
					{ type: "input_image", image_url: "data:image/png;base64,AAA" },
				],
			},
		])
		expect(msgs[0].content).toEqual([
			{ type: "text", text: "これは？" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: undefined } },
		])
	})
})
