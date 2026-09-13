/**
 * 判定した断片から、本文の位置を求める。
 *
 * **目的。** 第 2 層の判定は「どの断片が何か」しか返さず、本文の何文字目かを持たない
 * （`FR-PII-21e`）。伏せるには範囲が要るので、ここで確定させる。
 *
 * **なぜ素朴に探すと壊れるか。** 判定は `O`（何でもない）の断片を返さない。返ってきた
 * 断片だけを本文から探すと、前に同じ文字列があったときにそちらを掴む。
 *
 * ```
 * 森林の話。森さんが来た。
 * ^^                      ← 判定は 5 文字目の「森」を指しているのに
 *          ^^             ← 素朴に探すと 0 文字目を掴む
 * ```
 *
 * **仕組み。** 分けた断片を「全て」順に本文と突き合わせ、位置を進めながら確定させる。
 * 前の断片で読み進めた位置より後ろしか探さないので、上の取り違えが起きない。
 *
 * **見つからなければ採らない。** 分け方が本文を正規化していると、断片と本文の文字が
 * 一致しないことがある。そのときは推測せず、その断片を捨てる。誤った範囲を伏せると、
 * 戻すときに別の文字列になる。
 */

/**
 * 位置を取り直すときに飛ばしてよい文字数。
 *
 * 分け方が正規化した断片は本文に無い。その次の断片で位置を取り直すが、飛ばす距離が
 * 大きいほど、同じ文字列の別の箇所へ飛びつく見込みが上がる。
 */
const RESYNC_LIMIT = 16

/** 断片 1 つの範囲。本文と対応付けられなければ `null`。 */
export type TokenSpan = { start: number; end: number } | null

/** 判定が返す断片 1 つ。`index` は分けた並びの中の位置である。 */
export type ClassifiedToken = {
	entity: string
	score: number
	index: number
	word: string
}

/** まとめ上げた固有名詞 1 つ。 */
export type EntitySpan = {
	entity: string
	/** まとめた断片のうち、最も低い確度。弱い断片が混じった塊を弱く扱う。 */
	score: number
	start: number
	end: number
	value: string
}

/**
 * 語の切れ目を表す印。SentencePiece が付けるもので、本文の文字ではない。
 */
const WORD_MARK = "▁"

/** 分け方が使う特殊な印。本文には現れないので、幅ゼロとして扱う。 */
const SPECIAL = /^<(?:s|\/s|pad|unk|mask)>$/

/**
 * 区切りの文字。ここで塊を切る。
 *
 * 判定は区切りの文字にも種類を付けることがある。`佐藤。森` が 1 つの人名として
 * 返るのは、間の `。` が同じ種類になるためである。
 */
const PUNCT = /^[\s、。，．・…（）()「」『』〈〉:：;；!！?？`"'|/\\-]+$/

/**
 * 分けた断片を本文と突き合わせ、それぞれの範囲を返す。
 *
 * `pieces` は分けた並びの全てで、`O` の断片も特殊な印も含む。並びの索引が、そのまま
 * 返り値の索引になる。
 *
 * **特殊な印を省いてはいけない。** 判定が返す `index` は印を含めて数えた位置なので、
 * 省くと 1 つずれ、全ての範囲が隣の断片を指す。呼ぶ側は次の形で作る。
 *
 * ```ts
 * const pieces = [tokenizer.bos_token, ...tokenizer.tokenize(text), tokenizer.eos_token]
 * ```
 *
 * 内部向けの呼び出しは使わない。公開されている `tokenize` に印を足したもので、実物と
 * 一致することを確かめてある。
 */
export function alignTokens(text: string, pieces: string[]): TokenSpan[] {
	const spans: TokenSpan[] = []
	let cursor = 0

	for (const piece of pieces) {
		if (SPECIAL.test(piece)) {
			spans.push(null)
			continue
		}

		// 語の切れ目の印は本文に無い。外してから探す。
		const body = piece.split(WORD_MARK).join("")
		if (body.length === 0) {
			spans.push(null)
			continue
		}

		// **飛べる距離に上限を置く。**
		//
		// 分け方は文字を正規化する。全角の `（` は `(` に、`Ｄｏｃｋｅｒ` は `Docker` に
		// なる。そうなった断片は本文に無いので、次の断片から位置を取り直すことになる。
		// 取り直し自体は要る。塞ぐと、1 文字の全角があるだけでそれ以降を全部落とす
		// （実測で検出が 5 件から 1 件になった）。
		//
		// ただし無制限に飛ばすと、**同じ文字列が先にあったときにそちらへ飛びつく**。
		// 以降の位置が全部ずれ、無関係な文字が伏せ字になり、本物の名前はそのまま送られる。
		// 実測した取り直しは 1〜7 文字だったので、そのくらいまでにする。
		const start = text.indexOf(body, cursor)
		if (start < 0 || start - cursor > RESYNC_LIMIT) {
			spans.push(null)
			continue
		}

		spans.push({ start, end: start + body.length })
		cursor = start + body.length
	}

	return spans
}

/**
 * 同じ種類で隣り合う断片をまとめ、固有名詞の範囲にする。
 *
 * まとめる条件は 2 つある。**同じ種類であること**と、**本文の上で隙間なく続いて
 * いること**である。隙間があるのは、間に `O` の断片があったということなので切る。
 */
export function groupEntities(text: string, spans: TokenSpan[], classified: ClassifiedToken[]): EntitySpan[] {
	const groups: EntitySpan[] = []
	let current: EntitySpan | null = null

	for (const token of [...classified].sort((a, b) => a.index - b.index)) {
		const span = spans[token.index]
		if (!span) {
			current = null
			continue
		}

		const value = text.slice(span.start, span.end)
		if (PUNCT.test(value)) {
			current = null
			continue
		}

		if (current && current.entity === token.entity && current.end === span.start) {
			current.end = span.end
			current.value = text.slice(current.start, current.end)
			current.score = Math.min(current.score, token.score)
			continue
		}

		current = { entity: token.entity, score: token.score, start: span.start, end: span.end, value }
		groups.push(current)
	}

	return groups
}
