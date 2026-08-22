import type { AutonomyMode } from "@openai-agent/types"

/**
 * Settings passed to system prompt generation functions
 */
export interface SystemPromptSettings {
	todoListEnabled: boolean
	useAgentRules: boolean
	/** When true, recursively discover and load .agent/rules from subdirectories */
	enableSubfolderRules?: boolean
	newTaskRequireTodos: boolean
	/** When true, model should hide vendor/company identity in responses */
	isStealthModel?: boolean
	/** 現在の自律モード。モデルに承認ゲート / 遮断の状況を伝えるために使う */
	autonomyMode?: AutonomyMode
}
