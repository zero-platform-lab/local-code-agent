// npx vitest run core/task-persistence/__tests__/migrateUpstreamHistory.spec.ts
//
// 上流 Roo Code 時代に保存されえた履歴の「実形」を通しで移行する。
//
// migrateLegacyApiMessages.spec.ts はブロック種別ごとの単体検証。こちらは
// 「1 本の履歴に全部入っている」状態を再現して、順序・メタ・orphan の有無まで見る。
// 我々が既に削除した機能（reasoning_details / thoughtSignature）が混ざった履歴でも
// 壊れないことが要点。

import { describe, it, expect } from "vitest"

import { getEffectiveApiHistory } from "../../condense"
import { buildCleanConversationHistory } from "../../task/buildCleanConversationHistory"
import { migrateLegacyApiMessages } from "../migrateLegacyApiMessages"

/** 上流時代の履歴。削除済み機能のブロックも混ぜてある。 */
const upstreamHistory = [
	{ role: "user", content: [{ type: "text", text: "タスク開始" }], ts: 1 },
	{
		role: "assistant",
		ts: 2,
		// OpenRouter / Gemini 3 の独自拡張。#343 で扱いを削除した
		reasoning_details: [{ type: "reasoning.encrypted", id: "rs_x", data: "OPAQUE" }],
		content: [
			{ type: "reasoning", text: "考えている", summary: [] },
			{ type: "text", text: "ファイルを読みます" },
			{ type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "a.txt" } },
			// Gemini 3 の署名。#346 で生成側ごと削除した
			{ type: "thoughtSignature", thoughtSignature: "sigG" },
		],
	},
	{
		role: "user",
		ts: 3,
		content: [
			{
				type: "tool_result",
				tool_use_id: "toolu_01",
				content: [
					{ type: "text", text: "ファイル本文" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "IMG" } },
				],
			},
			{ type: "text", text: "<environment_details>env</environment_details>" },
		],
	},
	{
		role: "assistant",
		ts: 4,
		content: [
			{ type: "reasoning", encrypted_content: "BLOB-OLD", summary: ["s"], id: "rs_old" },
			{ type: "text", text: "答えます" },
		],
	},
	// condense の並び: 圧縮対象が先、サマリが最後
	{ role: "user", content: "圧縮済み", ts: 5, condenseParent: "cond-1" },
	{ role: "user", content: "サマリ", ts: 6, isSummary: true, condenseId: "cond-1" },
]

describe("上流 Roo Code 時代の履歴の移行", () => {
	const migrated = migrateLegacyApiMessages(upstreamHistory)

	it("item 列の並びと内容", () => {
		expect(migrated).toEqual([
			{ type: "message", role: "user", content: "タスク開始", ts: 1 },
			// 平文 reasoning は Responses item にできないので本文の先頭に畳む
			{ type: "message", role: "assistant", content: "考えている\nファイルを読みます", ts: 2 },
			{
				type: "function_call",
				call_id: "toolu_01",
				name: "read_file",
				arguments: JSON.stringify({ path: "a.txt" }),
				ts: 2,
			},
			// tool_result の配列 content は文字列に潰す（画像はマーカー）
			{ type: "function_call_output", call_id: "toolu_01", output: "ファイル本文\n[image]", ts: 3 },
			{ type: "message", role: "user", content: "<environment_details>env</environment_details>", ts: 3 },
			// 暗号化 reasoning は本文より前の独立 item
			{ type: "reasoning", encrypted_content: "BLOB-OLD", summary: ["s"], id: "rs_old", ts: 4 },
			{ type: "message", role: "assistant", content: "答えます", ts: 4 },
			{ type: "message", role: "user", content: "圧縮済み", ts: 5, condenseParent: "cond-1" },
			{ type: "message", role: "user", content: "サマリ", ts: 6, isSummary: true, condenseId: "cond-1" },
		])
	})

	it("削除済み機能のブロックは落ちるが、他を巻き込まない", () => {
		const json = JSON.stringify(migrated)
		expect(json).not.toContain("thoughtSignature")
		expect(json).not.toContain("reasoning_details")
		expect(json).not.toContain("OPAQUE")
		// 同じメッセージにあった本文と tool 呼び出しは残っている
		expect(json).toContain("ファイルを読みます")
		expect(json).toContain("toolu_01")
	})

	it("condense のメタが効き、送信形が壊れない", () => {
		const effective = getEffectiveApiHistory(migrated)
		// condenseParent の付いたものはサマリに置き換わって送られない
		expect(effective.some((m) => m.condenseParent)).toBe(false)

		const sent = buildCleanConversationHistory(effective)
		for (const item of sent) expect("ts" in (item as unknown as Record<string, unknown>)).toBe(false)

		const calls = new Set(
			sent.filter((i) => i.type === "function_call").map((i) => (i as { call_id: string }).call_id),
		)
		for (const out of sent.filter((i) => i.type === "function_call_output")) {
			expect(calls.has((out as { call_id: string }).call_id)).toBe(true)
		}
	})
})
