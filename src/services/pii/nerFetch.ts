import * as path from "path"
import { createWriteStream, promises as fs } from "fs"
import { Readable } from "stream"
import { pipeline } from "stream/promises"

import { fetchThrough, getProxyDispatcher } from "../../utils/proxyDispatcher"

import { CHECKSUM_FILE, REQUIRED_FILES, verifyModel, type ModelCheck } from "./nerModel"

/**
 * 第 2 層のモデルを取得する。
 *
 * **目的。** 網のある環境で、置き場所へファイルを揃える（`FR-PII-23c`）。
 *
 * **書庫にしない。** 5 つのファイルを 1 つずつ取る。書庫にすると展開の仕組みが要り、
 * 依存が 1 つ増える。取る回数が 6 回になるだけで、得るものは同じである。
 *
 * **利用者が指示したときだけ実行する（`FR-PII-23c`）。** 282 MB を勝手に取りに行かない。
 *
 * **閉鎖環境では実行しない。** 別の機械で取ったファイルを置き場所へ置けば、拡張から見て
 * 取得した場合と区別が付かない（`FR-PII-23d`）。だからこの関数は閉鎖環境の要件ではない。
 *
 * **企業 proxy を尊重する。** `getProxyDispatcher` を経由する。経由しないと、proxy の
 * 内側からは 282 MB が取れない。
 *
 * **既定の取得先を持たない（`FR-PII-23h`）。** 設定に書いた人だけが取得できる。直書きの
 * 取得先を持つと、拡張が誰の指示も無く特定の場所へ 282 MB を取りに行くことになる。閉鎖
 * 環境で使うものが、既定で外へ出てよい理由は無い。
 */

export type FetchOptions = {
	/** 取得先。設定に書いたものを渡す。空なら取得しない。 */
	baseUrl?: string
	/** 進み具合を伝える。利用者は 282 MB を待つので、何が起きているか出す。 */
	report?: (message: string) => void
}

/**
 * 取得先を決める。書かれていなければ `undefined` を返す。
 *
 * 末尾の斜線は落とす。設定に貼り付けた URL が `.../v1/` のように終わることがあり、
 * そのまま繋ぐと `//SHA256SUMS` になる。
 *
 * **空白だけの欄は「書いていない」として扱う。** 空白を取得先にすると、`/SHA256SUMS`
 * という相対の場所へ取りに行き、意味の分からない失敗になる。
 */
export function resolveBase(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "")
	return trimmed ? trimmed : undefined
}

/** 添付は平らに並ぶので、`onnx/model_quantized.onnx` は `model_quantized.onnx` で取る。 */
function assetName(relative: string): string {
	return path.posix.basename(relative)
}

async function download(url: string, target: string): Promise<void> {
	const response = await fetchThrough(getProxyDispatcher(), url, { method: "GET" })
	if (!response.ok) {
		throw new Error(`${url}: ${response.status} ${response.statusText}`)
	}
	if (!response.body) {
		throw new Error(`${url}: 本文が無い`)
	}

	await fs.mkdir(path.dirname(target), { recursive: true })

	// **流し込む。** まとめて読むと、265 MB の実体とその写しを同時に抱えることになり、
	// 拡張ホストごと記憶を使い切りかねない。取り消す手段も用意していない。
	await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(target))
}

/** 取得先が書かれていないときの理由。画面はこれを見て案内を出す。 */
export const NO_URL = "取得先が設定されていない"

/**
 * 置き場所へモデルを揃え、揃ったかを確かめて返す。
 *
 * **取り終えてから照合する。** 取れたつもりで欠けていると、第 2 層が静かに動かない。
 */
export async function fetchModel(directory: string, options: FetchOptions): Promise<ModelCheck> {
	const base = resolveBase(options.baseUrl)
	// **黙って既定へ落とさない。** 落とすと、設定を空にした人の意思に反して外へ出る。
	if (!base) throw new Error(NO_URL)
	const report = options.report ?? (() => {})

	// 照合する値を先に取る。これが取れない先は、そもそも取得先として正しくない。
	report(CHECKSUM_FILE)
	await download(`${base}/${CHECKSUM_FILE}`, path.join(directory, CHECKSUM_FILE))

	for (const relative of REQUIRED_FILES) {
		report(relative)
		await download(`${base}/${assetName(relative)}`, path.join(directory, relative))
	}

	return verifyModel(directory)
}
