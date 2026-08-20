// npx vitest run core/task/__tests__/rewindAndDelegationInvariants.spec.ts
//
// rewind（メッセージ削除・編集による巻き戻し）と委譲復帰の経路が、
// item 列でも tool ペアを割らないことを検証する。
//
// これらは AgentMessage[] 移行時に実機で 1 度も踏んでいない経路。
// truncation では実際にペアが割れる回帰が出たので、同じ形の穴が無いか確かめる。

import { describe, it, expect, vi } from "vitest"

import { MessageManager } from "../../message-manager"
import type { ApiMessage } from "../../task-persistence"

/** 残った function_call_output に必ず対応する function_call があること。 */
function assertNoOrphans(history: ApiMessage[], label: string) {
	const calls = new Set(
		history.filter((m) => m.type === "function_call").map((m) => (m as { call_id: string }).call_id),
	)
	for (const out of history.filter((m) => m.type === "function_call_output")) {
		const id = (out as { call_id: string }).call_id
		expect(calls.has(id), `${label}: orphan な function_call_output (${id})`).toBe(true)
	}
}

/** ターンごとに ts を振った、tool ペア入りの履歴。 */
function makeHistory(pairs: number): ApiMessage[] {
	const out: ApiMessage[] = [{ type: "message", role: "user", content: "task", ts: 100 }]
	for (let i = 1; i <= pairs; i++) {
		const base = 100 + i * 100
		out.push({ type: "function_call", call_id: `c${i}`, name: "read_file", arguments: "{}", ts: base })
		out.push({ type: "function_call_output", call_id: `c${i}`, output: "body", ts: base + 1 })
		out.push({ type: "message", role: "user", content: "<environment_details>", ts: base + 2 })
	}
	return out
}

function makeManager(history: ApiMessage[], clineMessages: Array<{ ts: number; say: string; text?: string }>) {
	const written: ApiMessage[][] = []
	const task = {
		messageStore: { apiConversationHistory: history, clineMessages },
		overwriteApiConversationHistory: vi.fn(async (h: ApiMessage[]) => {
			written.push(h)
		}),
		overwriteClineMessages: vi.fn(async () => {}),
		taskId: "t1",
		providerRef: { deref: () => undefined },
	}
	return { manager: new MessageManager(task as never), written, task }
}

// rewind は ts での足切り。function_call の ts は必ず対応する function_call_output より
// 小さいので、「output だけ残る」形にはならない（call が残って未応答になる側は許容される）。
// この前提が崩れないことを、ペア数と切り戻し位置を振って確認する。
describe("rewind の不変条件", () => {
	for (const pairs of [1, 2, 3, 5]) {
		for (const cutIndex of [1, 2]) {
			it(`ターン ${cutIndex} まで巻き戻しても orphan が出ない（tool ペア ${pairs} 組）`, async () => {
				const history = makeHistory(pairs)
				const clineMessages = [
					{ ts: 100, say: "user", text: "task" },
					...Array.from({ length: pairs }, (_, i) => ({
						ts: 100 + (i + 1) * 100,
						say: "user_feedback",
						text: `turn ${i + 1}`,
					})),
				]
				if (cutIndex >= clineMessages.length) return

				const { manager, written } = makeManager(history, clineMessages)
				await manager.rewindToTimestamp(clineMessages[cutIndex].ts)

				const result = written[written.length - 1] ?? history
				assertNoOrphans(result, `pairs=${pairs} cut=${cutIndex}`)
			})
		}
	}
})
