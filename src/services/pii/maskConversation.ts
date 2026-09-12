import type { AgentMessage } from "@openai-agent/types"

import { planMasking, unmaskText, type MaskOptions } from "./maskText"
import type { PiiKind } from "./types"

/**
 * 会話の全体を伏せ字へ置き換える。
 *
 * **目的。** LLM へ送る内容から機密情報を落とす（`FR-PII-01`）。読み取り・言及・探索・
 * 端末の出力のどれから入ってきた文字列でも、ここを通れば伏せられる。経路ごとに当てると
 * どれかを取りこぼす。
 *
 * **仕組み。** `AgentMessage` の item を種類ごとに見て、文字列を持つ欄だけを置き換える。
 *
 * | item                   | 置き換える欄        | 理由                                   |
 * | ---------------------- | ------------------- | -------------------------------------- |
 * | `message`              | `content`           | 利用者の指示と、モデルの応答           |
 * | `function_call`        | `arguments`         | モデルが書いたファイルの中身が入る     |
 * | `function_call_output` | `output`            | 読んだファイルと端末の出力が入る       |
 * | `reasoning`            | 触らない            | 暗号化された不透明な値である           |
 *
 * **対応表はタスクの間ずっと持つ**（`FR-PII-02` `FR-PII-02b`）。同じ値へ毎回同じ伏せ字を
 * 割り当てないと、前の応答で使った伏せ字と食い違い、モデルは別人だと読む。ディスクへは
 * 書かない。
 *
 * **JSON を壊さない。** `function_call.arguments` は JSON の文字列だが、伏せ字は
 * `{{email-001}}` の形で引用符も逆斜線も含まないため、値の中へ入れても JSON のままである。
 */

/**
 * タスク 1 つ分の対応表。
 *
 * 番号を続きから振るために、割り当ての状態を持ち越す。`maskText` は呼ぶたびに 1 から
 * 振り直すので、会話全体を 1 回で通し、結果をここへ溜める。
 */
export class PiiVault {
	private readonly table = new Map<string, string>()

	/** 伏せ字 → 元の値。戻すときに使う。 */
	get entries(): ReadonlyMap<string, string> {
		return this.table
	}

	get size(): number {
		return this.table.size
	}

	remember(table: ReadonlyMap<string, string>): void {
		for (const [placeholder, value] of table) {
			this.table.set(placeholder, value)
		}
	}

	/** 伏せ字を元の値へ戻す（`FR-PII-02a`）。割り当てたものだけを戻す（`FR-PII-08a`）。 */
	restore(text: string): string {
		return unmaskText(text, this.table)
	}
}

export type MaskConversationResult = {
	messages: AgentMessage[]
	systemPrompt: string
	/** 種類ごとの件数（`FR-PII-01c`）。 */
	counts: Partial<Record<PiiKind, number>>
}

/**
 * 会話を 1 回で伏せる。
 *
 * **1 つの文字列へ連結してから置き換える。** item ごとに `maskText` を呼ぶと、番号が
 * item ごとに 1 から振り直され、同じ値に別の伏せ字が当たる。区切りには改行を使う。
 */
export function maskConversation(
	systemPrompt: string,
	messages: readonly AgentMessage[],
	options: MaskOptions = {},
	vault?: PiiVault,
): MaskConversationResult {
	const parts: string[] = [systemPrompt]
	const slots: { set: (value: string) => void }[] = []

	const copies = messages.map((item) => structuredClone(item) as AgentMessage)

	for (const item of copies) {
		if (item.type === "message") {
			if (typeof item.content === "string") {
				parts.push(item.content)
				slots.push({ set: (value) => (item.content = value) })
				continue
			}
			for (const part of item.content) {
				// 画像には文字列が無い。触らない。
				if (part.type === "input_image") continue
				parts.push(part.text)
				slots.push({ set: (value) => (part.text = value) })
			}
			continue
		}

		if (item.type === "function_call") {
			parts.push(item.arguments)
			slots.push({ set: (value) => (item.arguments = value) })
			continue
		}

		if (item.type === "function_call_output") {
			parts.push(item.output)
			slots.push({ set: (value) => (item.output = value) })
		}
		// reasoning は暗号化された不透明な値なので触らない。
	}

	// 区切りは改行 2 つ。検出が区切りをまたがないよう、本文に現れない形にはしない
	// （住所や鍵が改行をまたぐことは無い）。
	const separator = "\n\n"
	const plan = planMasking(parts.join(separator), options)

	if (plan.edits.length === 0) {
		return { messages: copies, systemPrompt, counts: plan.counts }
	}

	vault?.remember(plan.table)

	const masked = splitMasked(parts, separator, plan)
	const [maskedSystemPrompt, ...rest] = masked
	rest.forEach((value, index) => slots[index].set(value))

	return { messages: copies, systemPrompt: maskedSystemPrompt, counts: plan.counts }
}

/**
 * 連結した本文へ置き換えを当て、元の区切りで割り直す。
 *
 * 置き換えで長さが変わるため、位置をそのまま使えない。**区切りをまたぐ置き換えは
 * 起きない**ので、部分ごとに当ててから繋ぎ直す。
 */
function splitMasked(parts: readonly string[], separator: string, plan: ReturnType<typeof planMasking>): string[] {
	const out: string[] = []
	let offset = 0
	let next = 0

	for (const part of parts) {
		const end = offset + part.length
		let piece = ""
		let cursor = offset

		while (next < plan.edits.length && plan.edits[next].start < end) {
			const edit = plan.edits[next]
			piece += part.slice(cursor - offset, edit.start - offset) + edit.placeholder
			cursor = edit.end
			next++
		}

		out.push(piece + part.slice(cursor - offset))
		offset = end + separator.length
	}

	return out
}
