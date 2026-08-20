import { type HistoryItem, AgentEventName } from "@openai-agent/types"

import type { Mode } from "../../shared/modes"
import type { ProviderSettingsManager } from "../config/ProviderSettingsManager"

/** モード切替時に扱う現在タスクの最小表面。 */
export interface ModeSwitchTask {
	readonly taskId: string
	/** mode の所有者（Task の `modeState` collaborator）。 */
	readonly modeState: { mode: string | undefined }
	emit(eventName: AgentEventName, ...args: unknown[]): void
}

export interface ModeControllerDeps {
	readonly providerSettingsManager: ProviderSettingsManager
	getCurrentTask(): ModeSwitchTask | undefined
	getTaskHistoryItem(id: string): HistoryItem | undefined
	getTaskHistory(): HistoryItem[]
	updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]>
	setCurrentTaskInternalMode(task: ModeSwitchTask, mode: Mode): void
	updateGlobalState(key: "mode" | "listApiConfigMeta", value: unknown): Promise<void>
	getCurrentApiConfigName(): string | undefined
	isLockApiConfigAcrossModes(): boolean
	activateProviderProfile(args: { name: string }): Promise<void>
	postStateToWebview(): Promise<void>
	emit(eventName: AgentEventName, ...args: unknown[]): void
	log(message: string): void
}

/**
 * モード切替（handleModeSwitch）のオーケストレーションを ClineProvider から分離したもの。
 * タスク履歴へのモード永続化、モード別 API プロファイルのロード、状態通知を担う。
 */
export class ModeController {
	constructor(private readonly deps: ModeControllerDeps) {}

	async handleModeSwitch(newMode: Mode): Promise<void> {
		const task = this.deps.getCurrentTask()

		if (task) {
			task.emit(AgentEventName.TaskModeSwitched, task.taskId, newMode)

			try {
				// Update the task history with the new mode first.
				const taskHistoryItem =
					this.deps.getTaskHistoryItem(task.taskId) ??
					this.deps.getTaskHistory().find((item) => item.id === task.taskId)

				if (taskHistoryItem) {
					await this.deps.updateTaskHistory({ ...taskHistoryItem, mode: newMode })
				}

				// Only update the task's mode after successful persistence.
				this.deps.setCurrentTaskInternalMode(task, newMode)
			} catch (error) {
				// If persistence fails, log the error but don't update the in-memory state.
				this.deps.log(
					`Failed to persist mode switch for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				)

				// This ensures the in-memory state remains consistent with persisted state.
				throw error
			}
		}

		await this.deps.updateGlobalState("mode", newMode)

		this.deps.emit(AgentEventName.ModeChanged, newMode)

		// If workspace lock is on, keep the current API config — don't load mode-specific config
		if (this.deps.isLockApiConfigAcrossModes()) {
			await this.deps.postStateToWebview()
			return
		}

		// Load the saved API config for the new mode if it exists.
		const savedConfigId = await this.deps.providerSettingsManager.getModeConfigId(newMode)
		const listApiConfig = await this.deps.providerSettingsManager.listConfig()

		// Update listApiConfigMeta first to ensure UI has latest data.
		await this.deps.updateGlobalState("listApiConfigMeta", listApiConfig)

		// If this mode has a saved config, use it.
		if (savedConfigId) {
			const profile = listApiConfig.find(({ id }) => id === savedConfigId)

			if (profile?.name) {
				// Check if the profile has actual API configuration (not just an id).
				// In CLI mode, the ProviderSettingsManager may return empty default profiles
				// that only contain 'id' and 'name' fields. Activating such a profile would
				// overwrite the CLI's working API configuration with empty settings.
				// Skip activation if the profile has no apiProvider set - this indicates
				// an unconfigured/empty profile.
				const fullProfile = await this.deps.providerSettingsManager.getProfile({ name: profile.name })
				const hasActualSettings = !!fullProfile.apiProvider

				if (hasActualSettings) {
					await this.deps.activateProviderProfile({ name: profile.name })
				} else {
					// The task will continue with the current/default configuration.
				}
			} else {
				// The task will continue with the current/default configuration.
			}
		} else {
			// If no saved config for this mode, save current config as default.
			const currentApiConfigNameAfter = this.deps.getCurrentApiConfigName()

			if (currentApiConfigNameAfter) {
				const config = listApiConfig.find((c) => c.name === currentApiConfigNameAfter)

				if (config?.id) {
					await this.deps.providerSettingsManager.setModeConfig(newMode, config.id)
				}
			}
		}

		await this.deps.postStateToWebview()
	}
}
