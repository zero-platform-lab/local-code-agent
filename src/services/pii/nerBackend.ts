import * as path from "path"

import type { PiiMatch } from "./types"
import { toPiiMatches, type NerOptions } from "./nerDetector"
import { alignTokens, groupEntities, type ClassifiedToken } from "./nerSpans"
import { verifyModel, type ModelCheck } from "./nerModel"

/**
 * 第 2 層の判定を実行する。
 *
 * **目的。** モデルへ文章を渡し、伏せる対象の一覧を得る（`FR-PII-21` `FR-PII-22`）。
 *
 * **2 つに分けてある。**
 *
 * | 何       | 中身                                     | 試験          |
 * | -------- | ---------------------------------------- | ------------- |
 * | `Backend`| モデルを読み、文章を分けて区分を付ける   | 偽物で置ける  |
 * | `detectWith` | 位置を求め、絞り込み、伏せる対象にする | 偽物で確かめる |
 *
 * 分ける理由は、モデルが 265 MB あり、試験のたびに読めないためである。判断の含まれる
 * 処理は全て `detectWith` の側に置き、`Backend` は読むだけにする。
 *
 * **外部へ送らない（`FR-PII-22`）。** 網から取りに行かない設定で読み込み、置いてある
 * ファイルだけを使う。判定はこの機械の中で終わる。
 */

/**
 * 一度に渡す文字の数。
 *
 * **モデルは 512 断片までしか見ない。** 超えた分は黙って落ちる。日本語は 1 文字が
 * 1 断片になり得るので、余裕を見てこの長さに切る。
 */
const WINDOW = 256

/**
 * 窓の重なり。
 *
 * 切れ目に名前がまたがると、どちらの窓でも半分しか見えない。名前の長さより十分に
 * 大きくとる。
 */
const OVERLAP = 32

/** モデルを読んだもの。判断は持たない。 */
export type NerBackend = {
	/** 文章を断片へ分ける。特殊な印は含まない。 */
	tokenize(text: string): string[]
	/** 断片ごとに区分を付ける。`O` の断片は返らない。 */
	classify(text: string): Promise<ClassifiedToken[]>
	/** 並びの前後に付く特殊な印。位置合わせで数を合わせるために要る。 */
	bos: string
	eos: string
}

/**
 * 文章から、伏せる対象を得る。
 *
 * **特殊な印を前後に足してから位置を合わせる。** 判定が返す索引は印を含めて数えた位置
 * なので、足さないと 1 つずれ、全ての範囲が隣の断片を指す（`nerSpans` を参照）。
 */
export async function detectWith(backend: NerBackend, text: string, options: NerOptions = {}): Promise<PiiMatch[]> {
	if (text.length <= WINDOW) return detectOne(backend, text, options, 0)

	// **窓に分けて全部見る。** 分けないと、長い本文の後ろが黙って落ちる。
	const found: PiiMatch[] = []
	for (let at = 0; at < text.length; at += WINDOW - OVERLAP) {
		found.push(...(await detectOne(backend, text.slice(at, at + WINDOW), options, at)))
		if (at + WINDOW >= text.length) break
	}

	// 重なりの分だけ二度出る。位置が同じものは 1 つにする。
	const seen = new Set<string>()
	return found.filter((one) => {
		const key = `${one.start}-${one.end}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/** 窓 1 つぶんを判定する。`offset` は本文の中での窓の始まりの位置。 */
async function detectOne(backend: NerBackend, text: string, options: NerOptions, offset: number): Promise<PiiMatch[]> {
	const pieces = [backend.bos, ...backend.tokenize(text), backend.eos]
	const spans = alignTokens(text, pieces)
	const groups = groupEntities(text, spans, await backend.classify(text))

	return toPiiMatches(groups, options).map((one) => ({ ...one, start: one.start + offset, end: one.end + offset }))
}

/**
 * 置いてあるモデルを読む。
 *
 * 照合に通らなければ `undefined` を返す（`FR-PII-23b`）。**誤りとして扱わない。**
 * モデルを置いていない利用者のほうが多く、その場合は第 2 層が動かないだけである。
 */
export async function loadBackend(directory: string): Promise<{ backend?: NerBackend; check: ModelCheck }> {
	// **照合の結果も返す。** 呼ぶ側が理由を出すために照合し直すと、265 MB を二度
	// 読み直すことになり、送信の手前で待たされる。
	const check = await verifyModel(directory)
	if (!check.ok) return { check }

	// 束ねずに読み込む。native を含むため、使うときだけ読む。
	const { AutoTokenizer, env, pipeline } = await import("@huggingface/transformers")

	// **網へ取りに行かせない（`FR-PII-22`）。** 置いてあるファイルだけを使う。
	env.allowRemoteModels = false
	env.localModelPath = path.dirname(directory)

	const name = path.basename(directory)
	const tokenizer = await AutoTokenizer.from_pretrained(name)
	const classifier = await pipeline("token-classification", name, { dtype: "q8" })

	const backend: NerBackend = {
		tokenize: (text) => tokenizer.tokenize(text) as string[],
		classify: async (text) => (await classifier(text)) as unknown as ClassifiedToken[],
		bos: (tokenizer.bos_token ?? "<s>") as string,
		eos: (tokenizer.eos_token ?? "</s>") as string,
	}

	return { backend, check }
}
