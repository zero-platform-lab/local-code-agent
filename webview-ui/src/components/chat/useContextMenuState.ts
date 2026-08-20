import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react"

import { ContextMenuOptionType } from "@src/utils/context-mentions"

/**
 * `@` / `/` の補完メニューが持つ状態と、その**不変条件**をまとめて所有する hook。
 *
 * `ChatTextArea` には 18 個の `useState` があるが、そのうちこの 5 個だけが同じ寿命を持つ
 * （メニューが開いたときに生まれ、閉じたときに死ぬ）。残りは寿命が違うので敢えて含めていない
 * — 詳細は下の「含めなかったもの」を参照。
 *
 * 状態を移しただけでは意味が無いので、**クラスタ横断の規則もここへ移している**:
 *
 * 1. メニュー外クリックで閉じる（開いている間だけ document を購読する）
 * 2. 閉じたら `selectedType` を必ず捨てる（種別はメニューが開いている間しか意味を持たない）
 * 3. blur で閉じる。ただしメニュー自身をクリックした場合は閉じない
 *
 * この 3 つは分割前は component 内の 2 つの `useEffect` と `handleBlur` に散っており、
 * 「5 個の state が揃って一貫していること」を保証しているのが誰なのか読めなかった。
 *
 * ## 含めなかったもの（寿命が違う）
 *
 * - `cursorPosition`: `onSelect` / `onMouseUp` / 矢印キーで**常時**追従するキャレット位置。
 *   メニューの開閉と無関係に生き続ける（`handleDrop` はメニューに触れず更新する）。
 * - `intendedCursorPosition`: 「次の描画でキャレットをここへ移す」という**単発**の要求。
 *   `useLayoutEffect` が適用した直後に null へ戻る＝寿命は 1 描画。
 * - `justDeletedSpaceAfterMention`: `handleKeyDown` 内だけで読まれる**1 打鍵**分の記憶。
 *
 * 個々の setter を露出したままなのは意図的。開く/クエリ更新/選択移動の呼び出し側は
 * 場所ごとに設定する組み合わせが違い（例: ある close は index も -1 にするが別の close は
 * しない）、`closeMenu()` のような統一操作に畳むと挙動が変わるため。畳めるのは上の
 * 3 規則だけ、というのが実測の結論。
 */
export interface ContextMenuState {
	showContextMenu: boolean
	searchQuery: string
	selectedMenuIndex: number
	selectedType: ContextMenuOptionType | null

	setShowContextMenu: Dispatch<SetStateAction<boolean>>
	setSearchQuery: Dispatch<SetStateAction<string>>
	setSelectedMenuIndex: Dispatch<SetStateAction<number>>
	setSelectedType: Dispatch<SetStateAction<ContextMenuOptionType | null>>

	/** メニュー上でマウスが押された。直後の blur でメニューを閉じないようにする。 */
	onMenuMouseDown: () => void
	/** テキストエリアが blur した。メニュー自身のクリックが原因なら閉じない。 */
	closeOnBlur: () => void
}

/**
 * @param containerRef メニュー本体を包む要素。外側クリック判定に使う。
 */
export function useContextMenuState(containerRef: RefObject<HTMLDivElement>): ContextMenuState {
	const [showContextMenu, setShowContextMenu] = useState(false)
	const [searchQuery, setSearchQuery] = useState("")
	const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
	const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)

	/**
	 * メニュー本体で mousedown が起きた直後かどうか。
	 *
	 * メニュー項目の click で選択が確定するが、その前に mousedown が textarea を blur させる
	 * （メニューのコンテナは `preventDefault()` しないので実際にフォーカスが外れる）。
	 * blur で素直に閉じてしまうと click が届く前にメニューが消え、選択できなくなる。
	 * このフラグはその **1 回の blur だけ**を抑止するためにある。
	 */
	const [isMouseDownOnMenu, setIsMouseDownOnMenu] = useState(false)

	// 規則 1: メニュー外クリックで閉じる。開いている間だけ購読する。
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
				setShowContextMenu(false)
			}
		}

		if (showContextMenu) {
			document.addEventListener("mousedown", handleClickOutside)
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [showContextMenu, containerRef])

	// 規則 2: 閉じたら種別を捨てる。
	useEffect(() => {
		if (!showContextMenu) {
			setSelectedType(null)
		}
	}, [showContextMenu])

	const onMenuMouseDown = useCallback(() => {
		setIsMouseDownOnMenu(true)
	}, [])

	/**
	 * 規則 3: blur では閉じるが、メニュー自身のクリックが原因なら閉じない。
	 *
	 * フラグは**ここで消費する**。抑止したいのは mousedown が引き起こす 1 回の blur だけで、
	 * それ以降の blur は普通に閉じてほしいため。
	 *
	 * mouseup で戻す案は採らなかった: メニュー上で押してから外へドラッグして離すと
	 * mouseup がメニューに届かず、フラグが立ちっぱなしになる（＝直そうとしているバグの再発）。
	 * blur は mousedown の直後に必ず 1 回来るので、消費点として確実。
	 */
	const closeOnBlur = useCallback(() => {
		if (isMouseDownOnMenu) {
			// この blur はメニュークリックによるもの。閉じずに、抑止を使い切る。
			setIsMouseDownOnMenu(false)
			return
		}

		setShowContextMenu(false)
	}, [isMouseDownOnMenu])

	return {
		showContextMenu,
		searchQuery,
		selectedMenuIndex,
		selectedType,
		setShowContextMenu,
		setSearchQuery,
		setSelectedMenuIndex,
		setSelectedType,
		onMenuMouseDown,
		closeOnBlur,
	}
}
