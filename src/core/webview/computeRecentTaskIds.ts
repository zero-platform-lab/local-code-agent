import type { HistoryItem } from "@openai-agent/types"

/**
 * 現在のワークスペースの履歴から「最近のタスク ID」一覧を算出する純関数。
 * - 100件以上ある場合は直近7日以内のタスク
 * - 100件未満なら最新100件（または全件）
 * ClineProvider の状態には依存せず、履歴と cwd のみから決まる。
 */
export function computeRecentTaskIds(history: HistoryItem[], cwd: string): string[] {
	const workspaceTasks: HistoryItem[] = []

	for (const item of history) {
		if (!item.ts || !item.task || item.workspace !== cwd) {
			continue
		}

		workspaceTasks.push(item)
	}

	if (workspaceTasks.length === 0) {
		return []
	}

	workspaceTasks.sort((a, b) => b.ts - a.ts)

	if (workspaceTasks.length >= 100) {
		// If we have at least 100 tasks, return tasks from the last 7 days.
		const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
		const recentTaskIds: string[] = []

		for (const item of workspaceTasks) {
			// Stop when we hit tasks older than 7 days.
			if (item.ts < sevenDaysAgo) {
				break
			}

			recentTaskIds.push(item.id)
		}

		return recentTaskIds
	}

	// Otherwise, return the most recent 100 tasks (or all if less than 100).
	return workspaceTasks.slice(0, Math.min(100, workspaceTasks.length)).map((item) => item.id)
}
