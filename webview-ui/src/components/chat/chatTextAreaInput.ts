import { ContextMenuOptionType } from "@src/utils/context-mentions"
import { convertToMentionPath } from "@src/utils/path-mentions"

/**
 * `ChatTextArea` の中で DOM ハンドラに埋まっていた純粋な導出。
 *
 * どちらも「入力欄に何を出すか / 何を差し込むか」を決めるだけで、DOM にも React にも
 * 触らない。分割前は前者が `useMemo` の中、後者が `onDrop` ハンドラの中にあり、
 * ドラッグイベントを合成しないと 1 ケースも確かめられなかった（実際どちらも
 * 直接のテストが無かった）。
 */

/** 補完候補 1 件。 */
export interface ContextMenuQueryItem {
	type: ContextMenuOptionType
	value: string
}

export interface ContextMenuQueryInput {
	/** git のコミット候補。そのまま並べる。 */
	gitCommits: ContextMenuQueryItem[]
	/** エディタで開いているタブ。`path` が無いものは候補にしない。 */
	openedTabs: Array<{ path?: string }>
	/** ワークスペースのファイル一覧（先頭スラッシュ無し）。 */
	filePaths: string[]
}

/**
 * `@` 補完に出す候補を組み立てる。
 *
 * 並び順は「特殊項目 → git コミット → 開いているタブ → その他のファイル」。
 * 既に開いているタブと同じパスはファイル側から除く（同じものが二重に出ないように）。
 * 末尾がスラッシュならフォルダとして扱う。
 */
export function buildContextMenuQueryItems(input: ContextMenuQueryInput): ContextMenuQueryItem[] {
	const openedTabPaths = input.openedTabs.filter((tab) => tab.path).map((tab) => `/${tab.path}`)

	return [
		{ type: ContextMenuOptionType.Problems, value: "problems" },
		{ type: ContextMenuOptionType.Terminal, value: "terminal" },
		...input.gitCommits,
		...openedTabPaths.map((path) => ({ type: ContextMenuOptionType.OpenedFile, value: path })),
		...input.filePaths
			.map((file) => `/${file}`)
			.filter((path) => !openedTabPaths.includes(path))
			.map((path) => ({
				type: path.endsWith("/") ? ContextMenuOptionType.Folder : ContextMenuOptionType.File,
				value: path,
			})),
	]
}

export interface MentionInsertionInput {
	/** ドロップされたテキスト。複数ファイルは改行区切りで来る。 */
	text: string
	/** 現在の入力内容。 */
	inputValue: string
	/** 差し込み位置。 */
	cursorPosition: number
	/** メンション記法へ変換するときの基準ディレクトリ。未設定なら絶対パスのまま扱われる。 */
	cwd?: string
}

export interface MentionInsertion {
	newValue: string
	newCursorPosition: number
}

/**
 * ドロップされたパス群をメンションに変換してカーソル位置へ差し込む。
 *
 * 空行は捨てる。差し込むメンションどうしは空白 1 つで区切り、最後のメンションの後にも
 * 空白を 1 つ入れてから元の残りを続ける（続けて入力できるようにするため）。
 *
 * 使えるパスが 1 件も無ければ `undefined`（呼び出し側は何もしない）。
 */
export function buildMentionInsertion(input: MentionInsertionInput): MentionInsertion | undefined {
	const lines = input.text.split(/\r?\n/).filter((line) => line.trim() !== "")

	if (lines.length === 0) {
		return undefined
	}

	const mentions = lines.map((line) => convertToMentionPath(line, input.cwd))
	// メンション間の区切りと、末尾の 1 つ。
	const inserted = `${mentions.join(" ")} `

	return {
		newValue:
			input.inputValue.slice(0, input.cursorPosition) + inserted + input.inputValue.slice(input.cursorPosition),
		newCursorPosition: input.cursorPosition + inserted.length,
	}
}
