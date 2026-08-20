import type { McpServer } from "@openai-agent/types"

import { toolNamesMatch } from "../../utils/mcp-name"

import type { McpConnection } from "./mcpConnection"

/** 直近何件のエラーを server ごとに保持するか。 */
const MAX_ERROR_HISTORY = 100

/** webview に載せるエラー文字列の上限。長いスタックで state が肥大するのを防ぐ。 */
const MAX_ERROR_LENGTH = 1000

/** 明示 source が無い接続は global 扱い（古い設定との互換）。 */
const isGlobal = (connection: McpConnection): boolean =>
	connection.server.source === "global" || !connection.server.source

/**
 * 名前（+ 任意の source）で接続を引き当てる。
 *
 * source 未指定のときは **project が global より優先**される。同名サーバを
 * `.agent/mcp.json` で上書きするユースケースがあるため。
 */
export function findConnection(
	connections: readonly McpConnection[],
	serverName: string,
	source?: "global" | "project",
): McpConnection | undefined {
	// If source is specified, only find servers with that source
	if (source !== undefined) {
		return connections.find((conn) => conn.server.name === serverName && conn.server.source === source)
	}

	// If no source is specified, first look for project servers, then global servers
	// This ensures that when servers have the same name, project servers are prioritized
	const projectConn = connections.find((conn) => conn.server.name === serverName && conn.server.source === "project")
	if (projectConn) return projectConn

	// If no project server is found, look for global servers
	return connections.find((conn) => conn.server.name === serverName && isGlobal(conn))
}

/**
 * 利用可能なサーバ一覧（無効化されていないもの）を、名前で重複排除して返す。
 * 同名なら project が global を上書きする。
 */
export function selectEnabledServers(connections: readonly McpConnection[]): McpServer[] {
	const enabledConnections = connections.filter((conn) => !conn.server.disabled)

	// Deduplicate by server name: project servers take priority over global servers
	const serversByName = new Map<string, McpServer>()
	for (const conn of enabledConnections) {
		const existing = serversByName.get(conn.server.name)
		if (!existing) {
			serversByName.set(conn.server.name, conn.server)
		} else if (conn.server.source === "project" && existing.source !== "project") {
			// Project server overrides global server with the same name
			serversByName.set(conn.server.name, conn.server)
		}
		// If existing is project and current is global, keep existing (project wins)
	}

	return Array.from(serversByName.values())
}

/**
 * 設定ファイルでの記述順に接続を並べる（project が先、global が後）。
 *
 * webview 側の表示順が設定ファイルの並びと一致するようにするためのもの。
 * 設定ファイルに載っていないサーバは `indexOf` が -1 になるため先頭に寄る（既存挙動）。
 */
export function sortConnectionsByConfigOrder(
	connections: readonly McpConnection[],
	order: { global: readonly string[]; project: readonly string[] },
): McpConnection[] {
	return [...connections].sort((a, b) => {
		const aIsGlobal = isGlobal(a)
		const bIsGlobal = isGlobal(b)

		// If both are global or both are project, sort by their respective order
		if (aIsGlobal && bIsGlobal) {
			return order.global.indexOf(a.server.name) - order.global.indexOf(b.server.name)
		} else if (!aIsGlobal && !bIsGlobal) {
			return order.project.indexOf(a.server.name) - order.project.indexOf(b.server.name)
		}

		// Project servers come before global servers
		return aIsGlobal ? 1 : -1
	})
}

/**
 * API 応答に載ってくる「サニタイズ済みサーバ名」から元の名前を解決する。
 *
 * モデルがハイフンをアンダースコアに書き換えてくることがあるため、
 * 完全一致 → 登録済みサニタイズ名 → ハイフン/アンダースコア同一視のファジー一致、の順に見る。
 *
 * @returns 元のサーバ名。解決できなければ null。
 */
export function resolveServerNameFromSanitized(
	connections: readonly McpConnection[],
	sanitizedNameRegistry: ReadonlyMap<string, string>,
	sanitizedServerName: string,
): string | null {
	// First, check for an exact match
	const exactMatch = connections.find((conn) => conn.server.name === sanitizedServerName)
	if (exactMatch) {
		return exactMatch.server.name
	}

	// Check the registry for sanitized name mapping
	const registryMatch = sanitizedNameRegistry.get(sanitizedServerName)
	if (registryMatch) {
		return registryMatch
	}

	// Use fuzzy matching: treat hyphens and underscores as equivalent
	const fuzzyMatch = connections.find((conn) => toolNamesMatch(conn.server.name, sanitizedServerName))
	if (fuzzyMatch) {
		return fuzzyMatch.server.name
	}

	return null
}

/**
 * サーバのエラー履歴に 1 件積む（in-place）。長すぎるメッセージは切り詰め、
 * 履歴は直近 {@link MAX_ERROR_HISTORY} 件に丸める。`server.error` は最新値で上書きする。
 */
export function appendServerError(server: McpServer, error: string, level: "error" | "warn" | "info" = "error"): void {
	const truncatedError =
		error.length > MAX_ERROR_LENGTH ? `${error.substring(0, MAX_ERROR_LENGTH)}...(error message truncated)` : error

	// Add to error history
	if (!server.errorHistory) {
		server.errorHistory = []
	}

	server.errorHistory.push({
		message: truncatedError,
		timestamp: Date.now(),
		level,
	})

	// Keep only the last N errors
	if (server.errorHistory.length > MAX_ERROR_HISTORY) {
		server.errorHistory = server.errorHistory.slice(-MAX_ERROR_HISTORY)
	}

	// Update current error display
	server.error = truncatedError
}
