import * as diff from "diff"
import stripBom from "strip-bom"

/**
 * `DiffViewProvider` の中にあった「差分の組み立て・判定」だけを取り出した純関数群。
 *
 * 元は vscode editor API の呼び出しと同じメソッドに同居していたため、EOL 正規化や
 * ユーザー編集の検出といった**判断**を確かめるのに、エディタ・タブグループ・診断まで
 * まるごと mock した状態で `saveChanges()` を通す必要があった。
 *
 * ここは vscode に依存しない（`diff` / `strip-bom` は純粋な npm パッケージ）。
 */

/**
 * BOM を取り除く。多重に付いていることがあるので、変化しなくなるまで繰り返す
 * （`stripBom` は 1 個しか外さない）。
 */
export function stripAllBoms(input: string): string {
	let result = input
	let previous

	do {
		previous = result
		result = stripBom(result)
	} while (result !== previous)

	return result
}

/**
 * 元ファイルが末尾改行で終わっていたら、書き込む内容にも末尾改行を残す。
 * ストリーミング中に最後の改行が落ちて「差分に見える」のを防ぐため。
 */
export function preserveTrailingNewline(originalContent: string | undefined, accumulatedContent: string): string {
	const hadTrailingNewline = originalContent?.endsWith("\n")

	return hadTrailingNewline && !accumulatedContent.endsWith("\n") ? `${accumulatedContent}\n` : accumulatedContent
}

export interface SaveComparison {
	/** 比較に使った改行コード。エージェントが書いた内容の側に合わせる。 */
	eol: "\r\n" | "\n"
	normalizedNewContent: string
	normalizedEditedContent: string
	/** ユーザーが承認前にエディタ上で手を入れたか。 */
	userEdited: boolean
}

/**
 * 保存時に「エージェントが書いた内容」と「エディタ上の実際の内容」を比べる。
 *
 * 改行コードだけが違う差分を拾ってしまわないよう、**エージェント側の EOL に寄せてから**
 * 比較する。内容の trim はしない（末尾空白も差分として意味を持つため）。
 */
export function compareSavedContent(newContent: string, editedContent: string): SaveComparison {
	const eol = newContent.includes("\r\n") ? "\r\n" : "\n"
	const normalizedNewContent = newContent.replace(/\r\n|\n/g, eol)
	const normalizedEditedContent = editedContent.replace(/\r\n|\n/g, eol)

	return {
		eol,
		normalizedNewContent,
		normalizedEditedContent,
		userEdited: normalizedEditedContent !== normalizedNewContent,
	}
}

/**
 * 最初に差分が現れる行番号（0 起点）。差分が無ければ undefined。
 * 削除された部分は「元ファイル側の行」なので行数に数えない。
 */
export function findFirstDiffLine(originalContent: string, currentContent: string): number | undefined {
	let lineCount = 0

	for (const part of diff.diffLines(originalContent, currentContent)) {
		if (part.added || part.removed) {
			return lineCount
		}

		if (!part.removed) {
			lineCount += part.count || 0
		}
	}

	return undefined
}

export interface WriteResultPayloadInput {
	relPath: string
	isNewFile: boolean
	/** ユーザーが承認前に加えた編集の差分（あれば）。 */
	userEdits?: string
	/** 保存後に増えた診断のメッセージ（あれば）。 */
	newProblemsMessage?: string
}

/**
 * ファイル書き込み結果としてモデルへ返す JSON を組む。
 *
 * `notice` はユーザー編集の有無で 1 文増える。ここを純関数にしてあるので、
 * 「再読み込み不要」の案内文がいつ変わるかを直接テストできる。
 */
export function buildWriteResultPayload(input: WriteResultPayloadInput): string {
	const notices = [
		"You do not need to re-read the file, as you have seen all changes",
		"Proceed with the task using these changes as the new baseline.",
		...(input.userEdits
			? [
					"If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.",
				]
			: []),
	]

	const result: {
		path: string
		operation: "created" | "modified"
		notice: string
		user_edits?: string
		problems?: string
	} = {
		path: input.relPath,
		operation: input.isNewFile ? "created" : "modified",
		notice: notices.join(" "),
	}

	if (input.userEdits) {
		result.user_edits = input.userEdits
	}

	if (input.newProblemsMessage) {
		result.problems = input.newProblemsMessage
	}

	return JSON.stringify(result)
}

/** 新しく増えた診断を、モデルへ渡すメッセージに整形する。差分が無ければ空文字。 */
export function formatNewProblemsMessage(newProblems: string): string {
	return newProblems.length > 0 ? `\n\nNew problems detected after saving the file:\n${newProblems}` : ""
}
