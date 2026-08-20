// npx vitest run core/task/__tests__/mergeConsecutiveApiMessages.spec.ts

import { mergeConsecutiveApiMessages } from "../mergeConsecutiveApiMessages"

describe("mergeConsecutiveApiMessages", () => {
	it("merges consecutive user messages by default", () => {
		const merged = mergeConsecutiveApiMessages([
			{ type: "message", role: "user", content: "A", ts: 1 },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "B" }], ts: 2 },
			{ type: "message", role: "assistant", content: "C", ts: 3 },
		])

		expect(merged).toHaveLength(2)
		expect(asMsg(merged[0]).role).toBe("user")
		expect(asMsg(merged[0]).content).toEqual([
			{ type: "input_text", text: "A" },
			{ type: "input_text", text: "B" },
		])
		expect(asMsg(merged[1]).role).toBe("assistant")
	})

	it("merges regular user message into a summary (API shaping only)", () => {
		const merged = mergeConsecutiveApiMessages([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary" }],
				ts: 1,
				isSummary: true,
				condenseId: "s",
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "After" }], ts: 2 },
		])

		expect(merged).toHaveLength(1)
		expect(asMsg(merged[0]).isSummary).toBe(true)
		expect(asMsg(merged[0]).content).toEqual([
			{ type: "input_text", text: "Summary" },
			{ type: "input_text", text: "After" },
		])
	})

	it("ts が両方欠けていてもマージでき、ts は undefined のまま落ちる", () => {
		// 48 行目の `Math.max(prev.ts ?? 0, msg.ts ?? 0) || prev.ts || msg.ts` の
		// 既定側（?? 0）と両フォールバック（|| prev.ts || msg.ts）を踏ませる。
		const merged = mergeConsecutiveApiMessages([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "A" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "B" }] },
		])

		expect(merged).toHaveLength(1)
		expect(asMsg(merged[0]).content).toEqual([
			{ type: "input_text", text: "A" },
			{ type: "input_text", text: "B" },
		])
		expect(asMsg(merged[0]).ts).toBeUndefined()
	})

	it("does not merge a summary into a preceding message", () => {
		const merged = mergeConsecutiveApiMessages([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Before" }], ts: 1 },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Summary" }],
				ts: 2,
				isSummary: true,
				condenseId: "s",
			},
		])

		expect(merged).toHaveLength(2)
		expect(asMsg(merged[0]).isSummary).toBeUndefined()
		expect(asMsg(merged[1]).isSummary).toBe(true)
	})
})

/** テスト用: item を message item として narrow する（型アサーションのみ）。 */
function asMsg(item: unknown): { role: string; content: any; [k: string]: any } {
	return item as { role: string; content: any; [k: string]: any }
}
