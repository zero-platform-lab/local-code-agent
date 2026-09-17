import type { AgentMessage } from "@openai-agent/types"

import type { FileMappingEntry } from "./fileMappingStore"

/** ファイル対応表が対応づける読み取りツール。内容がまるごと出力に入るのはこれである。 */
const READ_FILE_TOOL = "read_file"

const PLACEHOLDER = /\{\{[a-z]+-\d{3,}\}\}/g

/** `read_file` の引数からファイルのパスを取り出す。新形式 `path` とレガシー `files[].path`。 */
function readFilePaths(argsJson: string): string[] {
	let args: unknown
	try {
		args = JSON.parse(argsJson)
	} catch {
		return []
	}
	if (!args || typeof args !== "object") return []
	const record = args as { path?: unknown; files?: unknown }
	if (typeof record.path === "string" && record.path) return [record.path]
	if (Array.isArray(record.files)) {
		return record.files
			.map((file) => (file && typeof file === "object" ? (file as { path?: unknown }).path : undefined))
			.filter((path): path is string => typeof path === "string" && path.length > 0)
	}
	return []
}

/**
 * 会話から「読んだファイル」を集める。call_id → 読んだファイルのパスの対応を返す。
 *
 * `function_call_output` は伏せる時点でどのファイル由来かを持たないので、同じ call_id の
 * `read_file` 呼び出しの引数からパスを引く。
 */
export function readFileTargets(messages: readonly AgentMessage[]): Map<string, string[]> {
	const targets = new Map<string, string[]>()
	for (const item of messages) {
		if (item.type !== "function_call" || item.name !== READ_FILE_TOOL) continue
		const paths = readFilePaths(item.arguments)
		if (paths.length > 0) targets.set(item.call_id, paths)
	}
	return targets
}

/**
 * 伏せた本文に現れた伏せ字を、対応表から `[伏せ字, 元の値]` にする。
 *
 * 本文に無い伏せ字は入れない。ファイルに現れたぶんだけを、そのファイルの対応表へ保存する。
 */
export function placeholderEntries(text: string, entries: ReadonlyMap<string, string>): FileMappingEntry[] {
	const found = new Set(text.match(PLACEHOLDER) ?? [])
	const result: FileMappingEntry[] = []
	for (const placeholder of found) {
		const value = entries.get(placeholder)
		if (value !== undefined) result.push([placeholder, value])
	}
	return result
}
