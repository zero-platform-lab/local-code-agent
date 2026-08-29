import * as vscode from "vscode"

import {
	type ModeConfig,
	type CustomModePrompts,
	type ToolGroup,
	type PromptComponent,
	DEFAULT_MODES,
} from "@openai-agent/types"

import { addCustomInstructions } from "../core/prompts/sections/custom-instructions"

import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS } from "./tools"

export type Mode = string

// Helper to get all tools for a mode
export function getToolsForMode(groups: readonly ToolGroup[]): string[] {
	const tools = new Set<string>()

	// Add tools from each group (excluding customTools which are opt-in only)
	groups.forEach((groupName) => {
		const groupConfig = TOOL_GROUPS[groupName]
		groupConfig.tools.forEach((tool: string) => tools.add(tool))
	})

	// Always add required tools
	ALWAYS_AVAILABLE_TOOLS.forEach((tool) => tools.add(tool))

	return Array.from(tools)
}

// Main modes configuration as an ordered array
export const modes = DEFAULT_MODES

// Export the default mode slug.
//
// Code を既定にしている。コーディングエージェントとして最も使われる導線で、
// ファイル編集・コマンド実行を含む一通りのツールが最初から使える。
// （以前 Architect → Ask としたが、Ask では書き込みも実行もできず「試したいだけ」の
// 用途でも二度手間になるため Code に置き直した。）
//
// modes 配列の並びは UI の表示順なので、そちらは変えずにここだけ明示する。
// 参照先が消えた場合に黙って壊れないよう、配列から引いて存在を担保する。
/* v8 ignore next -- 到達不能: modes には常に "code" が存在するため ?? modes[0] の右辺は踏めない。参照消失時の安全既定として残す */
export const defaultModeSlug = (modes.find((mode) => mode.slug === "code") ?? modes[0]).slug

// Helper functions
export function getModeBySlug(slug: string): ModeConfig | undefined {
	return modes.find((mode) => mode.slug === slug)
}

export function getModeConfig(slug: string): ModeConfig {
	const mode = getModeBySlug(slug)
	if (!mode) {
		throw new Error(`No mode found for slug: ${slug}`)
	}
	return mode
}

// Get all available modes
export function getAllModes(): ModeConfig[] {
	return [...modes]
}

/**
 * Get the mode selection based on the provided mode slug and prompt component.
 * The built-in mode is used with partial merging from promptComponent.
 * If the slug is unknown, the default mode is used.
 */
export function getModeSelection(mode: string, promptComponent?: PromptComponent) {
	const baseMode = getModeBySlug(mode) || modes[0] // fallback to default mode

	return {
		/* v8 ignore next -- 到達不能: 組み込みモードは必ず roleDefinition を持つため最終 || "" は踏めない。安全既定として残す */
		roleDefinition: promptComponent?.roleDefinition || baseMode.roleDefinition || "",
		baseInstructions: promptComponent?.customInstructions || baseMode.customInstructions || "",
		/* v8 ignore next -- 到達不能: 組み込みモードは必ず description を持つため || "" は踏めない。安全既定として残す */
		description: baseMode.description || "",
	}
}

// Create the mode-specific default prompts
export const defaultPrompts: Readonly<CustomModePrompts> = Object.freeze(
	Object.fromEntries(
		modes.map((mode) => [
			mode.slug,
			{
				roleDefinition: mode.roleDefinition,
				whenToUse: mode.whenToUse,
				customInstructions: mode.customInstructions,
				description: mode.description,
			},
		]),
	),
)

// Helper function to get all modes with their prompt overrides from extension state
export async function getAllModesWithPrompts(context: vscode.ExtensionContext): Promise<ModeConfig[]> {
	const customModePrompts = (await context.globalState.get<CustomModePrompts>("customModePrompts")) || {}

	const allModes = getAllModes()
	return allModes.map((mode) => ({
		...mode,
		roleDefinition: customModePrompts[mode.slug]?.roleDefinition ?? mode.roleDefinition,
		whenToUse: customModePrompts[mode.slug]?.whenToUse ?? mode.whenToUse,
		customInstructions: customModePrompts[mode.slug]?.customInstructions ?? mode.customInstructions,
		// description is not overridable via customModePrompts, so we keep the original
	}))
}

// Helper function to get complete mode details with all overrides
export async function getFullModeDetails(
	modeSlug: string,
	customModePrompts?: CustomModePrompts,
	options?: {
		cwd?: string
		globalCustomInstructions?: string
		language?: string
	},
): Promise<ModeConfig> {
	// First get the base mode config from the built-in modes
	const baseMode = getModeBySlug(modeSlug) || modes[0]

	// Check for any prompt component overrides
	const promptComponent = customModePrompts?.[modeSlug]

	// Get the base custom instructions
	const baseCustomInstructions = promptComponent?.customInstructions || baseMode.customInstructions || ""
	const baseWhenToUse = promptComponent?.whenToUse || baseMode.whenToUse || ""
	const baseDescription = promptComponent?.description || baseMode.description || ""

	// If we have cwd, load and combine all custom instructions
	let fullCustomInstructions = baseCustomInstructions
	if (options?.cwd) {
		fullCustomInstructions = await addCustomInstructions(
			baseCustomInstructions,
			options.globalCustomInstructions || "",
			options.cwd,
			modeSlug,
			{ language: options.language },
		)
	}

	// Return mode with any overrides applied
	return {
		...baseMode,
		roleDefinition: promptComponent?.roleDefinition || baseMode.roleDefinition,
		whenToUse: baseWhenToUse,
		description: baseDescription,
		customInstructions: fullCustomInstructions,
	}
}

// Helper function to safely get role definition
export function getRoleDefinition(modeSlug: string): string {
	const mode = getModeBySlug(modeSlug)
	if (!mode) {
		console.warn(`No mode found for slug: ${modeSlug}`)
		return ""
	}
	return mode.roleDefinition
}

// Helper function to safely get description
export function getDescription(modeSlug: string): string {
	const mode = getModeBySlug(modeSlug)
	if (!mode) {
		console.warn(`No mode found for slug: ${modeSlug}`)
		return ""
	}
	return mode.description ?? ""
}

// Helper function to safely get whenToUse
export function getWhenToUse(modeSlug: string): string {
	const mode = getModeBySlug(modeSlug)
	if (!mode) {
		console.warn(`No mode found for slug: ${modeSlug}`)
		return ""
	}
	return mode.whenToUse ?? ""
}

// Helper function to safely get custom instructions
export function getCustomInstructions(modeSlug: string): string {
	const mode = getModeBySlug(modeSlug)
	if (!mode) {
		console.warn(`No mode found for slug: ${modeSlug}`)
		return ""
	}
	return mode.customInstructions ?? ""
}
