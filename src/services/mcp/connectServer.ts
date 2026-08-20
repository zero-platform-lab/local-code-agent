import type { Client } from "@modelcontextprotocol/sdk/client/index.js"

import {
	DisableReason,
	type ConnectedMcpConnection,
	type DisconnectedMcpConnection,
	type McpConnection,
	type McpTransport,
} from "./mcpConnection"
import { appendServerError } from "./mcpConnectionRegistry"
import type { McpTransportHandlers } from "./mcpTransportFactory"
import type { ServerConfig } from "./serverConfigSchema"

/**
 * 接続を試みる前に決まる 3 分岐。
 *
 * - `mcp-disabled`: MCP 機能自体が無効。接続はしないが、サーバの存在は追跡する
 * - `server-disabled`: このサーバだけ無効
 * - `connect`: 実際に接続する
 */
export type ConnectPlan = "mcp-disabled" | "server-disabled" | "connect"

/**
 * 接続手続きに入る前のゲート判定。
 *
 * MCP 全体の無効化がサーバ個別の設定より優先される（全体が無効なら、サーバが
 * 有効でも接続しない）。I/O を伴わない純粋な判定。
 */
export function resolveConnectPlan(mcpEnabled: boolean, serverDisabled: boolean | undefined): ConnectPlan {
	if (!mcpEnabled) {
		return "mcp-disabled"
	}

	return serverDisabled ? "server-disabled" : "connect"
}

/**
 * 接続を張らずにサーバの存在だけ記録する placeholder を作る。
 *
 * `disabled` の見え方は理由で変わる: サーバ個別の無効化なら true 固定、MCP 全体の
 * 無効化なら設定値をそのまま残す（全体を再度有効にしたとき元の状態に戻すため）。
 */
export function createPlaceholderConnection(input: {
	name: string
	config: ServerConfig
	source: "global" | "project"
	reason: DisableReason
	projectPath: string | undefined
}): DisconnectedMcpConnection {
	const { name, config, source, reason, projectPath } = input

	return {
		type: "disconnected",
		declaredConfig: config,
		server: {
			name,
			config: JSON.stringify(config),
			status: "disconnected",
			disabled: reason === DisableReason.SERVER_DISABLED ? true : config.disabled,
			source,
			projectPath,
			errorHistory: [],
		},
		client: null,
		transport: null,
	}
}

/**
 * 接続済みレコードを組み立てる（status は `connecting`。`client.connect()` 成功後に
 * 呼び出し側が `connected` へ進める）。
 *
 * `server.config` には**変数展開前の宣言**を載せる。このレコードは webview へ丸ごと
 * 送られるため、展開後を載せると `${env:API_KEY}` のようなシークレットが実値で
 * webview ペイロードに乗ってしまう。展開後の設定が必要なのは transport の生成だけで、
 * 読み手（timeout 表示・再接続）はいずれも宣言で足りる。
 *
 * 再接続は宣言を再検証して `connectToServer` に渡すので、そこで**改めて展開される**
 * （＝明示的な再起動は現在の env を拾う）。
 */
export function createConnectedConnection(input: {
	name: string
	declaredConfig: ServerConfig
	source: "global" | "project"
	projectPath: string | undefined
	client: Client
	transport: McpTransport
}): ConnectedMcpConnection {
	const { name, declaredConfig, source, projectPath, client, transport } = input

	return {
		type: "connected",
		declaredConfig,
		server: {
			name,
			config: JSON.stringify(declaredConfig),
			status: "connecting",
			disabled: declaredConfig.disabled,
			source,
			projectPath,
			errorHistory: [],
		},
		client,
		transport,
	}
}

/** transport ハンドラが接続を引き当てるのに必要な最小表面（McpConnectionStore が満たす）。 */
export interface ConnectionLookup {
	find(serverName: string, source?: "global" | "project"): McpConnection | undefined
}

export interface ConnectionTransportHandlerDeps {
	connections: ConnectionLookup
	/** 接続状態が変わったことを webview に伝える。 */
	notify(): Promise<void>
	serverName: string
	source: "global" | "project"
}

/**
 * transport のイベントを接続状態の更新へ落とし込むハンドラを作る。
 *
 * **接続オブジェクトを閉じ込めず、発火時に名前で引き直す**のが要点。transport は
 * 再接続をまたいで生き残ることがあり、閉じ込めると既に捨てられたレコードを
 * 更新してしまう（webview には反映されない幽霊更新になる）。
 */
export function makeConnectionTransportHandlers(deps: ConnectionTransportHandlerDeps): McpTransportHandlers {
	const { connections, notify, serverName, source } = deps

	return {
		onDisconnected: async (message) => {
			const connection = connections.find(serverName, source)

			if (connection) {
				connection.server.status = "disconnected"

				if (message !== undefined) {
					appendServerError(connection.server, message)
				}
			}

			await notify()
		},

		onStderr: async (output, isInfo) => {
			if (isInfo) {
				// Log normal informational messages
				console.log(`Server "${serverName}" info:`, output)
				return
			}

			// Treat as error log
			console.error(`Server "${serverName}" stderr:`, output)
			const connection = connections.find(serverName, source)

			if (connection) {
				appendServerError(connection.server, output)

				// 既に切断済みのときだけ通知する（接続中は接続完了時にまとめて通知される）
				if (connection.server.status === "disconnected") {
					await notify()
				}
			}
		},
	}
}

/**
 * 接続手続きが失敗したときのエラー記録。
 *
 * **store にレコードが入っているかどうかで挙動が変わる**のが仕様の要:
 * transport 生成より前に落ちた場合は記録先が存在しないので何も残さない
 * （呼び出し側が「接続に失敗した」旨をログする）。レコード追加後に落ちた場合だけ
 * 切断状態とエラー履歴を残し、webview に見せる。
 */
export function recordConnectionFailure(
	connections: ConnectionLookup,
	serverName: string,
	source: "global" | "project",
	error: unknown,
): void {
	const connection = connections.find(serverName, source)

	if (!connection) {
		return
	}

	connection.server.status = "disconnected"
	appendServerError(connection.server, error instanceof Error ? error.message : `${error}`)
}
