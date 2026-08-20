import * as path from "path"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { type WebviewMessage } from "@openai-agent/types"

import { t } from "../../i18n"
import { openFile } from "../../integrations/misc/open-file"
import { fileExistsAtPath } from "../../utils/fs"
import { safeWriteJson } from "../../utils/safeWriteJson"

import type { WebviewMessageHost } from "./webviewMessageHost"

/**
 * MCP サーバー関連の webview メッセージハンドラ。
 *
 * webviewMessageHandler の巨大 switch から切り出したもの。接続の管理は McpHub が
 * 持ち、ここは webview からの操作をそこへ振り分ける層。
 *
 * McpHub は未初期化なら undefined を返すため、いずれの操作もオプショナルチェーンで
 * 呼んでいる（初期化前の webview 操作を握り潰す）。
 */
type McpMessageHandler = (provider: WebviewMessageHost, message: WebviewMessage) => Promise<void>

/** 失敗時のログ整形。catch した値のプロパティを全て拾う（Error 以外も来るため）。 */
const formatError = (error: unknown): string => JSON.stringify(error, Object.getOwnPropertyNames(error), 2)

/** 実行中タスクがあればその cwd、無ければ provider の cwd。 */
const resolveCurrentCwd = (provider: WebviewMessageHost): string => provider.getCurrentTask()?.cwd || provider.cwd

export const mcpMessageHandlers: Partial<Record<WebviewMessage["type"], McpMessageHandler>> = {
	openMcpSettings: async (provider) => {
		const mcpSettingsFilePath = await provider.getMcpHub()?.getMcpSettingsFilePath()

		if (mcpSettingsFilePath) {
			openFile(mcpSettingsFilePath)
		}
	},

	openProjectMcpSettings: async (provider) => {
		if (!vscode.workspace.workspaceFolders?.length) {
			vscode.window.showErrorMessage(t("common:errors.no_workspace"))
			return
		}

		const agentDir = path.join(resolveCurrentCwd(provider), ".agent")
		const mcpPath = path.join(agentDir, "mcp.json")

		try {
			await fs.mkdir(agentDir, { recursive: true })
			const exists = await fileExistsAtPath(mcpPath)

			if (!exists) {
				await safeWriteJson(mcpPath, { mcpServers: {} }, { prettyPrint: true })
			}

			await openFile(mcpPath)
		} catch (error) {
			vscode.window.showErrorMessage(t("mcp:errors.create_json", { error: `${error}` }))
		}
	},

	deleteMcpServer: async (provider, message) => {
		if (!message.serverName) {
			return
		}

		try {
			provider.log(`Attempting to delete MCP server: ${message.serverName}`)
			await provider.getMcpHub()?.deleteServer(message.serverName, message.source as "global" | "project")
			provider.log(`Successfully deleted MCP server: ${message.serverName}`)

			// Refresh the webview state
			await provider.postStateToWebview()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			provider.log(`Failed to delete MCP server: ${errorMessage}`)
			// Error messages are already handled by McpHub.deleteServer
		}
	},

	restartMcpServer: async (provider, message) => {
		try {
			await provider.getMcpHub()?.restartConnection(message.text!, message.source as "global" | "project")
		} catch (error) {
			provider.log(`Failed to retry connection for ${message.text}: ${formatError(error)}`)
		}
	},

	toggleMcpServer: async (provider, message) => {
		try {
			await provider
				.getMcpHub()
				?.toggleServerDisabled(message.serverName!, message.disabled!, message.source as "global" | "project")
		} catch (error) {
			provider.log(`Failed to toggle MCP server ${message.serverName}: ${formatError(error)}`)
		}
	},

	refreshAllMcpServers: async (provider) => {
		const mcpHub = provider.getMcpHub()

		if (mcpHub) {
			await mcpHub.refreshAllConnections()
		}
	},

	toggleToolAlwaysAllow: async (provider, message) => {
		try {
			await provider
				.getMcpHub()
				?.toggleToolAlwaysAllow(
					message.serverName!,
					message.source as "global" | "project",
					message.toolName!,
					Boolean(message.alwaysAllow),
				)
		} catch (error) {
			provider.log(`Failed to toggle auto-approve for tool ${message.toolName}: ${formatError(error)}`)
		}
	},

	toggleToolEnabledForPrompt: async (provider, message) => {
		try {
			await provider
				.getMcpHub()
				?.toggleToolEnabledForPrompt(
					message.serverName!,
					message.source as "global" | "project",
					message.toolName!,
					Boolean(message.isEnabled),
				)
		} catch (error) {
			provider.log(`Failed to toggle enabled for prompt for tool ${message.toolName}: ${formatError(error)}`)
		}
	},

	updateMcpTimeout: async (provider, message) => {
		if (!message.serverName || typeof message.timeout !== "number") {
			return
		}

		try {
			await provider
				.getMcpHub()
				?.updateServerTimeout(message.serverName, message.timeout, message.source as "global" | "project")
		} catch (error) {
			provider.log(`Failed to update timeout for ${message.serverName}: ${formatError(error)}`)
			vscode.window.showErrorMessage(t("common:errors.update_server_timeout"))
		}
	},
}
