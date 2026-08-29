import { type HistoryItem } from "@openai-agent/types"

import type { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { getModeBySlug, defaultModeSlug } from "../../shared/modes"

export interface HistoryProfileRestorerDeps {
	updateGlobalState(key: "mode" | "listApiConfigMeta", value: unknown): Promise<void>
	/** ワークスペースでモード横断の API 設定ロックが有効かどうか。 */
	isLockApiConfigAcrossModes(): boolean
	providerSettingsManager: Pick<ProviderSettingsManager, "getModeConfigId" | "listConfig" | "getProfile">
	activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	): Promise<unknown>
	log(message: string): void
}

/**
 * タスク履歴からの「モード復元」と「プロバイダプロファイル(API設定)復元」を
 * ClineProvider.createTaskWithHistoryItem から分離したもの。
 * 存在しないモードは default にフォールバックし、historyItem.mode を書き換える。
 * apiConfigName があればモード既定より優先してプロファイルを有効化する。
 */
export class HistoryProfileRestorer {
	constructor(private readonly deps: HistoryProfileRestorerDeps) {}

	/**
	 * @param historyItem 復元対象。mode が存在しなければ default に書き換える（in-place）。
	 * @param skipProfileRestore CLI ランタイム等でプロファイル復元をスキップするか。
	 */
	async restore(historyItem: HistoryItem, skipProfileRestore: boolean): Promise<void> {
		// If the history item has a saved mode, restore it and its associated API configuration.
		if (historyItem.mode) {
			// Validate that the mode still exists
			const modeExists = getModeBySlug(historyItem.mode) !== undefined

			if (!modeExists) {
				// Mode no longer exists, fall back to default mode.
				this.deps.log(
					`Mode '${historyItem.mode}' from history no longer exists. Falling back to default mode '${defaultModeSlug}'.`,
				)
				historyItem.mode = defaultModeSlug
			}

			await this.deps.updateGlobalState("mode", historyItem.mode)

			// Load the saved API config for the restored mode if it exists.
			// Skip mode-based profile activation if historyItem.apiConfigName exists,
			// since the task's specific provider profile will override it anyway.
			const lockApiConfigAcrossModes = this.deps.isLockApiConfigAcrossModes()

			if (!historyItem.apiConfigName && !lockApiConfigAcrossModes && !skipProfileRestore) {
				const savedConfigId = await this.deps.providerSettingsManager.getModeConfigId(historyItem.mode)
				const listApiConfig = await this.deps.providerSettingsManager.listConfig()

				// Update listApiConfigMeta first to ensure UI has latest data.
				await this.deps.updateGlobalState("listApiConfigMeta", listApiConfig)

				// If this mode has a saved config, use it.
				if (savedConfigId) {
					const profile = listApiConfig.find(({ id }) => id === savedConfigId)

					if (profile?.name) {
						try {
							// Check if the profile has actual API configuration (not just an id).
							// In CLI mode, the ProviderSettingsManager may return empty default profiles
							// that only contain 'id' and 'name' fields. Activating such a profile would
							// overwrite the CLI's working API configuration with empty settings.
							const fullProfile = await this.deps.providerSettingsManager.getProfile({
								name: profile.name,
							})
							const hasActualSettings = !!fullProfile.apiProvider

							if (hasActualSettings) {
								await this.deps.activateProviderProfile({ name: profile.name })
							} else {
								// The task will continue with the current/default configuration.
							}
						} catch (error) {
							// Log the error but continue with task restoration.
							this.deps.log(
								`Failed to restore API configuration for mode '${historyItem.mode}': ${
									error instanceof Error ? error.message : String(error)
								}. Continuing with default configuration.`,
							)
							// The task will continue with the current/default configuration.
						}
					}
				}
			}
		}

		// If the history item has a saved API config name (provider profile), restore it.
		// This overrides any mode-based config restoration above, because the task's
		// specific provider profile takes precedence over mode defaults.
		if (historyItem.apiConfigName && !skipProfileRestore) {
			const listApiConfig = await this.deps.providerSettingsManager.listConfig()
			// Keep global state/UI in sync with latest profiles for parity with mode restoration above.
			await this.deps.updateGlobalState("listApiConfigMeta", listApiConfig)
			const profile = listApiConfig.find(({ name }) => name === historyItem.apiConfigName)

			if (profile?.name) {
				try {
					await this.deps.activateProviderProfile(
						{ name: profile.name },
						{ persistModeConfig: false, persistTaskHistory: false },
					)
				} catch (error) {
					// Log the error but continue with task restoration.
					this.deps.log(
						`Failed to restore API configuration '${historyItem.apiConfigName}' for task: ${
							error instanceof Error ? error.message : String(error)
						}. Continuing with current configuration.`,
					)
				}
			} else {
				// Profile no longer exists, log warning but continue
				this.deps.log(
					`Provider profile '${historyItem.apiConfigName}' from history no longer exists. Using current configuration.`,
				)
			}
		} else if (historyItem.apiConfigName && skipProfileRestore) {
			this.deps.log(
				`Skipping restore of provider profile '${historyItem.apiConfigName}' for task ${historyItem.id} in CLI runtime.`,
			)
		}
	}
}
