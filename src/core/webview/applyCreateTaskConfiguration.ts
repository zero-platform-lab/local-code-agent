import * as vscode from "vscode"

import type { AgentSettings, ModeConfig } from "@openai-agent/types"

import { Package } from "../../shared/package"

/** 設定適用が必要とする host の最小表面。 */
export interface CreateTaskConfigurationHost {
	setValues(values: AgentSettings): Promise<void>
	setProviderProfile(name: string): Promise<void>
	readonly customModesManager: {
		updateCustomMode(slug: string, mode: ModeConfig): Promise<void>
	}
}

/**
 * 拡張の global state ではなく VS Code 設定側にも書き戻す必要があるキー。
 * 端末実行の許可/拒否コマンドとタイムアウトは settings.json から読まれるため。
 */
const VSCODE_SETTING_KEYS = ["allowedCommands", "deniedCommands", "commandExecutionTimeout"] as const

/**
 * `createTask` に渡された `AgentSettings` を、タスク生成前に各所へ反映する。
 *
 * ClineProvider.createTask の前半（40 行）を切り出したもの。書き込み先が
 * global state / VS Code 設定 / provider profile / CustomModesManager の 4 系統に
 * またがっており、タスク生成そのものとは独立した責務。
 */
export async function applyCreateTaskConfiguration(
	host: CreateTaskConfigurationHost,
	configuration: AgentSettings,
): Promise<void> {
	await host.setValues(configuration)

	for (const key of VSCODE_SETTING_KEYS) {
		const value = configuration[key]

		// 未指定のキーはユーザー設定を触らない（null 明示も同様に無視する）。
		if (value == null) {
			continue
		}

		await vscode.workspace.getConfiguration(Package.name).update(key, value, vscode.ConfigurationTarget.Global)
	}

	if (configuration.currentApiConfigName) {
		await host.setProviderProfile(configuration.currentApiConfigName)
	}

	// Register custom modes so the CustomModesManager knows about them.
	// setValues writes to global state, but the manager overwrites that
	// when it merges .agentmodes + global settings on refresh.  Persisting
	// via updateCustomMode ensures modes survive the merge cycle.
	for (const mode of configuration.customModes ?? []) {
		await host.customModesManager.updateCustomMode(mode.slug, mode)
	}
}
