import * as vscode from "vscode"
import { WebviewMessage } from "../../shared/WebviewMessage"
import { defaultModeSlug } from "../../shared/modes"
import { buildApiHandler } from "../../api"

import { SYSTEM_PROMPT } from "../prompts/system"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { Package } from "../../shared/package"

import type { CustomModePrompts, ProviderSettings } from "@openai-agent/types"
import type { CustomModesManager } from "../config/CustomModesManager"
import type { McpHub } from "../../services/mcp/McpHub"
import type { SkillsManager } from "../../services/skills/SkillsManager"

// Narrow surface consumed by generateSystemPrompt. Defined locally to avoid
// importing ClineProvider and re-forming the webview cycle.
interface GenerateSystemPromptHost {
	readonly context: vscode.ExtensionContext
	readonly cwd: string
	readonly customModesManager: CustomModesManager
	getState(): Promise<{
		apiConfiguration: ProviderSettings
		customModePrompts?: CustomModePrompts
		customInstructions?: string
		mcpEnabled?: boolean
		experiments?: Record<string, boolean>
		language?: string
		enableSubfolderRules?: boolean
	}>
	getMcpHub(): McpHub | undefined
	getSkillsManager(): SkillsManager | undefined
	getCurrentTask(): { rooIgnoreController?: { getInstructions(): string | undefined } } | undefined
}

export const generateSystemPrompt = async (provider: GenerateSystemPromptHost, message: WebviewMessage) => {
	const {
		apiConfiguration,
		customModePrompts,
		customInstructions,
		mcpEnabled,
		experiments,
		language,
		enableSubfolderRules,
	} = await provider.getState()

	const diffStrategy = new MultiSearchReplaceDiffStrategy()

	const cwd = provider.cwd

	const mode = message.mode ?? defaultModeSlug
	const customModes = await provider.customModesManager.getCustomModes()

	const rooIgnoreInstructions = provider.getCurrentTask()?.rooIgnoreController?.getInstructions()

	// Create a temporary API handler to check model info for stealth mode.
	// This avoids relying on an active Cline instance which might not exist during preview.
	let modelInfo: { isStealthModel?: boolean } | undefined
	try {
		const tempApiHandler = buildApiHandler(apiConfiguration)
		modelInfo = tempApiHandler.getModel().info
	} catch (error) {
		console.error("Error fetching model info for system prompt preview:", error)
	}

	const systemPrompt = await SYSTEM_PROMPT(
		provider.context,
		cwd,
		false, // supportsComputerUse — browser removed
		mcpEnabled ? provider.getMcpHub() : undefined,
		diffStrategy,
		mode,
		customModePrompts,
		customModes,
		customInstructions,
		experiments,
		language,
		rooIgnoreInstructions,
		{
			todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
			useAgentRules: vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
			enableSubfolderRules: enableSubfolderRules ?? false,
			newTaskRequireTodos: vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false),
			isStealthModel: modelInfo?.isStealthModel,
		},
		undefined, // todoList
		undefined, // modelId
		provider.getSkillsManager(),
	)

	return systemPrompt
}
