import { useCallback, useEffect, useMemo, useRef } from "react"
import { LRUCache } from "lru-cache"

import type { ClineMessage } from "@openai-agent/types"

/**
 * 「このメッセージを一度でも表示したか」の記憶と、その寿命管理をまとめて所有する hook。
 *
 * `selectVisibleMessages` の表示規則（#259 で純関数化）は「一度出したものは消さない」を
 * 判断材料にする。その記憶が LRU キャッシュで、分割前は `ChatView` の中で
 * **1 つの ref と 4 つの effect に散っていた**（宣言 + タスク切替時クリア + 非表示時クリア +
 * アンマウント時クリア + 60 秒ごとの間引き）。どの effect がキャッシュの一貫性を
 * 保っているのかが読めない状態だったので、値と規則を一緒にここへ移した。
 *
 * ## なぜ間引きだけ別 hook なのか
 *
 * 間引きは「今の全メッセージ」と「表示中の直近ぶん」の両方を要る。ところが後者
 * (`visibleMessages`) は `hasBeenSeen` を使って**導出される**ので、キャッシュ本体の hook に
 * 引数として渡せない（循環する）。そこで導出後に呼ぶ 2 つ目の hook に分けている。
 * 規則そのものは両方ここにあり、コンポーネント側には残っていない。
 */

/** 記憶しておく直近メッセージ数と、その保持時間。 */
const MAX_REMEMBERED = 100
const REMEMBER_TTL_MS = 1000 * 60 * 5

/** 間引きの間隔。 */
const PRUNE_INTERVAL_MS = 60000

export interface EverVisibleMessages {
	/** その ts のメッセージを既に一度表示したか。 */
	hasBeenSeen: (ts: number) => boolean
	/** 表示したものとして覚える。 */
	remember: (messages: ClineMessage[]) => void
	/**
	 * 「もう存在しない、かつ表示中でもない」記憶を捨てる。
	 * 現存メッセージと表示中ぶんの両方に無いものだけを対象にする。
	 */
	prune: (currentMessages: ClineMessage[], viewportMessages: ClineMessage[]) => void
}

export interface EverVisibleMessagesInput {
	/** チャットが隠れている間は記憶を持ち越さない。 */
	isHidden: boolean
	/** タスクが切り替わったら記憶を捨てる。 */
	taskTs: number | undefined
}

export function useEverVisibleMessages({ isHidden, taskTs }: EverVisibleMessagesInput): EverVisibleMessages {
	const cacheRef = useRef<LRUCache<number, boolean>>(new LRUCache({ max: MAX_REMEMBERED, ttl: REMEMBER_TTL_MS }))

	// 規則 1: タスクが変わったら別の会話なので記憶を捨てる。
	useEffect(() => {
		cacheRef.current.clear()
	}, [taskTs])

	// 規則 2: 非表示になったら捨てる。再表示時は作り直させる。
	useEffect(() => {
		if (isHidden) {
			cacheRef.current.clear()
		}
	}, [isHidden])

	// 規則 3: アンマウント時に捨てる。
	useEffect(() => {
		const cache = cacheRef.current
		return () => {
			cache.clear()
		}
	}, [])

	const hasBeenSeen = useCallback((ts: number) => cacheRef.current.has(ts), [])

	const remember = useCallback((messages: ClineMessage[]) => {
		for (const message of messages) {
			cacheRef.current.set(message.ts, true)
		}
	}, [])

	const prune = useCallback((currentMessages: ClineMessage[], viewportMessages: ClineMessage[]) => {
		const cache = cacheRef.current
		const currentIds = new Set(currentMessages.map((m) => m.ts))
		const viewportIds = new Set(viewportMessages.map((m) => m.ts))

		cache.forEach((_value, key) => {
			if (!currentIds.has(key) && !viewportIds.has(key)) {
				cache.delete(key)
			}
		})
	}, [])

	// 返り値は毎レンダー同一にする。呼び出し側の useMemo / useEffect 依存配列に入るため、
	// 新しいオブジェクトを返すと visibleMessages のメモ化と間引きタイマーが毎回作り直される。
	return useMemo(() => ({ hasBeenSeen, remember, prune }), [hasBeenSeen, remember, prune])
}

/**
 * 規則 4: 一定間隔で記憶を間引く。
 *
 * `visibleMessages` が `hasBeenSeen` から導出されるため、キャッシュ本体の hook とは
 * 分けて導出後に呼ぶ（上の説明を参照）。
 */
export function usePeriodicPrune(
	{ prune }: Pick<EverVisibleMessages, "prune">,
	currentMessages: ClineMessage[],
	visibleMessages: ClineMessage[],
	/** 表示中ぶんの切り出し。分割前と同じく interval の中で毎回計算する。 */
	selectViewport: (visible: ClineMessage[]) => ClineMessage[],
): void {
	useEffect(() => {
		const interval = setInterval(() => prune(currentMessages, selectViewport(visibleMessages)), PRUNE_INTERVAL_MS)

		return () => clearInterval(interval)
	}, [prune, currentMessages, visibleMessages, selectViewport])
}
