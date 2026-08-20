import type { LineRange, ReadFileMode } from "@openai-agent/types"

import { readWithIndentation, readWithSlice } from "../../integrations/misc/indentation-reader"
import { DEFAULT_LINE_LIMIT } from "../prompts/tools/native-tools/read_file"

/**
 * `ReadFileTool` の中で「ファイルの中身をどう切り出して、どう見せるか」を決めていた部分。
 *
 * 元は承認フロー・fs アクセス・画像判定と同じクラスに同居していたため、たとえば
 * 「truncation の警告文が content の前に来ること」を確かめるだけでも Task 相当の host と
 * fs mock を組む必要があった。ここは vscode にも fs にも Task にも依存しない。
 */

/** 中身が 0 バイトのファイルに対して返す文言。 */
export const EMPTY_FILE_NOTICE = "Note: File is empty"

/** 1 ファイル分の読み取り指示（新形式のパラメータを内部表現に落としたもの）。 */
export interface ReadFileEntry {
	path: string
	mode?: ReadFileMode
	offset?: number
	limit?: number
	anchor_line?: number
	max_levels?: number
	include_siblings?: boolean
	include_header?: boolean
	max_lines?: number
}

/**
 * indentation モードの実効アンカー行。
 * 明示指定 → offset → 1 の順に落ちる（offset も 1 起点）。
 */
function effectiveAnchorLine(entry: ReadFileEntry): number {
	return entry.anchor_line ?? entry.offset ?? 1
}

/**
 * 切り詰めが起きたときの警告文。
 *
 * 警告は**内容の前**に置く。@ mention の表示形式に合わせるためで、後ろに付けると
 * 長いファイルではモデルが見落とす。
 *
 * 2 行目以降の先頭タブと、内容の直前にあるタブだけの行は元の書式そのまま
 * （テンプレートリテラルのインデントに依存しないよう明示的に書いている）。
 */
function truncationNotice(startLine: number, endLine: number, totalLines: number, nextLimit: number, content: string) {
	return (
		"IMPORTANT: File content truncated.\n" +
		`\tStatus: Showing lines ${startLine}-${endLine} of ${totalLines} total lines.\n` +
		`\tTo read more: Use the read_file tool with offset=${endLine + 1} and limit=${nextLimit}.\n` +
		"\t\n" +
		`\t${content}`
	)
}

/**
 * 指示に従ってファイル本文を整形する。
 *
 * - `indentation`: アンカー行を起点に意味のあるブロックを抜き出す
 * - `slice`（既定）: offset/limit で連続行を取る
 */
export function shapeFileContent(content: string, entry: ReadFileEntry): string {
	const limit = entry.limit ?? DEFAULT_LINE_LIMIT

	// 0 バイトのファイルはモード以前に「空」と伝える。reader に渡すと slice/indentation
	// どちらも「1 行目に空文字がある」扱い（`1 | `）になり、中身があるように見えてしまう。
	if (content === "") {
		return EMPTY_FILE_NOTICE
	}

	if ((entry.mode || "slice") === "indentation") {
		const result = readWithIndentation(content, {
			anchorLine: effectiveAnchorLine(entry),
			maxLevels: entry.max_levels,
			includeSiblings: entry.include_siblings,
			includeHeader: entry.include_header,
			limit,
			maxLines: entry.max_lines,
		})

		if (result.wasTruncated && result.includedRanges.length > 0) {
			const [start, end] = result.includedRanges[0]
			return truncationNotice(start, end, result.totalLines, limit, result.content)
		}

		if (result.includedRanges.length > 0) {
			const rangeStr = result.includedRanges.map(([s, e]) => `${s}-${e}`).join(", ")
			return `${result.content}\n\nIncluded ranges: ${rangeStr} (total: ${result.totalLines} lines)`
		}

		return result.content
	}

	// NOTE: read_file offset は外部的には 1 起点。readWithSlice へ渡すときに 0 起点へ変換する。
	const offset1 = entry.offset ?? 1
	const result = readWithSlice(content, Math.max(0, offset1 - 1), limit)

	if (result.wasTruncated) {
		const endLine = offset1 + result.returnedLines - 1
		return truncationNotice(offset1, endLine, result.totalLines, limit, result.content)
	}

	// offset がファイル末尾を越えている。以前はここを "Note: File is empty" に置換して
	// いたため、「offset を直せばよい」ことがモデルに伝わらなかった（indentation モードは
	// 元から reader のメッセージを返しており、slice モードだけがずれていた）。
	//
	// reader 自身のメッセージを素通しにしないのは単位が違うため。reader は 0 起点で
	// 受け取った値をそのまま載せるので、呼び出し側が渡した offset=100 が
	// 「offset 99」と報告されてしまう。文言は reader に合わせつつ 1 起点で言い直す。
	if (offset1 > result.totalLines) {
		return `Error: offset ${offset1} is beyond file end (${result.totalLines} lines)`
	}

	return result.content
}

/**
 * 承認ダイアログから「どの行へ飛ぶか」。
 * slice モードで先頭から読むだけなら移動先を出さない（undefined）。
 */
export function resolveStartLine(entry: ReadFileEntry): number | undefined {
	if (entry.mode === "indentation") {
		return effectiveAnchorLine(entry)
	}

	const offset = entry.offset ?? 1
	return offset > 1 ? offset : undefined
}

/** 承認ダイアログに出す「どの範囲を読むか」の説明。 */
export function describeLineSnippet(entry: ReadFileEntry): string {
	if (entry.mode === "indentation") {
		return `(indentation mode at line ${effectiveAnchorLine(entry)})`
	}

	const limit = entry.limit ?? DEFAULT_LINE_LIMIT
	const offset1 = entry.offset ?? 1

	if (offset1 > 1) {
		return `(lines ${offset1}-${offset1 + limit - 1})`
	}

	// 既定値でも行数上限は必ず見せる（ユーザーが全文だと誤解しないように）。
	return `(up to ${limit} lines)`
}

/**
 * 旧形式 (`{ files: [{ lineRanges }] }`) の行範囲抽出。
 * 範囲は 1 起点の閉区間で、ファイル端を越える指定は切り詰める。出力は `N | 行` 形式。
 */
export function selectLineRanges(rawContent: string, lineRanges: LineRange[]): string {
	const lines = rawContent.split("\n")
	const selected: string[] = []

	for (const range of lineRanges) {
		const startIdx = Math.max(0, range.start - 1)
		const endIdx = Math.min(lines.length - 1, range.end - 1)

		for (let i = startIdx; i <= endIdx; i++) {
			selected.push(`${i + 1} | ${lines[i]}`)
		}
	}

	return selected.join("\n")
}

/**
 * 旧形式で 1 ファイル分の本文を整形する。
 *
 * 行範囲指定があればそれだけを抜き出し、無ければ既定上限で先頭から読む。
 * 切り詰めの告知が**末尾に付く短い一文**である点が新形式（先頭に置く詳しい案内）と違う。
 * 旧形式の出力を変えると既存の会話履歴と食い違うため、意図的にそのまま残している。
 */
export function shapeLegacyFileContent(rawContent: string, lineRanges?: LineRange[]): string {
	if (lineRanges && lineRanges.length > 0) {
		return selectLineRanges(rawContent, lineRanges)
	}

	const result = readWithSlice(rawContent, 0, DEFAULT_LINE_LIMIT)

	return result.wasTruncated
		? `${result.content}\n\n[File truncated: showing ${result.returnedLines} of ${result.totalLines} total lines]`
		: result.content
}
