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
 */

/** 取得先。版ごとのタグに添付する（`docs/features/pii-proper-nouns.md`）。 */
export const DEFAULT_MODEL_URL =
	"https://github.com/zero-platform-lab/local-code-agent/releases/download/model-ner-ja-v1"

export type FetchOptions = {
	/** 取得先。社内のミラーを指すときに変える。 */
	baseUrl?: string
	/** 進み具合を伝える。利用者は 282 MB を待つので、何が起きているか出す。 */
	report?: (message: string) => void
}

/**
 * 取得先を決める。
 *
 * 末尾の斜線は落とす。設定に貼り付けた URL が `.../v1/` のように終わることがあり、
 * そのまま繋ぐと `//SHA256SUMS` になる。
 */
export function resolveBase(baseUrl?: string): string {
	return (baseUrl ?? DEFAULT_MODEL_URL).replace(/\/+$/, "")
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

/**
 * 置き場所へモデルを揃え、揃ったかを確かめて返す。
 *
 * **取り終えてから照合する。** 取れたつもりで欠けていると、第 2 層が静かに動かない。
 */
export async function fetchModel(directory: string, options: FetchOptions): Promise<ModelCheck> {
	const base = resolveBase(options.baseUrl)
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
