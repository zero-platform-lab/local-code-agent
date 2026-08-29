import type OpenAI from "openai"

import type { ProviderSettings, ModelInfo } from "@openai-agent/types"

import type * as vscode from "vscode"

import type { McpHub } from "../../services/mcp/McpHub"

import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import { filterNativeToolsForMode, filterMcpToolsForMode } from "../prompts/tools/filter-tools-for-mode"

// Narrow surface of ClineProvider consumed here — only context and getMcpHub.
// Declared locally so this module does not import ClineProvider back and form
// a cycle via Task → build-tools → ClineProvider → Task.
export interface BuildToolsProvider {
	readonly context: vscode.ExtensionContext
	getMcpHub(): McpHub | undefined
}

interface BuildToolsOptions {
	provider: BuildToolsProvider
	cwd: string
	mode: string | undefined
	experiments: Record<string, boolean> | undefined
	apiConfiguration: ProviderSettings | undefined
	disabledTools?: string[]
	modelInfo?: ModelInfo
}

interface BuildToolsResult {
	/** モードでフィルタ済みの、モデルに渡すツール。 */
	tools: OpenAI.Chat.ChatCompletionTool[]
}

/**
 * モードでフィルタしたネイティブツール + MCP ツールを組み立てる。
 */
export async function buildNativeToolsArrayWithRestrictions(options: BuildToolsOptions): Promise<BuildToolsResult> {
	const { provider, cwd, mode, experiments, apiConfiguration, disabledTools, modelInfo } = options

	const mcpHub = provider.getMcpHub()

	// Get CodeIndexManager for feature checking.
	const { CodeIndexManager } = await import("../../services/code-index/manager")
	const codeIndexManager = CodeIndexManager.getInstance(provider.context, cwd)

	// Build settings object for tool filtering.
	const filterSettings = {
		todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
		// web_fetch は既定オフ（opt-in）。未設定は false 扱い。
		webFetchEnabled: apiConfiguration?.webFetchEnabled ?? false,
		disabledTools,
		modelInfo,
	}

	// Check if the model supports images for read_file tool description.
	const supportsImages = modelInfo?.supportsImages ?? false

	// Build native tools with dynamic read_file tool based on settings.
	const nativeTools = getNativeTools({
		supportsImages,
	})

	// Filter native tools based on mode restrictions.
	const filteredNativeTools = filterNativeToolsForMode(
		nativeTools,
		mode,
		experiments,
		codeIndexManager,
		filterSettings,
		mcpHub,
	)

	// Filter MCP tools based on mode restrictions.
	const mcpTools = getMcpServerTools(mcpHub)
	const filteredMcpTools = filterMcpToolsForMode(mcpTools, mode, experiments)

	return {
		tools: [...filteredNativeTools, ...filteredMcpTools],
	}
}
