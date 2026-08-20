import { ContextMenuOptionType, type ContextMenuQueryItem } from "@src/utils/context-mentions"

/**
 * 補完メニューを開いている間のキー操作のうち、**純粋な計算**だけを取り出したもの。
 *
 * `handleKeyDown` の中で ArrowUp/Down と Enter/Tab の 2 分岐がこの計算をしていた。
 * どちらも `getContextMenuOptions(...)` を同じ引数で呼び直し、同じ 3 種類の除外条件を
 * 書き下していた（＝除外条件が 2 箇所に重複）。ここに集約したので、選択が端で
 * 折り返す挙動や「選択できない項目を飛ばす」規則を素でテストできる。
 *
 * ## なぜ useContextMenuState に入れないか
 *
 * この 2 分岐は `queryItems` / `fileSearchResults` / `allModes` / `commands` /
 * `handleMentionSelect` というコンポーネント側のデータを 5 つ読む。hook へ寄せると
 * 4 state の hook がコンポーネントのデータ世界ごと依存することになり、hook が持つ
 * 3 つの不変条件（外側クリック・種別クリア・blur）はこれらを一切必要としない。
 * よってイベントの振り分けはコンポーネントに残し、計算だけをここへ置く。
 */

/**
 * 選択できる項目か。見出し・結果なし・URL は表示されるだけで選べない。
 *
 * 分割前は同じ 3 条件が「矢印移動時の filter」と「Enter/Tab の確定ガード」に
 * 別々に書かれていた。
 */
export function isSelectableOption(option: { type: ContextMenuOptionType }): boolean {
	return (
		option.type !== ContextMenuOptionType.URL &&
		option.type !== ContextMenuOptionType.NoResults &&
		option.type !== ContextMenuOptionType.SectionHeader
	)
}

/**
 * 矢印キーで選択を 1 つ動かした後の index を返す（`options` 内の index）。
 *
 * - 候補が空なら現在位置を保つ
 * - 選択できる項目が 1 つも無ければ -1（選択なし）
 * - 端に来たら反対側へ折り返す
 *
 * 現在位置が「選択できない項目」または範囲外のときは `currentSelectableIndex` が -1 に
 * なる。その結果 Down では先頭、Up では末尾から 2 番目に飛ぶ。分割前からの挙動なので
 * そのまま保持している（テストで固定済み）。
 *
 * 比較は**参照同一性**で行う。候補には値の等しい項目が混ざり得るため。
 *
 * @param direction ArrowUp なら -1、ArrowDown なら 1
 */
export function moveMenuSelection(options: ContextMenuQueryItem[], prevIndex: number, direction: -1 | 1): number {
	if (options.length === 0) {
		return prevIndex
	}

	const selectable = options.filter(isSelectableOption)

	if (selectable.length === 0) {
		return -1
	}

	const currentSelectableIndex = selectable.findIndex((option) => option === options[prevIndex])
	const nextSelectableIndex = (currentSelectableIndex + direction + selectable.length) % selectable.length

	return options.findIndex((option) => option === selectable[nextSelectableIndex])
}

/**
 * Enter / Tab で確定できる項目を返す。選べない項目や範囲外なら `undefined`
 * （呼び出し側は「何もしない」を選ぶ）。
 */
export function selectableOptionAt(options: ContextMenuQueryItem[], index: number): ContextMenuQueryItem | undefined {
	const option = options[index]

	return option && isSelectableOption(option) ? option : undefined
}
