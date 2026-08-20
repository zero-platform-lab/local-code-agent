import {
	CallToolResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"

import type {
	McpResource,
	McpResourceResponse,
	McpResourceTemplate,
	McpTool,
	McpToolCallResponse,
} from "@openai-agent/types"

import type { ConnectedMcpConnection, McpConnection } from "./mcpConnection"
import { readServerEntries, type McpSettingsPathResolver } from "./mcpSettingsFile"
import { applyToolConfigFlags } from "./mcpToolConfig"
import { ServerConfigSchema } from "./serverConfigSchema"

/**
 * 接続済み MCP サーバのクライアント I/O（プロトコル要求）だけを集めたモジュール。
 *
 * 接続の解決・not-found/disabled のガードは呼び出し側（McpHub）が持つ。ここは
 * 「connected な接続を受け取って protocol 要求を投げる」責務に閉じているので、
 * fake の client 1 つで単体テストできる。
 */

/**
 * サーバのツール一覧を取得し、設定ファイルの alwaysAllow/disabledTools を反映する。
 * 接続が無い / connected でない場合は空配列（従来の best-effort 挙動）。
 */
export async function fetchServerTools(
	connection: McpConnection | undefined,
	settingsPaths: McpSettingsPathResolver,
): Promise<McpTool[]> {
	if (!connection || connection.type !== "connected") {
		return []
	}

	try {
		const response = await connection.client.request({ method: "tools/list" }, ListToolsResultSchema)

		// ツールのフラグはサーバ応答ではなく設定ファイルに書かれている。
		const actualSource = connection.server.source || "global"
		let serverEntry: Record<string, any> | undefined
		try {
			serverEntry = (await readServerEntries(settingsPaths, actualSource))?.[connection.server.name]
		} catch (error) {
			console.error(`Failed to read tool configuration for ${connection.server.name}:`, error)
		}

		return applyToolConfigFlags(response?.tools || [], {
			alwaysAllow: serverEntry?.alwaysAllow || [],
			disabledTools: serverEntry?.disabledTools || [],
		})
	} catch (error) {
		console.error(`Failed to fetch tools for ${connection.server.name}:`, error)
		return []
	}
}

/** サーバのリソース一覧。接続が無い / connected でない / 失敗時は空配列。 */
export async function fetchServerResources(connection: McpConnection | undefined): Promise<McpResource[]> {
	if (!connection || connection.type !== "connected") {
		return []
	}
	try {
		const response = await connection.client.request({ method: "resources/list" }, ListResourcesResultSchema)
		return response?.resources || []
	} catch {
		return []
	}
}

/** サーバのリソーステンプレート一覧。接続が無い / connected でない / 失敗時は空配列。 */
export async function fetchServerResourceTemplates(
	connection: McpConnection | undefined,
): Promise<McpResourceTemplate[]> {
	if (!connection || connection.type !== "connected") {
		return []
	}
	try {
		const response = await connection.client.request(
			{ method: "resources/templates/list" },
			ListResourceTemplatesResultSchema,
		)
		return response?.resourceTemplates || []
	} catch {
		return []
	}
}

/**
 * ツールを呼び出す。timeout は接続が保持する（展開前の）server.config から算出し、
 * 解析に失敗したら 60 秒を既定にする。
 */
export async function requestToolCall(
	connection: ConnectedMcpConnection,
	toolName: string,
	toolArguments?: Record<string, unknown>,
): Promise<McpToolCallResponse> {
	let timeout: number
	try {
		const parsedConfig = ServerConfigSchema.parse(JSON.parse(connection.server.config))
		/* v8 ignore next -- 到達不能: ServerConfigSchema の timeout は .optional().default(60) なので parse 成功後は常に number。?? 60 の右側は踏めない防御既定（不変条件が壊れたとき安全側へ倒すため残す）。 */
		timeout = (parsedConfig.timeout ?? 60) * 1000
	} catch (error) {
		console.error("Failed to parse server config for timeout:", error)
		timeout = 60 * 1000
	}

	return await connection.client.request(
		{
			method: "tools/call",
			params: {
				name: toolName,
				arguments: toolArguments,
			},
		},
		CallToolResultSchema,
		{
			timeout,
		},
	)
}

/** リソースを読み出す。 */
export async function requestResourceRead(
	connection: ConnectedMcpConnection,
	uri: string,
): Promise<McpResourceResponse> {
	return await connection.client.request(
		{
			method: "resources/read",
			params: {
				uri,
			},
		},
		ReadResourceResultSchema,
	)
}
