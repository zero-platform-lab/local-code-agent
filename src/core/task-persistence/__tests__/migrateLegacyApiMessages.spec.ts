// npx vitest run core/task-persistence/__tests__/migrateLegacyApiMessages.spec.ts
//
// 旧形式（Anthropic ベースの {role, content} メッセージ列）で保存された会話履歴を
// item 列へ変換する経路のテスト。**唯一ユーザーの保存データに触る部分**なので、
// 取りこぼし（画像・tool 呼び出し・condense/truncation のメタ）が無いことを固める。

import { describe, it, expect } from "vitest"

import { migrateLegacyApiMessages, messageToAgentItems } from "../migrateLegacyApiMessages"

describe("migrateLegacyApiMessages", () => {
	it("新形式（item 列）はそのまま返す", () => {
		const items = [
			{ type: "message" as const, role: "user" as const, content: "hi", ts: 1 },
			{ type: "function_call" as const, call_id: "c1", name: "read_file", arguments: "{}" },
		]
		expect(migrateLegacyApiMessages(items)).toBe(items)
	})

	it("文字列 content の旧メッセージを message item にする", () => {
		expect(migrateLegacyApiMessages([{ role: "user", content: "hi", ts: 5 }])).toEqual([
			{ type: "message", role: "user", content: "hi", ts: 5 },
		])
	})

	it("text ブロックは連結して 1 つの message item にする", () => {
		expect(
			migrateLegacyApiMessages([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
			]),
		).toEqual([{ type: "message", role: "assistant", content: "a\nb" }])
	})

	it("画像は input_image の data URL として残す（#344 の drop 回帰を防ぐ）", () => {
		expect(
			migrateLegacyApiMessages([
				{
					role: "user",
					content: [
						{ type: "text", text: "これは？" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
					],
				},
			]),
		).toEqual([
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

	it("tool_use / tool_result は独立 item に割る", () => {
		expect(
			migrateLegacyApiMessages([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "呼ぶ" },
						{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "body" }] },
			]),
		).toEqual([
			{ type: "message", role: "assistant", content: "呼ぶ" },
			{ type: "function_call", call_id: "t1", name: "read_file", arguments: JSON.stringify({ path: "a" }) },
			{ type: "function_call_output", call_id: "t1", output: "body" },
		])
	})

	it("tool_result の配列 content は文字列化する", () => {
		expect(
			migrateLegacyApiMessages([
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [
								{ type: "text", text: "one" },
								{ type: "image", source: { type: "base64", media_type: "image/png", data: "X" } },
							],
						},
					],
				},
			]),
		).toEqual([{ type: "function_call_output", call_id: "t1", output: "one\n[image]" }])
	})

	it("content 配列に埋め込まれていた暗号化 reasoning を独立 item に切り出す", () => {
		expect(
			migrateLegacyApiMessages([
				{
					role: "assistant",
					content: [
						{ type: "reasoning", encrypted_content: "ENC", summary: ["s"], id: "r1" },
						{ type: "text", text: "answer" },
					],
				},
			]),
		).toEqual([
			{ type: "reasoning", encrypted_content: "ENC", summary: ["s"], id: "r1" },
			{ type: "message", role: "assistant", content: "answer" },
		])
	})

	it("平文 reasoning は本文に畳む（Responses item にできないため）", () => {
		expect(
			migrateLegacyApiMessages([
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "thinking" },
						{ type: "text", text: "answer" },
					],
				},
			]),
		).toEqual([{ type: "message", role: "assistant", content: "thinking\nanswer" }])
	})

	it("単独 reasoning は encrypted_content があるものだけ残す", () => {
		expect(
			migrateLegacyApiMessages([
				{ type: "reasoning", encrypted_content: "ENC" },
				{ type: "reasoning", text: "plain" },
				{ role: "user", content: "hi" },
			]),
		).toEqual([
			{ type: "reasoning", encrypted_content: "ENC" },
			{ type: "message", role: "user", content: "hi" },
		])
	})

	it("メタデータは割れた全 item に複製する（condense / truncation のフィルタを保つ）", () => {
		const out = migrateLegacyApiMessages([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "本文" },
					{ type: "tool_use", id: "t1", name: "n", input: {} },
				],
				ts: 100,
				condenseParent: "cid",
				truncationParent: "tid",
			},
		])

		expect(out).toHaveLength(2)
		for (const item of out) {
			expect(item.ts).toBe(100)
			expect(item.condenseParent).toBe("cid")
			expect(item.truncationParent).toBe("tid")
		}
	})

	it("サマリ・切り詰めマーカーのメタを保つ", () => {
		expect(
			migrateLegacyApiMessages([
				{ role: "user", content: "summary", isSummary: true, condenseId: "c1", ts: 1 },
				{ role: "user", content: "marker", isTruncationMarker: true, truncationId: "t1", ts: 2 },
			]),
		).toEqual([
			{ type: "message", role: "user", content: "summary", isSummary: true, condenseId: "c1", ts: 1 },
			{
				type: "message",
				role: "user",
				content: "marker",
				isTruncationMarker: true,
				truncationId: "t1",
				ts: 2,
			},
		])
	})

	it("role の無い / 壊れた要素は落とす", () => {
		expect(
			migrateLegacyApiMessages([{ content: "orphan" }, null, "junk", { role: "system", content: "x" }]),
		).toEqual([])
	})

	it("新旧が混在していても両方扱える", () => {
		const out = migrateLegacyApiMessages([
			{ type: "message", role: "user", content: "new" },
			{ role: "assistant", content: "old" },
		])
		expect(out).toEqual([
			{ type: "message", role: "user", content: "new" },
			{ type: "message", role: "assistant", content: "old" },
		])
	})
})

describe("messageToAgentItems", () => {
	it("content 無しなら何も出さない", () => {
		expect(messageToAgentItems("user", undefined)).toEqual([])
	})

	it("空配列なら何も出さない", () => {
		expect(messageToAgentItems("user", [])).toEqual([])
	})

	it("tool_result の前で本文を切り出す", () => {
		expect(
			messageToAgentItems("user", [
				{ type: "text", text: "先に本文" },
				{ type: "tool_result", tool_use_id: "t1", content: "r" },
				{ type: "text", text: "後の本文" },
			]),
		).toEqual([
			{ type: "message", role: "user", content: "先に本文" },
			{ type: "function_call_output", call_id: "t1", output: "r" },
			{ type: "message", role: "user", content: "後の本文" },
		])
	})

	it("url ソースの画像はその URL を使う", () => {
		expect(
			messageToAgentItems("user", [{ type: "image", source: { type: "url", url: "https://x/y.png" } }]),
		).toEqual([{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://x/y.png" }] }])
	})
})

// ---------------------------------------------------------------------------
// 追加分：未到達だった防御的分岐を埋める。挙動を固定して回帰を防ぐ。
// ---------------------------------------------------------------------------
describe("migrateLegacyApiMessages（分岐の補完）", () => {
	it("混在配列で role を持たない新形式 item はそのまま素通しする", () => {
		// function_call は type を持ち role を持たない新形式 item。旧形式が 1 件混じって
		// migration が走っても、これは変換せず素通しする（混在履歴の保険）。
		const out = migrateLegacyApiMessages([
			{ type: "function_call", call_id: "c1", name: "n", arguments: "{}" },
			{ role: "user", content: "旧" },
		])
		expect(out).toEqual([
			{ type: "function_call", call_id: "c1", name: "n", arguments: "{}" },
			{ type: "message", role: "user", content: "旧" },
		])
	})

	it("単独 reasoning に summary 配列があれば保持する", () => {
		const out = migrateLegacyApiMessages([
			{ type: "reasoning", encrypted_content: "ENC", summary: ["s1", "s2"] },
			{ role: "user", content: "hi" },
		])
		expect(out).toEqual([
			{ type: "reasoning", encrypted_content: "ENC", summary: ["s1", "s2"] },
			{ type: "message", role: "user", content: "hi" },
		])
	})

	it("旧メッセージの文字列 id をメタとして item に載せる", () => {
		const out = migrateLegacyApiMessages([{ role: "user", content: "hi", id: "m1" }])
		expect(out).toEqual([{ type: "message", role: "user", content: "hi", id: "m1" }])
	})

	it("content 配列内の null / 非オブジェクト要素は飛ばす", () => {
		const out = migrateLegacyApiMessages([
			{ role: "user", content: [null, "junk", { type: "text", text: "本文" }] as never },
		])
		expect(out).toEqual([{ type: "message", role: "user", content: "本文" }])
	})

	it("input の無い tool_use は arguments を空オブジェクトにする", () => {
		const out = migrateLegacyApiMessages([
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "noop" }] as never },
		])
		expect(out).toEqual([{ type: "function_call", call_id: "t1", name: "noop", arguments: "{}" }])
	})

	it("content 配列内の暗号化 reasoning は summary / id が無くても切り出す", () => {
		const out = migrateLegacyApiMessages([
			{
				role: "assistant",
				content: [
					{ type: "reasoning", encrypted_content: "E2" },
					{ type: "text", text: "ans" },
				] as never,
			},
		])
		expect(out).toEqual([
			{ type: "reasoning", encrypted_content: "E2" },
			{ type: "message", role: "assistant", content: "ans" },
		])
	})

	it("source の無い image は落とす", () => {
		const out = migrateLegacyApiMessages([
			{ role: "user", content: [{ type: "image" }, { type: "text", text: "後" }] as never },
		])
		expect(out).toEqual([{ type: "message", role: "user", content: "後" }])
	})

	it("data の無い base64 image は落とす", () => {
		const out = migrateLegacyApiMessages([
			{
				role: "user",
				content: [
					{ type: "image", source: { type: "base64", media_type: "image/png" } },
					{ type: "text", text: "x" },
				] as never,
			},
		])
		expect(out).toEqual([{ type: "message", role: "user", content: "x" }])
	})

	it("tool_result の content が文字列でも配列でもなければ空文字にする", () => {
		const out = migrateLegacyApiMessages([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: 123 }] as never },
		])
		expect(out).toEqual([{ type: "function_call_output", call_id: "t1", output: "" }])
	})

	it("tool_result の配列 content に未知要素があれば無視して連結する", () => {
		const out = migrateLegacyApiMessages([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: [{ type: "text", text: "keep" }, { type: "weird" }, null],
					},
				] as never,
			},
		])
		expect(out).toEqual([{ type: "function_call_output", call_id: "t1", output: "keep" }])
	})
})
