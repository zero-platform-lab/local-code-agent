/**
 * 設定ファイルへの書き込みを 1 本に直列化するキュー。
 *
 * `CustomModesManager` が `isWriting` フラグ + 配列 + 2 メソッドで持っていた状態を切り出したもの。
 *
 * ## 再入時の挙動（意図的にこのまま保持している）
 *
 * `enqueue()` が返す promise は「**その操作の完了**」ではなく「**呼び出し側が drain ループを
 * 回し終えたかどうか**」を表す。既に別の drain が走っている最中に呼ばれた場合は、操作を積んだ
 * だけで**待たずに解決する**。
 *
 * 直感には反するが、これは変えてはいけない。`updateCustomMode` / `deleteCustomMode` は
 * `enqueue()` の中から `refreshMergedState()` → `getCustomModesFilePath()` を呼び、そこが
 * さらに（設定ファイル未作成なら）`enqueue()` する。もし「その操作の完了」を待つ実装にすると、
 * 内側の待機を外側の操作が握ったまま drain ループが進めず **デッドロックする**。
 *
 * つまり「積んだだけで返る」ことが再入を成立させている。この性質は
 * `WriteQueue.spec.ts` の "does not wait ..." で固定してある。
 */
export class WriteQueue {
	private draining = false
	private readonly pending: Array<() => Promise<void>> = []

	/** drain ループが回っている間 true。 */
	public get isDraining(): boolean {
		return this.draining
	}

	/** 未処理の操作数。 */
	public get size(): number {
		return this.pending.length
	}

	/**
	 * 操作を積む。drain が走っていなければ、この呼び出しがキューを空になるまで回す。
	 * 走っていれば積むだけで即座に返る（上の再入の説明を参照）。
	 */
	public async enqueue(operation: () => Promise<void>): Promise<void> {
		this.pending.push(operation)

		if (!this.draining) {
			await this.drain()
		}
	}

	private async drain(): Promise<void> {
		if (this.draining || this.pending.length === 0) {
			return
		}

		this.draining = true

		try {
			while (this.pending.length > 0) {
				const operation = this.pending.shift()

				if (operation) {
					await operation()
				}
			}
		} finally {
			this.draining = false
		}
	}
}
