import { type HistoryItem } from "@openai-agent/types"

export interface GlobalStateHistoryWriteThroughDeps {
	/** 書き戻す対象（per-task ファイル側の現在値）。 */
	getItems(): HistoryItem[]
	/** globalState への書き込み。 */
	write(items: HistoryItem[]): Promise<void>
	log(message: string): void
	/** デバウンス間隔。既定 5 秒。 */
	debounceMs?: number
}

const DEFAULT_DEBOUNCE_MS = 5000

/**
 * タスク履歴の globalState への write-through（ダウングレード互換用の二重書き）を所有する。
 *
 * per-task ファイルが正となったあとも、古いバージョンへ戻したときのために globalState へ
 * 履歴を書き戻している。毎ミューテーションで書くと重いのでデバウンスするが、その
 * タイマーは ClineProvider の関心事ではないため、タイマー所有ごとここへ切り出した。
 *
 * `schedule()` は「そのうち書く」、`flush()` は「保留を捨てて今すぐ書く」（dispose 用）。
 */
export class GlobalStateHistoryWriteThrough {
	private timer: ReturnType<typeof setTimeout> | null = null

	constructor(private readonly deps: GlobalStateHistoryWriteThroughDeps) {}

	/** 書き戻しをデバウンス予約する（既存の予約があれば取り消して張り直す）。 */
	schedule(): void {
		if (this.timer) {
			clearTimeout(this.timer)
		}

		this.timer = setTimeout(async () => {
			this.timer = null

			try {
				await this.deps.write(this.deps.getItems())
			} catch (err) {
				this.deps.log(
					`[scheduleGlobalStateWriteThrough] Failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS)
	}

	/** 保留中の予約を取り消し、即座に書き戻す（結果は待たない）。 */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}

		this.deps.write(this.deps.getItems()).catch((err) => {
			this.deps.log(`[flushGlobalStateWriteThrough] Failed: ${err instanceof Error ? err.message : String(err)}`)
		})
	}
}
