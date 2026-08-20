// npx vitest run core/task/__tests__/buildRequestHistory.spec.ts
//
// 保存済み履歴 → 送信 item 列のパイプライン。
//
// 動機:
//   これは attemptApiRequest（714 行）の中に直列で並んでいた 5 段で、
//   段の順序に意味があるのに誰も通しで検証していなかった。orchestrator は
//   Task.ts から質量ごと切り出されたもので、中身の複雑さは持ち越されたまま。
//   純粋な変換であるこの部分だけを切り出してテストを当てる。

import { describe, it, expect, vi } from "vitest"

import type { ApiHandler } from "../../../api"
import type { ApiMessage } from "../../task-persistence"
import { buildRequestHistory } from "../buildRequestHistory"

const handler = (supportsImages: boolean): ApiHandler =>
	({
		getModel: vi.fn(() => ({
			id: "m",
			info: { supportsImages, contextWindow: 128000, supportsPromptCache: false },
		})),
		createMessage: vi.fn(),
		countTokens: vi.fn(),
	}) as unknown as ApiHandler

describe("buildRequestHistory", () => {
	it("condense で隠された item を送らない", () => {
		const history: ApiMessage[] = [
			{ type: "message", role: "user", content: "古い", ts: 1, condenseParent: "c1" },
			{ type: "message", role: "user", content: "サマリ", ts: 2, isSummary: true, condenseId: "c1" },
			{ type: "message", role: "assistant", content: "続き", ts: 3 },
		]
		const sent = buildRequestHistory(history, handler(true))

		expect(sent.map((i) => (i.type === "message" ? i.content : i.type))).toEqual(["サマリ", "続き"])
	})

	it("truncation で隠された item を送らない", () => {
		const history: ApiMessage[] = [
			{ type: "message", role: "user", content: "残す", ts: 1 },
			{ type: "message", role: "user", content: "隠す", ts: 2, truncationParent: "t1" },
			{
				type: "message",
				role: "user",
				content: "[marker]",
				ts: 3,
				isTruncationMarker: true,
				truncationId: "t1",
			},
		]
		const sent = buildRequestHistory(history, handler(true))
		expect(JSON.stringify(sent)).not.toContain("隠す")
	})

	it("連続 user はまとめるが、保存側の配列は壊さない", () => {
		const history: ApiMessage[] = [
			{ type: "message", role: "user", content: "A", ts: 1 },
			{ type: "message", role: "user", content: "B", ts: 2 },
			{ type: "message", role: "assistant", content: "C", ts: 3 },
		]
		const snapshot = JSON.stringify(history)

		const sent = buildRequestHistory(history, handler(true))

		expect(sent).toHaveLength(2)
		expect(sent[0]).toEqual({
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "A" },
				{ type: "input_text", text: "B" },
			],
		})
		// rewind が元 item を参照し続けられるよう、保存側は非破壊でなければならない
		expect(JSON.stringify(history)).toBe(snapshot)
	})

	it("assistant の連続はまとめない（roles は user だけ）", () => {
		const sent = buildRequestHistory(
			[
				{ type: "message", role: "assistant", content: "A", ts: 1 },
				{ type: "message", role: "assistant", content: "B", ts: 2 },
			],
			handler(true),
		)
		expect(sent).toHaveLength(2)
	})

	it("画像を扱えないモデルではプレースホルダに置き換える", () => {
		const history: ApiMessage[] = [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "これは？" },
					{ type: "input_image", image_url: "data:image/png;base64,AAA" },
				],
				ts: 1,
			},
		]

		const withImages = buildRequestHistory(history, handler(true))
		expect(JSON.stringify(withImages)).toContain("data:image/png;base64,AAA")

		const withoutImages = buildRequestHistory(history, handler(false))
		expect(JSON.stringify(withoutImages)).not.toContain("base64")
		expect(JSON.stringify(withoutImages)).toContain("[Referenced image in conversation]")
	})

	it("マージで配列化された content の画像も置き換わる（段の順序が効いている）", () => {
		// merge → image 除去 の順でないと、結合で配列になった側の画像を取りこぼす
		const history: ApiMessage[] = [
			{ type: "message", role: "user", content: "先", ts: 1 },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_image", image_url: "data:image/png;base64,BBB" }],
				ts: 2,
			},
		]
		const sent = buildRequestHistory(history, handler(false))
		expect(JSON.stringify(sent)).not.toContain("base64")
		expect(JSON.stringify(sent)).toContain("[Referenced image in conversation]")
	})

	it("拡張独自のメタデータを送らない", () => {
		const sent = buildRequestHistory(
			[{ type: "message", role: "user", content: "hi", ts: 1, isSummary: true, condenseId: "c" }],
			handler(true),
		)
		for (const item of sent) {
			for (const key of ["ts", "isSummary", "condenseId", "condenseParent", "truncationId"]) {
				expect(key in (item as unknown as Record<string, unknown>)).toBe(false)
			}
		}
	})

	it("暗号化 reasoning は送り、平文 reasoning は落とす", () => {
		const sent = buildRequestHistory(
			[
				{ type: "message", role: "user", content: "hi", ts: 1 },
				{ type: "reasoning", encrypted_content: "BLOB", id: "r1", ts: 2 },
				{ type: "reasoning", summary: ["plain"], ts: 3 },
				{ type: "message", role: "assistant", content: "a", ts: 4 },
			],
			handler(true),
		)
		expect(sent.filter((i) => i.type === "reasoning")).toEqual([
			{ type: "reasoning", encrypted_content: "BLOB", id: "r1" },
		])
	})

	it("tool ペアは崩れない", () => {
		const sent = buildRequestHistory(
			[
				{ type: "message", role: "user", content: "task", ts: 1 },
				{ type: "function_call", call_id: "c1", name: "read_file", arguments: "{}", ts: 2 },
				{ type: "function_call_output", call_id: "c1", output: "body", ts: 3 },
			],
			handler(true),
		)
		const calls = new Set(
			sent.filter((i) => i.type === "function_call").map((i) => (i as { call_id: string }).call_id),
		)
		for (const out of sent.filter((i) => i.type === "function_call_output")) {
			expect(calls.has((out as { call_id: string }).call_id)).toBe(true)
		}
	})

	it("空履歴でも落ちない", () => {
		expect(buildRequestHistory([], handler(true))).toEqual([])
	})
})
