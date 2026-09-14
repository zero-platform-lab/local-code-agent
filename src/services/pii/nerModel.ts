import * as path from "path"
import { createHash } from "crypto"
import { createReadStream, promises as fs } from "fs"

import { getGlobalAgentDirectory } from "../agent-config"

/**
 * 第 2 層のモデルのファイルを確かめる。
 *
 * **目的。** 読み込む前に、置いてあるファイルが配ったものと同じかを確かめる
 * （`FR-PII-23e`）。ここは照合だけを行い、判定そのものは行わない。
 *
 * **なぜ照合するか。** モデルは 265 MB あり、網から取るか媒体で運ぶかして置かれる。
 * 途中で欠けたファイルを読み込むと、読み込みが失敗するか、**静かに検出が甘くなる**。
 * 後者は画面に何も出ないので、誰も気づけない。
 *
 * **仕組み。** 配るときに作った `SHA256SUMS` と突き合わせる（`scripts/build-ner-model.sh`）。
 * 網から取った場合も、媒体で運んだ場合も、同じ値で確かめる。閉鎖環境のために別の作りを
 * 持たない（`FR-PII-23d`）。
 *
 * **無いことは誤りではない。** モデルを置いていない利用者のほうが多い。その場合は第 2 層
 * が動かないだけで、第 1 層はそのまま動く（`FR-PII-23b`）。
 */

/** 照合する値を並べたファイルの名前。 */
export const CHECKSUM_FILE = "SHA256SUMS"

/**
 * 判定に要るファイル。
 *
 * `sentencepiece.bpe.model` は `tokenizer.json` と重複するので配らない。ここに無い
 * ファイルが置かれていても、照合しないし読まない。
 */
export const REQUIRED_FILES = [
	"config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	"special_tokens_map.json",
	"onnx/model_quantized.onnx",
] as const

/** 置き場所の既定（`FR-PII-23a`）。配布物には入れないので、設定の置き場所の下に置く。 */
export function defaultModelDirectory(): string {
	return path.join(getGlobalAgentDirectory(), "pii-ner")
}

/**
 * `SHA256SUMS` を読む。`<値>␣␣<相対パス>` の行が並ぶ。
 *
 * 書庫（`ner-ja.tar.gz`）の行も入っているが、展開したあとには無いので読み飛ばす。
 * 要るファイルだけを引けるように、パスから先頭の `./` を外して覚える。
 */
export function parseChecksums(text: string): Map<string, string> {
	const sums = new Map<string, string>()

	for (const line of text.split("\n")) {
		const found = /^([0-9a-f]{64})\s+\*?\.?\/?(.+?)\s*$/.exec(line)
		if (found) sums.set(found[2], found[1])
	}

	return sums
}

/** 照合の結果。`ok` でなければ、第 2 層は動かさない。 */
export type ModelCheck = {
	ok: boolean
	/** 置かれていないファイル。 */
	missing: string[]
	/** 置かれているが、値が違うファイル。 */
	mismatched: string[]
}

async function sha256(target: string): Promise<string> {
	const hash = createHash("sha256")
	for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer)
	return hash.digest("hex")
}

/**
 * 置いてあるモデルを照合する（`FR-PII-23e`）。
 *
 * `SHA256SUMS` が無ければ、確かめようがないので採らない。**値の分からないモデルを
 * 読むくらいなら、第 2 層を動かさないほうがよい。**
 */
export async function verifyModel(directory: string): Promise<ModelCheck> {
	let sums: Map<string, string>
	try {
		sums = parseChecksums(await fs.readFile(path.join(directory, CHECKSUM_FILE), "utf8"))
	} catch {
		return { ok: false, missing: [CHECKSUM_FILE], mismatched: [] }
	}

	const missing: string[] = []
	const mismatched: string[] = []

	for (const name of REQUIRED_FILES) {
		const expected = sums.get(name)
		if (expected === undefined) {
			// 並びに無いものは、確かめようがないので置かれていない扱いにする。
			missing.push(name)
			continue
		}

		try {
			if ((await sha256(path.join(directory, name))) !== expected) mismatched.push(name)
		} catch {
			missing.push(name)
		}
	}

	return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched }
}

/**
 * 照合の結果を、利用者が読める 1 行にする（`FR-PII-22a`）。
 *
 * **黙って第 1 層だけで動かさない。** 画面の見た目は変わらないので、出さないと
 * 取り違えに気づけない。
 */
export function describeCheck(check: ModelCheck): string | undefined {
	if (check.ok) return undefined

	const parts: string[] = []
	if (check.missing.length > 0) parts.push(`置かれていない: ${check.missing.join(", ")}`)
	if (check.mismatched.length > 0) parts.push(`値が違う: ${check.mismatched.join(", ")}`)

	return parts.join(" / ")
}

/** 置き場所の様子。画面へ出すためのもので、照合はしない。 */
export type ModelLocation = {
	/** 実際に見ている場所。利用者はここへファイルを置く。 */
	directory: string
	/** 要るファイルが全部あるか。 */
	present: boolean
	/** 足りないファイル。 */
	missing: string[]
	/** 置いてあるファイルの合計。 */
	bytes: number
}

/**
 * 置き場所の様子を返す（`FR-PII-23a`）。
 *
 * **照合はしない。** `verifyModel` は 265 MB を読み直すので、画面を出すたびには実行
 * できない。ここは「どこを見ているか」と「あるかどうか」だけを返す。
 *
 * **場所を画面に出すために要る。** 出さないと、閉鎖環境の利用者はどこへ運べばよいか
 * 分からない。既定の場所を使う設定にしていると、欄が空なので手がかりが無い。
 */
export async function locateModel(directory: string): Promise<ModelLocation> {
	const missing: string[] = []
	let bytes = 0

	for (const name of [CHECKSUM_FILE, ...REQUIRED_FILES]) {
		try {
			bytes += (await fs.stat(path.join(directory, name))).size
		} catch {
			missing.push(name)
		}
	}

	return { directory, present: missing.length === 0, missing, bytes }
}
