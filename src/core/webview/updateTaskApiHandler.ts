import { type ProviderSettings, getModelId } from "@openai-agent/types"

/**
 * API ハンドラ更新の対象となるタスクの最小表面（実 Task が構造的に満たす）。
 * 具象 Task を import しないので、この判定ロジックは単体でテストできる。
 */
export interface ApiHandlerSyncTask {
	apiConfiguration?: ProviderSettings
	updateApiConfiguration(providerSettings: ProviderSettings): unknown
}

/**
 * タスクの API ハンドラを新しい provider settings に追従させる。
 *
 * 再構築するのは
 * - provider または model が変わったとき、または
 * - 明示的に強制されたとき（プロファイル切替/保存のように headers/baseUrl/tier など
 *   provider・model 以外の設定が変わりうる操作）
 *
 * それ以外は `apiConfiguration` の同期だけ行う（ハンドラ再構築は高価なため）。
 *
 * @param task 現在タスク。無ければ何もしない。
 */
export function updateTaskApiHandlerIfNeeded(
	task: ApiHandlerSyncTask | undefined,
	providerSettings: ProviderSettings,
	options: { forceRebuild?: boolean } = {},
): void {
	if (!task) {
		return
	}

	const { forceRebuild = false } = options

	// Determine if we need to rebuild using the previous configuration snapshot
	const prevConfig = task.apiConfiguration
	const prevProvider = prevConfig?.apiProvider
	const prevModelId = prevConfig ? getModelId(prevConfig) : undefined
	const newProvider = providerSettings.apiProvider
	const newModelId = getModelId(providerSettings)

	const needsRebuild = forceRebuild || prevProvider !== newProvider || prevModelId !== newModelId

	if (needsRebuild) {
		// Use updateApiConfiguration which handles both API handler rebuild and parser sync.
		// Note: updateApiConfiguration is declared async but has no actual async operations,
		// so we can safely call it without awaiting.
		task.updateApiConfiguration(providerSettings)
	} else {
		// No rebuild needed, just sync apiConfiguration
		task.apiConfiguration = providerSettings
	}
}
