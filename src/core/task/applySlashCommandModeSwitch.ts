import type { ModeConfig } from "@openai-agent/types"

import { type Mode, getModeBySlug } from "../../shared/modes"

/**
 * ユーザーメッセージの frontmatter に含まれるスラッシュコマンド指定モードが
 * 現在のプロバイダで存在するモードなら、モードを切り替える。
 *
 * `providerRef.deref()` で得られる provider の狭い interface（`SlashCommandModeHost`）
 * だけに依存する。
 */
export interface SlashCommandModeHost {
	getState(): Promise<{ customModes?: ModeConfig[] } | undefined>
	handleModeSwitch(mode: Mode): Promise<unknown>
}

export async function applySlashCommandModeSwitch(
	provider: SlashCommandModeHost | undefined,
	slashCommandMode: string | undefined,
): Promise<void> {
	if (!slashCommandMode || !provider) {
		return
	}

	const state = await provider.getState()
	const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
	if (!targetMode) {
		return
	}

	await provider.handleModeSwitch(slashCommandMode as Mode)
}
