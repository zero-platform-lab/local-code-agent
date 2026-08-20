/**
 * 単一値の TTL キャッシュ。
 *
 * `CustomModesManager` が `cachedModes` / `cachedAt` / `static cacheTTL` / `clearCache()` の
 * 4 メンバで持っていた状態を切り出したもの。「まだ有効か」の判定（TTL 境界ちょうどは無効）が
 * 1 箇所に閉じるので、時計を差し替えて素でテストできる。
 */
export class TtlCache<T> {
	private value: T | undefined
	private storedAt = 0
	private hasValue = false

	/**
	 * @param ttlMs 有効期間（ミリ秒）。経過時間が **これ以上**になった時点で無効。
	 * @param now テスト用の時計差し替え。既定は毎回 `Date.now()` を引く
	 *   （`Date.now` を束縛して持つと、後から `Date.now` を差し替えるテストに追随できない）。
	 */
	constructor(
		private readonly ttlMs: number,
		private readonly now: () => number = () => Date.now(),
	) {}

	/** 有効なキャッシュがあればその値、無ければ `undefined`。 */
	public get(): T | undefined {
		if (!this.hasValue || this.now() - this.storedAt >= this.ttlMs) {
			return undefined
		}

		return this.value
	}

	public set(value: T): void {
		this.value = value
		this.storedAt = this.now()
		this.hasValue = true
	}

	/** 明示的な無効化。書き込み後・watcher 発火後に呼ぶ。 */
	public clear(): void {
		this.value = undefined
		this.storedAt = 0
		this.hasValue = false
	}
}
