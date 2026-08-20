import * as vscode from "vscode"

import {
	type ProviderSettings,
	type ProviderSettingsEntry,
	type HistoryItem,
	AgentEventName,
} from "@openai-agent/types"

import type { Mode } from "../../shared/modes"
import { t } from "../../i18n"
import type { ContextProxy } from "../config/ContextProxy"
import type { ProviderSettingsManager } from "../config/ProviderSettingsManager"

/** 委譲先タスクのうち、sticky provider profile 更新に必要な最小表面。 */
export interface ProviderProfileStickyTask {
	readonly taskId: string
	/** API config 名の所有者（Task の `modeState` collaborator）。 */
	readonly modeState: { apiConfigName: string | undefined }
}

/**
 * ProviderProfileController が ClineProvider から必要とする依存。
 */
export interface ProviderProfileDeps {
	readonly providerSettingsManager: ProviderSettingsManager
	readonly contextProxy: ContextProxy
	getState(): Promise<{ mode: Mode; listApiConfigMeta?: ProviderSettingsEntry[]; currentApiConfigName?: string }>
	updateGlobalState(key: "listApiConfigMeta" | "currentApiConfigName", value: unknown): Promise<void>
	getTaskHistory(): HistoryItem[]
	getTaskHistoryItem(id: string): HistoryItem | undefined
	updateTaskApiHandlerIfNeeded(providerSettings: ProviderSettings, options: { forceRebuild?: boolean }): void
	postStateToWebview(): Promise<void>
	emit(eventName: AgentEventName, ...args: unknown[]): void
	log(message: string): void
	getCurrentTask(): ProviderProfileStickyTask | undefined
	updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]>
}

/**
 * provider profile（API 設定プロファイル）の CRUD・有効化・現在タスクへの sticky 反映を
 * ClineProvider から分離したもの。状態の所有は ClineProvider 側のまま、各操作は deps 経由で委譲する。
 */
export class ProviderProfileController {
	constructor(private readonly deps: ProviderProfileDeps) {}

	getProviderProfileEntries(): ProviderSettingsEntry[] {
		return this.deps.contextProxy.getValues().listApiConfigMeta || []
	}

	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.getProviderProfileEntries().find((profile) => profile.name === name)
	}

	hasProviderProfileEntry(name: string): boolean {
		return !!this.getProviderProfileEntry(name)
	}

	async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		try {
			const id = await this.deps.providerSettingsManager.saveConfig(name, providerSettings)

			if (activate) {
				const { mode } = await this.deps.getState()

				await Promise.all([
					this.deps.updateGlobalState(
						"listApiConfigMeta",
						await this.deps.providerSettingsManager.listConfig(),
					),
					this.deps.updateGlobalState("currentApiConfigName", name),
					this.deps.providerSettingsManager.setModeConfig(mode, id),
					this.deps.contextProxy.setProviderSettings(providerSettings),
				])

				// Change the provider for the current task.
				this.deps.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

				// Keep the current task's sticky provider profile in sync with the newly-activated profile.
				await this.persistStickyProviderProfileToCurrentTask(name)
			} else {
				await this.deps.updateGlobalState(
					"listApiConfigMeta",
					await this.deps.providerSettingsManager.listConfig(),
				)
			}

			await this.deps.postStateToWebview()
			return id
		} catch (error) {
			this.deps.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			vscode.window.showErrorMessage(t("common:errors.create_api_config"))
			return undefined
		}
	}

	async deleteProviderProfile(profileToDelete: ProviderSettingsEntry): Promise<void> {
		const globalSettings = this.deps.contextProxy.getValues()
		let profileToActivate: string | undefined = globalSettings.currentApiConfigName

		if (profileToDelete.name === profileToActivate) {
			profileToActivate = this.getProviderProfileEntries().find(({ name }) => name !== profileToDelete.name)?.name
		}

		if (!profileToActivate) {
			throw new Error("You cannot delete the last profile")
		}

		const entries = this.getProviderProfileEntries().filter(({ name }) => name !== profileToDelete.name)

		await this.deps.contextProxy.setValues({
			...globalSettings,
			currentApiConfigName: profileToActivate,
			listApiConfigMeta: entries,
		})

		await this.deps.postStateToWebview()
	}

	async persistStickyProviderProfileToCurrentTask(apiConfigName: string): Promise<void> {
		const task = this.deps.getCurrentTask()
		if (!task) {
			return
		}

		try {
			// Update in-memory state immediately so sticky behavior works even before the task has
			// been persisted into taskHistory (it will be captured on the next save).
			task.modeState.apiConfigName = apiConfigName

			const taskHistoryItem =
				this.deps.getTaskHistoryItem(task.taskId) ??
				this.deps.getTaskHistory().find((item) => item.id === task.taskId)

			if (taskHistoryItem) {
				await this.deps.updateTaskHistory({ ...taskHistoryItem, apiConfigName })
			}
		} catch (error) {
			// If persistence fails, log the error but don't fail the profile switch.
			this.deps.log(
				`Failed to persist provider profile switch for task ${task.taskId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	): Promise<void> {
		const { name, id, ...providerSettings } = await this.deps.providerSettingsManager.activateProfile(args)

		const persistModeConfig = options?.persistModeConfig ?? true
		const persistTaskHistory = options?.persistTaskHistory ?? true

		// See `upsertProviderProfile` for a description of what this is doing.
		await Promise.all([
			this.deps.contextProxy.setValue("listApiConfigMeta", await this.deps.providerSettingsManager.listConfig()),
			this.deps.contextProxy.setValue("currentApiConfigName", name),
			this.deps.contextProxy.setProviderSettings(providerSettings),
		])

		const { mode } = await this.deps.getState()

		if (id && persistModeConfig) {
			await this.deps.providerSettingsManager.setModeConfig(mode, id)
		}

		// Change the provider for the current task.
		this.deps.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

		// Update the current task's sticky provider profile, unless this activation is
		// being used purely as a non-persisting restoration (e.g., reopening a task from history).
		if (persistTaskHistory) {
			await this.persistStickyProviderProfileToCurrentTask(name)
		}

		await this.deps.postStateToWebview()

		if (providerSettings.apiProvider) {
			this.deps.emit(AgentEventName.ProviderProfileChanged, { name, provider: providerSettings.apiProvider })
		}
	}

	async getProviderProfiles(): Promise<{ name: string; provider?: string }[]> {
		const { listApiConfigMeta = [] } = await this.deps.getState()
		return listApiConfigMeta.map((profile) => ({ name: profile.name, provider: profile.apiProvider }))
	}

	async getProviderProfile(): Promise<string> {
		const { currentApiConfigName = "default" } = await this.deps.getState()
		return currentApiConfigName
	}

	async setProviderProfile(name: string): Promise<void> {
		await this.activateProviderProfile({ name })
	}
}
