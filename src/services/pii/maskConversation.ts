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
 * **目的。** LLM へ送る内容から機密情報を取り除く（`FR-PII-01`）。読み取り・言及・探索・
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
	/**
	 * 割り当ての本体は `createAllocator` を使う。
	 *
	 * **伏せ字の作り方を 2 か所に持たない。** 桁数や鍵の作り方が片方だけ変わると、同じ値へ
	 * 別の伏せ字が割り当てられ、応答を戻せなくなる。
	 */
	private readonly allocator = createAllocator()

	/** 伏せ字 → 元の値。割り当て係としてもこの表を差し出す。 */
	get table(): ReadonlyMap<string, string> {
		return this.allocator.table
	}

	/** 伏せ字 → 元の値。戻すときに使う。 */
	get entries(): ReadonlyMap<string, string> {
		return this.allocator.table
	}

	get size(): number {
		return this.allocator.table.size
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
		return this.allocator.assign(kind, value)
	}

	/** 伏せ字を元の値へ戻す（`FR-PII-02a`）。割り当てたものだけを戻す（`FR-PII-08a`）。 */
	restore(text: string): string {
		return unmaskText(text, this.allocator.table)
	}
}

/**
 * 本製品が動いている間ずっと使う対応表（`FR-PII-02b`）。
 *
 * **1 つしか持たない。** タスクごとに分けると、タスク A で `{{email-001}}` に割り当てた
 * 値と、タスク B の `{{email-001}}` が別物になる。A で伏せたファイルを B が読むと、
 * モデルは同じ伏せ字を見て別人の値を書き戻す。
 *
 * **会話をしていなくても使える。** 右クリックでファイルを伏せ、他の道具へ渡し、戻って
 * きてから元へ戻す、という使い方のためである。会話が動いていることを条件にすると、
 * その間に会話を閉じただけで戻せなくなる。
 *
 * **ディスクへは書かない。** 書けば伏せた値そのものを保存することになり、伏せた意味が
 * 無くなる。本製品を終えれば消える（`FR-PII-20b`）。
 */
let shared: PiiVault | undefined

export function sessionVault(): PiiVault {
	return (shared ??= new PiiVault())
}

/** 試験のために捨てる。本番では呼ばない。 */
export function resetSessionVault(): void {
	shared = undefined
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
 * **部分ごとに置き換える。** 割り当て係だけを共有する。 番号は割り当て係が持つので、
 * 部分に分けても同じ値には同じ伏せ字が当たる。
 */
/**
 * 伏せた結果を覚えておく入れ物。
 *
 * **同じ文字列を毎回走査し直さない。** 2 往復目の履歴は 1 往復目とほとんど同じなのに、
 * 全部を照合し直している。会話が伸びるほど、送信の直前の処理が二乗で増える。
 *
 * 同じ割り当て係と同じ設定なら、同じ文字列は必ず同じ結果になる（割り当ては一度決めたら
 * 変わらない）。だから覚えてよい。設定が変わったら呼び出し側が捨てる。
 */
export type MaskMemo = Map<string, { text: string; counts: Partial<Record<PiiKind, number>> }> & {
	/** 覚えている文字数。上限を測るために持つ。 */
	bytes?: number
}

/**
 * 覚える量の上限（文字数）。越えたら捨てる。長い会話で際限なく増やさない。
 *
 * **文字数で数える。** 件数だけで抑えると、数十 KB のツールの出力が 5,000 件残り得る。
 * 数える場所は `MaskMemo` 自身が持つ。
 */
const MEMO_LIMIT = 4_000_000

export function maskConversation(
	systemPrompt: string,
	messages: readonly AgentMessage[],
	options: MaskOptions = {},
	vault?: PiiVault,
	memo?: MaskMemo,
): MaskConversationResult {
	// **部分ごとに置き換える。** 割り当て係だけを共有する。 連結してから置き換えると、
	// 区切りをまたいだ一致が起きる（住所の照合は空白も飲み込む）。またいだ分は片方が
	// 伏せられないまま送られ、対応表には区切りを含む値が入る。
	const allocator = vault ?? createAllocator()
	const counts: Partial<Record<PiiKind, number>> = {}

	const add = (from: Partial<Record<PiiKind, number>>) => {
		// 値を入れるのは `planMasking` だけで、未定義は入らない。分けて扱わない。
		for (const [kind, count] of Object.entries(from as Record<string, number>)) {
			counts[kind as PiiKind] = (counts[kind as PiiKind] ?? 0) + count
		}
	}

	const mask = (text: string): string => {
		const known = memo?.get(text)
		if (known) {
			add(known.counts)
			return known.text
		}

		const plan = planMasking(text, options, undefined, allocator)
		add(plan.counts)
		const masked = applyPlan(text, plan.edits)

		if (memo) {
			const held = (memo.bytes ?? 0) + text.length + masked.length
			if (held > MEMO_LIMIT) {
				memo.clear()
				memo.bytes = 0
			}
			memo.set(text, { text: masked, counts: plan.counts })
			memo.bytes = (memo.bytes ?? 0) + text.length + masked.length
		}
		return masked
	}

	// **変わらない item は写さない。** 伏せるものが無ければ元をそのまま返す。履歴の全体を
	// 毎回複製すると、会話が伸びるほど送信の直前の処理が増える。
	const copies = messages.map((item) => item)

	for (let index = 0; index < copies.length; index++) {
		const item = copies[index]

		if (item.type === "message") {
			if (typeof item.content === "string") {
				const masked = mask(item.content)
				if (masked !== item.content) copies[index] = { ...item, content: masked }
				continue
			}

			const parts = item.content.map((part) => {
				// 画像には文字列が無い。触らない。
				if (part.type === "input_image") return part

				// **変わらなければ元の部品を返す。** 常に新しく作ると、下の比較がいつでも
				// 真になり、写しを避ける意味が無くなる。
				const masked = mask(part.text)
				return masked === part.text ? part : { ...part, text: masked }
			})
			if (parts.some((part, at) => part !== item.content[at])) {
				copies[index] = { ...item, content: parts }
			}
			continue
		}

		if (item.type === "function_call") {
			const masked = mask(item.arguments)
			if (masked !== item.arguments) copies[index] = { ...item, arguments: masked }
			continue
		}

		if (item.type === "function_call_output") {
			const masked = mask(item.output)
			if (masked !== item.output) copies[index] = { ...item, output: masked }
		}
		// reasoning は暗号化された不透明な値なので触らない。
	}

	return { messages: copies, systemPrompt: mask(systemPrompt), counts }
}

/**
 * 伏せる対象になる本文を、重複なく集める。
 *
 * **第 2 層のために要る。** 第 2 層の判定は非同期なので、`maskConversation` を呼ぶ前に
 * 済ませておく必要がある。そのためには、どの本文が伏せられるかを先に知らねばならない。
 *
 * **`maskConversation` と同じ歩き方をすること。** 片方だけが見る本文があると、そこは
 * 第 1 層だけで伏せられ、第 2 層が効かない。しかも画面上は何も変わらないので気づけない。
 * `maskConversation.spec.ts` が、両者の見る本文が一致することを確かめている。
 */
export function collectTexts(systemPrompt: string, messages: readonly AgentMessage[]): string[] {
	const texts = new Set<string>([systemPrompt])

	for (const item of messages) {
		if (item.type === "message") {
			if (typeof item.content === "string") {
				texts.add(item.content)
				continue
			}
			for (const part of item.content) {
				// 画像には文字列が無い。触らない。
				if (part.type === "input_image") continue
				texts.add(part.text)
			}
			continue
		}

		if (item.type === "function_call") {
			texts.add(item.arguments)
			continue
		}

		if (item.type === "function_call_output") {
			texts.add(item.output)
		}
		// reasoning は暗号化された不透明な値なので触らない。
	}

	return [...texts]
}
