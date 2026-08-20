/**
 * Task の「tool 実行ミス」系 counter を凝集した collaborator。
 *
 * 元は Task class に散らばっていた 4 field を集約:
 * - `count`（旧 `consecutiveMistakeCount`）: 連続ミス回数の主 counter。tool 全体で
 *   `task.consecutiveMistakeCount++` / `= 0` パターンで 170+ 箇所参照されていた。
 * - `limit`（旧 `consecutiveMistakeLimit`）: 中断しきい値。TaskOptions 経由で外部設定。
 * - `applyDiffMisses`（旧 `consecutiveMistakeCountForApplyDiff`）: apply_diff の失敗回数
 *   をファイル別に追跡（Map<relPath, number>）。3 箇所（ApplyDiffTool）から参照。
 * - `editFileMisses`（旧 `consecutiveMistakeCountForEditFile`）: edit_file 用（EditFileTool）。
 *
 * checkMistakeLimit module が `count >= limit` の判定を行い、越えたら mistake_limit_reached
 * ask を発火する（そこで `count = 0` にリセットされる）。
 */
export class MistakeTracker {
	count = 0
	readonly applyDiffMisses = new Map<string, number>()
	readonly editFileMisses = new Map<string, number>()

	constructor(public limit: number) {}
}
