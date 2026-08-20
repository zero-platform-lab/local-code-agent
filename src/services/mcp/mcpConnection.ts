import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { McpServer } from "@openai-agent/types"

import type { ServerConfig } from "./serverConfigSchema"

export type McpTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

/**
 * 設定ファイルに書かれていた内容（検証済み・**変数展開前**）。
 *
 * 再接続要否の判定はこれを基準に行う。変数展開後の姿と比べると `${env:...}` を含む設定が
 * 毎回「変わった」と判定されてしまうため（#250）。
 *
 * webview へ送る `server.config` も同じ宣言を載せる（展開後だとシークレットが漏れる）。
 * 展開後の設定を必要とするのは transport の生成だけで、どこにも保持しない。
 *
 * 実行時に欠けている場合（型を迂回して組み立てられた接続など）は「変更あり」とみなす。
 */
type DeclaredConfig = {
	declaredConfig: ServerConfig
}

// Discriminated union for connection states
export type ConnectedMcpConnection = DeclaredConfig & {
	type: "connected"
	server: McpServer
	client: Client
	transport: McpTransport
}

export type DisconnectedMcpConnection = DeclaredConfig & {
	type: "disconnected"
	server: McpServer
	client: null
	transport: null
}

export type McpConnection = ConnectedMcpConnection | DisconnectedMcpConnection

/**
 * 接続を張らずに placeholder を作る理由。
 * webview 側は `server.disabled` の見え方をこの区別で変える。
 */
export enum DisableReason {
	MCP_DISABLED = "mcpDisabled",
	SERVER_DISABLED = "serverDisabled",
}
