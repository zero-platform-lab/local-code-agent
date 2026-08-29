import type { ToolName, ExperimentId, AutonomyMode } from "@openai-agent/types"
import { toolNames as validToolNames, isReadOnlyAutonomyMode } from "@openai-agent/types"

import { type Mode, getModeBySlug } from "../../shared/modes"
import { EXPERIMENT_IDS } from "../../shared/experiments"
import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS, TOOL_ALIASES } from "../../shared/tools"

/**
 * Checks if a tool name is a valid, known tool.
 * Note: This does NOT check if the tool is allowed for a specific mode,
 * only that the tool actually exists.
 */
export function isValidToolName(toolName: string, _experiments?: Record<string, boolean>): toolName is ToolName {
	// Check if it's a valid static tool
	if ((validToolNames as readonly string[]).includes(toolName)) {
		return true
	}

	// Check if it's a dynamic MCP tool (mcp_serverName_toolName format).
	if (toolName.startsWith("mcp_")) {
		return true
	}

	return false
}

// Tool groups that mutate state (file edits / terminal commands). Blocked in read-only
// autonomy modes (Plan) regardless of the role mode. `mcp` stays allowed (reads);
// subtasks are separately gated (alwaysAllowSubtasks) and inherit the read-only mode.
const READ_ONLY_BLOCKED_GROUPS = ["edit", "command"] as const

/**
 * Whether a tool is permitted while a read-only autonomy mode (Plan) is active.
 * Reads, MCP, and always-available tools (ask/complete/todo) are allowed; anything in
 * an editing / command / browser group is not.
 */
export function isToolAllowedInReadOnlyMode(tool: string): boolean {
	const resolvedTool = TOOL_ALIASES[tool] ?? tool

	if (ALWAYS_AVAILABLE_TOOLS.includes(resolvedTool as (typeof ALWAYS_AVAILABLE_TOOLS)[number])) {
		return true
	}

	return !READ_ONLY_BLOCKED_GROUPS.some((group) => TOOL_GROUPS[group].tools.includes(resolvedTool))
}

export function validateToolUse(
	toolName: ToolName,
	mode: Mode,
	toolRequirements?: Record<string, boolean>,
	experiments?: Record<string, boolean>,
	includedTools?: string[],
	autonomyMode?: AutonomyMode,
): void {
	// First, check if the tool name is actually a valid/known tool
	// This catches completely invalid tool names like "edit_file" that don't exist
	if (!isValidToolName(toolName, experiments)) {
		throw new Error(
			`Unknown tool "${toolName}". This tool does not exist. Please use one of the available tools: ${validToolNames.join(", ")}.`,
		)
	}

	// Read-only autonomy (Plan) gate: block mutating tools regardless of the role mode.
	// User-controlled only — the model can never change its own autonomy mode.
	if (isReadOnlyAutonomyMode(autonomyMode) && !isToolAllowedInReadOnlyMode(toolName)) {
		throw new Error(
			`Tool "${toolName}" is not allowed in Plan (read-only) mode. Switch out of Plan mode to make changes.`,
		)
	}

	// Then check if the tool is allowed for the current mode
	if (!isToolAllowedForMode(toolName, mode, toolRequirements, experiments, includedTools)) {
		throw new Error(`Tool "${toolName}" is not allowed in ${mode} mode.`)
	}
}

export function isToolAllowedForMode(
	tool: string,
	modeSlug: string,
	toolRequirements?: Record<string, boolean>,
	experiments?: Record<string, boolean>,
	includedTools?: string[], // Opt-in tools explicitly included (e.g., from modelInfo)
): boolean {
	// Resolve alias to canonical name (e.g., "search_and_replace" → "edit")
	const resolvedTool = TOOL_ALIASES[tool] ?? tool
	const resolvedIncludedTools = includedTools?.map((t) => TOOL_ALIASES[t] ?? t)

	// Check tool requirements first — explicit disabling takes priority over everything,
	// including ALWAYS_AVAILABLE_TOOLS. This ensures disabledTools works consistently
	// at both the filtering layer and the execution-time validation layer.
	if (toolRequirements && typeof toolRequirements === "object") {
		if (
			(tool in toolRequirements && !toolRequirements[tool]) ||
			(resolvedTool in toolRequirements && !toolRequirements[resolvedTool])
		) {
			return false
		}
	} else if (toolRequirements === false) {
		// If toolRequirements is a boolean false, all tools are disabled
		return false
	}

	// Always allow these tools (unless explicitly disabled above)
	if (ALWAYS_AVAILABLE_TOOLS.includes(tool as any)) {
		return true
	}

	// Check if this is a dynamic MCP tool (mcp_serverName_toolName)
	// These should be allowed if the mcp group is allowed for the mode
	const isDynamicMcpTool = tool.startsWith("mcp_")

	if (experiments && Object.values(EXPERIMENT_IDS).includes(tool as ExperimentId)) {
		if (!experiments[tool]) {
			return false
		}
	}

	const mode = getModeBySlug(modeSlug)

	if (!mode) {
		return false
	}

	// Check if tool is in any of the mode's groups
	for (const groupName of mode.groups) {
		const groupConfig = TOOL_GROUPS[groupName]

		// Check if this is a dynamic MCP tool and the mcp group is allowed
		if (isDynamicMcpTool && groupName === "mcp") {
			// Dynamic MCP tools are allowed if the mcp group is in the mode's groups
			return true
		}

		// Check if the tool is in the group's regular tools
		const isRegularTool = groupConfig.tools.includes(resolvedTool)

		// Check if the tool is a custom tool that has been explicitly included
		const isCustomTool =
			groupConfig.customTools?.includes(resolvedTool) && resolvedIncludedTools?.includes(resolvedTool)

		// If the tool isn't in regular tools and isn't an included custom tool, continue to next group
		if (!isRegularTool && !isCustomTool) {
			continue
		}

		return true
	}

	return false
}
