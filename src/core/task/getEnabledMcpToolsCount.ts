import type * as vscode from "vscode"

import { countEnabledMcpTools } from "@openai-agent/types"

import { McpServerManager } from "../../services/mcp/McpServerManager"

/**
 * MCP hub 経由で「現在有効な MCP サーバー数と、その配下のツール数」を数える。
 *
 * mcpEnabled が false の状態、または provider が既に破棄されている場合は
 * 0 を返す。McpServerManager の初期化失敗も同様。
 */
export interface McpToolsCountProvider {
	context: vscode.ExtensionContext
	getState(): Promise<{ mcpEnabled?: boolean } | undefined>
}

export async function getEnabledMcpToolsCount(
	providerRef: WeakRef<McpToolsCountProvider>,
): Promise<{ enabledToolCount: number; enabledServerCount: number }> {
	try {
		const provider = providerRef.deref()
		if (!provider) {
			return { enabledToolCount: 0, enabledServerCount: 0 }
		}

		const { mcpEnabled } = (await provider.getState()) ?? {}
		if (!(mcpEnabled ?? true)) {
			return { enabledToolCount: 0, enabledServerCount: 0 }
		}

		const mcpHub = await McpServerManager.getInstance(provider.context, provider as never)
		if (!mcpHub) {
			return { enabledToolCount: 0, enabledServerCount: 0 }
		}

		const servers = mcpHub.getServers()
		return countEnabledMcpTools(servers)
	} catch (error) {
		console.error("[Task#getEnabledMcpToolsCount] Error counting MCP tools:", error)
		return { enabledToolCount: 0, enabledServerCount: 0 }
	}
}
