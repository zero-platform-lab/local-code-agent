/**
 * ファイル監視の debounce 期間より少し長く待ってからフラグを戻す。
 * 監視側の debounce は 500ms なので、それを跨いで抑止し続ける必要がある。
 */
const DEFAULT_SUPPRESSION_MS = 600

/**
 * 「自分で書いた設定ファイルの変更通知を無視する」ためのフラグを所有する。
 *
 * MCP 設定ファイルは file watcher で監視していて、変更されるとサーバを再起動する。
 * ところがタイムアウト変更や alwaysAllow のトグルなど**拡張自身の書き込み**でも watcher は
 * 発火するため、そのままだと設定を弄るたびにサーバが落ちて再接続する。
 *
 * 書き込みを {@link run} で包むと、書き込み中〜watcher の debounce が明けるまでの間
 * {@link isActive} が true になり、監視側はその間の変更を無視できる。
 *
 * McpHub が `isProgrammaticUpdate` / `flagResetTimer` の 2 フィールドと、2 箇所に複製された
 * 解除タイマー処理として抱えていたものを、タイマー所有ごと切り出したもの。
 */
export class ProgrammaticWriteGuard {
	private active = false
	private resetTimer?: ReturnType<typeof setTimeout>

	constructor(private readonly suppressionMs: number = DEFAULT_SUPPRESSION_MS) {}

	/** 拡張自身の書き込みに由来する変更通知を無視すべきか。 */
	get isActive(): boolean {
		return this.active
	}

	/**
	 * 書き込みをガードで包む。
	 *
	 * 書き込みが失敗しても解除タイマーは張る（try/finally）。解除は待たない
	 * ＝ 呼び出し側は watcher の debounce をブロックせずに次へ進める。
	 */
	async run<T>(write: () => Promise<T>): Promise<T> {
		this.clearResetTimer()
		this.active = true

		try {
			return await write()
		} finally {
			// Reset flag after watcher debounce period (non-blocking)
			this.resetTimer = setTimeout(() => {
				this.active = false
				this.resetTimer = undefined
			}, this.suppressionMs)
		}
	}

	/** 保留中の解除タイマーを捨ててフラグを落とす（dispose 用）。 */
	dispose(): void {
		this.clearResetTimer()
		this.active = false
	}

	private clearResetTimer(): void {
		if (this.resetTimer) {
			clearTimeout(this.resetTimer)
			this.resetTimer = undefined
		}
	}
}
