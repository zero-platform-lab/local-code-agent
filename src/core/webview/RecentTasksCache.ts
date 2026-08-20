import { type HistoryItem } from "@openai-agent/types"

import { computeRecentTaskIds } from "./computeRecentTaskIds"

export interface RecentTasksCacheDeps {
	/** 全タスク履歴（ストアの現在値）。 */
	getHistory(): HistoryItem[]
	/** 「最近」の判定に使うワークスペースディレクトリ。 */
	getWorkspaceDir(): string
}

/**
 * 「現在ワークスペースの最近タスク id 一覧」の memoize を所有する。
 *
 * ClineProvider が private field で持っていた `recentTasksCache` を、キャッシュ無効化の
 * 呼び出し元（履歴 upsert / 削除 / 一括削除）から見える形の collaborator に切り出したもの。
 * 履歴が変わる操作は `invalidate()` を呼ぶ責務を負い、再計算のタイミングは本クラスが決める。
 */
export class RecentTasksCache {
	private cache?: string[]

	constructor(private readonly deps: RecentTasksCacheDeps) {}

	/** キャッシュ済みならそれを、無ければ履歴から計算して記憶する。 */
	get(): string[] {
		if (this.cache) {
			return this.cache
		}

		this.cache = computeRecentTaskIds(this.deps.getHistory(), this.deps.getWorkspaceDir())
		return this.cache
	}

	/** 履歴が変化したので次回 `get()` で再計算させる。 */
	invalidate(): void {
		this.cache = undefined
	}
}
