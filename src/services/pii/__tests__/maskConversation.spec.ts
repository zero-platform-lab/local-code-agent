// npx vitest run services/pii/__tests__/maskConversation.spec.ts
//
// 会話の全体を伏せる層。
//
// 固定するのは 3 点。
//   1. **同じ値へ同じ伏せ字**が当たること。item ごとに振り直すと、モデルは別人だと読む
//   2. **元の item を壊さない**こと。送る写しだけを変える
//   3. 暗号化された reasoning に触らないこと

import type { AgentMessage } from "@openai-agent/types"

import { PiiVault, maskConversation } from "../maskConversation"

const message = (role: "user" | "assistant", content: string): AgentMessage =>
	({ type: "message", role, content }) as AgentMessage

describe("maskConversation", () => {
	it("指示と応答と道具の出力をまとめて伏せる", () => {
		const messages: AgentMessage[] = [
			message("user", "taro@corp.example へ送って"),
			{ type: "function_call", call_id: "1", name: "read_file", arguments: '{"path":"note.md"}' } as AgentMessage,
			{ type: "function_call_output", call_id: "1", output: "連絡先: taro@corp.example" } as AgentMessage,
		]

		const result = maskConversation("あなたは助手です", messages, { kinds: ["email"] })

		expect(result.messages[0]).toMatchObject({ content: "{{email-001}} へ送って" })
		expect(result.messages[2]).toMatchObject({ output: "連絡先: {{email-001}}" })
		// 同じ値なので同じ伏せ字になる。別の番号だとモデルは別人だと読む。
		expect(result.counts).toEqual({ email: 2 })
	})

	it("元の item を書き換えない", () => {
		const messages: AgentMessage[] = [message("user", "taro@corp.example")]

		maskConversation("", messages, { kinds: ["email"] })

		// 履歴は利用者が書いたままにする。送る写しだけを変える。
		expect(messages[0]).toMatchObject({ content: "taro@corp.example" })
	})

	it("システムプロンプトも伏せる", () => {
		const result = maskConversation("作業場所は 東京都渋谷区神南1-2-3", [], { kinds: ["address"] })

		expect(result.systemPrompt).toBe("作業場所は {{address-001}}")
	})

	it("content が配列でも伏せる。画像には触らない", () => {
		const messages: AgentMessage[] = [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "taro@corp.example" },
					{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
					{ type: "output_text", text: "hanako@corp.example" },
				],
			} as AgentMessage,
		]

		const result = maskConversation("", messages, { kinds: ["email"] })
		const content = (result.messages[0] as { content: { type: string; text?: string }[] }).content

		expect(content[0].text).toBe("{{email-001}}")
		expect(content[1]).toMatchObject({ image_url: "data:image/png;base64,AAAA" })
		expect(content[2].text).toBe("{{email-002}}")
	})

	it("JSON の引数を壊さない", () => {
		const messages: AgentMessage[] = [
			{
				type: "function_call",
				call_id: "1",
				name: "write_to_file",
				arguments: JSON.stringify({ path: "a.md", content: "連絡は taro@corp.example" }),
			} as AgentMessage,
		]

		const result = maskConversation("", messages, { kinds: ["email"] })
		const args = (result.messages[0] as { arguments: string }).arguments

		// 伏せ字は引用符も逆斜線も含まないので、JSON のままである。
		expect(JSON.parse(args)).toEqual({ path: "a.md", content: "連絡は {{email-001}}" })
	})

	it("暗号化された reasoning には触らない", () => {
		const messages: AgentMessage[] = [
			{ type: "reasoning", encrypted_content: "taro@corp.example に見える文字列" } as AgentMessage,
		]

		const result = maskConversation("", messages, { kinds: ["email"] })

		expect(result.messages[0]).toMatchObject({ encrypted_content: "taro@corp.example に見える文字列" })
	})

	it("伏せるものが無ければそのまま返す", () => {
		const messages: AgentMessage[] = [message("user", "ふつうの文章")]

		const result = maskConversation("指示", messages, { kinds: ["email"] })

		expect(result.systemPrompt).toBe("指示")
		expect(result.messages[0]).toMatchObject({ content: "ふつうの文章" })
		expect(result.counts).toEqual({})
	})

	it("区切りをまたいで置き換えない", () => {
		// 連結した本文で隣り合っても、別の item の文字列が 1 つの値として扱われては困る。
		const messages: AgentMessage[] = [message("user", "taro@corp"), message("assistant", "example.com")]

		const result = maskConversation("", messages, { kinds: ["email"] })

		expect(result.messages[0]).toMatchObject({ content: "taro@corp" })
		expect(result.messages[1]).toMatchObject({ content: "example.com" })
	})
})

describe("PiiVault", () => {
	it("割り当てを溜めて、戻せる（FR-PII-02a）", () => {
		const vault = new PiiVault()

		maskConversation("", [message("user", "taro@corp.example")], { kinds: ["email"] }, vault)

		expect(vault.size).toBe(1)
		expect(vault.restore("宛先は {{email-001}} です")).toBe("宛先は taro@corp.example です")
	})

	it("割り当てていない伏せ字には触らない（FR-PII-08a）", () => {
		const vault = new PiiVault()

		maskConversation("", [message("user", "taro@corp.example")], { kinds: ["email"] }, vault)

		expect(vault.restore("{{person-001}}")).toBe("{{person-001}}")
	})

	it("何も溜まっていなければ、そのまま返す", () => {
		expect(new PiiVault().restore("{{email-001}}")).toBe("{{email-001}}")
	})

	it("対応表を読めるが、ディスクへは書かない（FR-PII-02b）", () => {
		const vault = new PiiVault()

		maskConversation("", [message("user", "taro@corp.example")], { kinds: ["email"] }, vault)

		expect([...vault.entries.values()]).toEqual(["taro@corp.example"])
	})
})
