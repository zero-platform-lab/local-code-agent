// npx vitest run core/task/__tests__/sendPathInvariants.spec.ts
//
// **送信直前の不変条件**を、履歴を加工する経路の組み合わせに対してまとめて検証する。
//
// 動機:
//   AgentMessage[] への移行時、ユニットテストは 4531 件通っていたのに実機で 2 件の
//   回帰が出た（multi-turn reasoning が常に無効・truncation が tool ペアを割る）。
//   どちらも「実装した形をなぞる」テストしか無く、プロトコル上の不変条件を
//   誰も見ていなかったのが原因。
//
//   ここでは個々の関数の出力形ではなく、**API に送られる最終形が満たすべき条件**を
//   直接検証する。履歴の加工（condense / truncation / 両方 / 何もしない）を通した
//   あとでも、条件が保たれることを確認する。

import { describe, it, expect } from "vitest"

import type { AgentMessage } from "@openai-agent/types"

import { getEffectiveApiHistory, injectSyntheticToolResults, transformMessagesForCondensing } from "../../condense"
import { truncateConversation } from "../../context-management"
import type { ApiMessage } from "../../task-persistence"
import { buildCleanConversationHistory } from "../buildCleanConversationHistory"

/** 拡張独自のメタデータ。送信 body に載ってはいけない。 */
const META_KEYS = [
	"ts",
	"isSummary",
	"condenseId",
	"condenseParent",
	"truncationId",
	"truncationParent",
	"isTruncationMarker",
]

/**
 * 送信 item 列が満たすべき条件。破れると互換サーバが 400 を返すか、
 * 機能が黙って無効になる。
 */
function assertSendable(items: AgentMessage[], label: string) {
	const calls = new Set<string>()
	const outputs: string[] = []

	for (const item of items) {
		// 1. 拡張独自のメタデータが混ざらない
		const leaked = META_KEYS.filter((key) => key in (item as unknown as Record<string, unknown>))
		expect(leaked, `${label}: 送信 item にメタデータが混入 (${item.type})`).toEqual([])

		if (item.type === "function_call") calls.add(item.call_id)
		if (item.type === "function_call_output") outputs.push(item.call_id)

		// 2. 暗号化されていない reasoning は送らない（Responses API が受け付けない）
		if (item.type === "reasoning") {
			expect(item.encrypted_content, `${label}: encrypted_content の無い reasoning を送っている`).toBeTruthy()
		}
	}

	// 3. 相手のいない tool 応答を送らない（OpenAI はプロトコル違反で 400）
	for (const callId of outputs) {
		expect(calls.has(callId), `${label}: orphan な function_call_output (${callId})`).toBe(true)
	}
}

/** tool ペアを含む、そこそこ現実的な履歴を作る。 */
function makeHistory(pairs: number): ApiMessage[] {
	const out: ApiMessage[] = [{ type: "message", role: "user", content: "task", ts: 1 }]
	for (let i = 1; i <= pairs; i++) {
		out.push({ type: "reasoning", encrypted_content: `BLOB-${i}`, id: `r${i}`, ts: i * 10 })
		out.push({ type: "function_call", call_id: `c${i}`, name: "read_file", arguments: "{}", ts: i * 10 + 1 })
		out.push({ type: "function_call_output", call_id: `c${i}`, output: "body", ts: i * 10 + 2 })
		out.push({ type: "message", role: "user", content: "<environment_details>", ts: i * 10 + 3 })
	}
	return out
}

describe("送信直前の不変条件", () => {
	const shapes = [1, 2, 3, 5, 8]

	for (const pairs of shapes) {
		it(`加工なし（tool ペア ${pairs} 組）`, () => {
			const items = buildCleanConversationHistory(getEffectiveApiHistory(makeHistory(pairs)), true)
			assertSendable(items, `pairs=${pairs}`)
		})

		it(`truncation 後（tool ペア ${pairs} 組）`, () => {
			const { messages } = truncateConversation(makeHistory(pairs), 0.5, "t")
			const items = buildCleanConversationHistory(getEffectiveApiHistory(messages), true)
			assertSendable(items, `truncate pairs=${pairs}`)
		})

		it(`truncation を 2 回重ねても（tool ペア ${pairs} 組）`, () => {
			const first = truncateConversation(makeHistory(pairs), 0.5, "t1").messages
			const second = truncateConversation(first, 0.5, "t2").messages
			const items = buildCleanConversationHistory(getEffectiveApiHistory(second), true)
			assertSendable(items, `truncate x2 pairs=${pairs}`)
		})

		it(`condense の要約リクエスト（tool ペア ${pairs} 組）`, () => {
			// summarizeConversation が組む経路と同じ順序
			const withResults = injectSyntheticToolResults(makeHistory(pairs))
			const asText = transformMessagesForCondensing(withResults)
			const items = buildCleanConversationHistory(asText, false)
			assertSendable(items, `condense pairs=${pairs}`)

			// 要約リクエストには tool 系 item を残さない（tools パラメータを要求されるため）
			expect(items.some((i) => i.type === "function_call" || i.type === "function_call_output")).toBe(false)
			// reasoning も送らない
			expect(items.some((i) => i.type === "reasoning")).toBe(false)
		})
	}

	it("応答の無い function_call があっても、要約経路では orphan を作らない", () => {
		const history = makeHistory(2)
		// 最後の応答を落として orphan な呼び出しを作る
		const broken = history.filter((m) => !(m.type === "function_call_output" && m.call_id === "c2"))

		const items = buildCleanConversationHistory(
			transformMessagesForCondensing(injectSyntheticToolResults(broken)),
			false,
		)
		assertSendable(items, "orphan call")
	})

	it("暗号化 reasoning は既定で送る（引数を渡し忘れても無効にならない）", () => {
		// 実機で見つかった回帰の再発防止。呼び出し側が modelInfo のフラグを渡していたため
		// multi-turn reasoning が常に無効になっていた。既定を true にして事故を防ぐ。
		const items = buildCleanConversationHistory(makeHistory(2))
		const blobs = items
			.filter((i) => i.type === "reasoning")
			.map((i) => (i as { encrypted_content: string }).encrypted_content)
		expect(blobs).toEqual(["BLOB-1", "BLOB-2"])
	})

	it("encrypted_content の無い reasoning は includeReasoning=true でも送らない", () => {
		const history: ApiMessage[] = [
			{ type: "message", role: "user", content: "hi" },
			{ type: "reasoning", summary: ["plain"], ts: 2 },
		]
		const items = buildCleanConversationHistory(history, true)
		assertSendable(items, "plain reasoning")
		expect(items.some((i) => i.type === "reasoning")).toBe(false)
	})
})
