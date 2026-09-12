import type { AgentMessage } from "@openai-agent/types"

import {
	applyPlan,
	createAllocator,
	planMasking,
	unmaskText,
	type MaskOptions,
	type PlaceholderAllocator,
} from "./maskText"
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
 * 戻すときは逆に、元の値が引用符や改行を含み得る。戻す側が JSON を壊さないようにする。
 */

/**
 * タスク 1 つ分の対応表であり、伏せ字を割り当てる係でもある。
 *
 * **番号を持つのはここである。** 置き換えの側で番号を振ると、要求ごとに 1 から振り直され、
 * 同じ番号が別の値へ結び付く。
 */
export class PiiVault implements PlaceholderAllocator {
	/** 伏せ字 → 元の値。割り当て係としてもこの表を差し出す。 */
	readonly table = new Map<string, string>()
	private readonly assigned = new Map<string, string>()
	private readonly next = new Map<PiiKind, number>()

	/** 伏せ字 → 元の値。戻すときに使う。 */
	get entries(): ReadonlyMap<string, string> {
		return this.table
	}

	get size(): number {
		return this.table.size
	}

	/**
	 * 同じ種類と値には同じ伏せ字を返す。
	 *
	 * **番号を持つのは対応表である。** 置き換えのたびに 1 から振ると、要求ごとに同じ
	 * 番号が別の値へ結び付く。前の応答で `{{email-001}}` と書いたモデルに、次の要求で
	 * 別人を指す `{{email-001}}` を見せることになり、戻すときに別人の値がファイルへ
	 * 書かれる。
	 */
	assign(kind: PiiKind, value: string): string {
		const key = `${kind} ${value}`
		const existing = this.assigned.get(key)
		if (existing !== undefined) return existing

		const index = (this.next.get(kind) ?? 0) + 1
		this.next.set(kind, index)
		const placeholder = `{{${kind}-${String(index).padStart(3, "0")}}}`
		this.assigned.set(key, placeholder)
		this.table.set(placeholder, value)
		return placeholder
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
 * 会話を伏せる。
 *
 * **部分ごとに置き換え、割り当て係だけを共有する。** 番号は割り当て係が持つので、
 * 部分に分けても同じ値には同じ伏せ字が当たる。
 */
export function maskConversation(
	systemPrompt: string,
	messages: readonly AgentMessage[],
	options: MaskOptions = {},
	vault?: PiiVault,
): MaskConversationResult {
	// **部分ごとに置き換え、割り当て係だけを共有する。** 連結してから置き換えると、
	// 区切りをまたいだ一致が起きる（住所の照合は空白も飲み込む）。またいだ分は片方が
	// 伏せられないまま送られ、対応表には区切りを含む値が入る。
	const allocator = vault ?? createAllocator()
	const counts: Partial<Record<PiiKind, number>> = {}

	const mask = (text: string): string => {
		const plan = planMasking(text, options, undefined, allocator)
		for (const [kind, count] of Object.entries(plan.counts)) {
			counts[kind as PiiKind] = (counts[kind as PiiKind] ?? 0) + (count ?? 0)
		}
		return applyPlan(text, plan.edits)
	}

	const copies = messages.map((item) => structuredClone(item) as AgentMessage)

	for (const item of copies) {
		if (item.type === "message") {
			if (typeof item.content === "string") {
				item.content = mask(item.content)
				continue
			}
			for (const part of item.content) {
				// 画像には文字列が無い。触らない。
				if (part.type === "input_image") continue
				part.text = mask(part.text)
			}
			continue
		}

		if (item.type === "function_call") {
			item.arguments = mask(item.arguments)
			continue
		}

		if (item.type === "function_call_output") {
			item.output = mask(item.output)
		}
		// reasoning は暗号化された不透明な値なので触らない。
	}

	return { messages: copies, systemPrompt: mask(systemPrompt), counts }
}
