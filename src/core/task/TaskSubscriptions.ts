/**
 * Task が外部 emitter に張る購読の「登録と解除」を一箇所で所有する registry。
 *
 * 分割前は登録が Task constructor、解除が `disposeTask` にあり、その 2 箇所を
 * `Task.messageQueueStateChangedHandler` / `Task.providerProfileChangeListener` と
 * いう mutable public field で繋いでいた（= 購読の寿命が Task の public 表面に
 * 漏れていた）。購読ごとに「張った側が畳み方も返す」形にして、Task は
 * `subscriptions.add(...)` と `subscriptions.disposeAll()` だけを知る。
 */

/** 1 件の購読。`dispose()` は冪等であること（disposeAll は 1 度しか呼ばないが二重呼び出しに耐える想定）。 */
export interface TaskSubscription {
	/** dispose 失敗時のログに出す識別子。 */
	readonly label: string
	dispose(): void
}

export class TaskSubscriptions {
	private readonly subscriptions: TaskSubscription[] = []
	private disposed = false

	/**
	 * 購読を登録する。`undefined` は「張らなかった」を意味するので黙って無視する
	 * （provider が emitter interface を持たない test mock などで起きる）。
	 *
	 * 既に `disposeAll()` 済みなら即座に畳む。dispose 後に非同期で張られた購読が
	 * 生き残ってリークするのを防ぐため。
	 */
	public add(subscription: TaskSubscription | undefined): void {
		if (!subscription) {
			return
		}

		if (this.disposed) {
			this.disposeOne(subscription)
			return
		}

		this.subscriptions.push(subscription)
	}

	/** 現在生きている購読の label 一覧（テスト・デバッグ用）。 */
	public get labels(): string[] {
		return this.subscriptions.map((subscription) => subscription.label)
	}

	public get size(): number {
		return this.subscriptions.length
	}

	public get isDisposed(): boolean {
		return this.disposed
	}

	/**
	 * 全購読を解除する。1 件が throw しても残りは必ず試す（リーク回避が最優先、
	 * `disposeTask` の他 cleanup と同じ方針）。自身は throw しない。
	 */
	public disposeAll(): void {
		this.disposed = true

		const pending = this.subscriptions.splice(0)

		for (const subscription of pending) {
			this.disposeOne(subscription)
		}
	}

	private disposeOne(subscription: TaskSubscription): void {
		try {
			subscription.dispose()
		} catch (error) {
			console.error(`Error disposing task subscription (${subscription.label}):`, error)
		}
	}
}
