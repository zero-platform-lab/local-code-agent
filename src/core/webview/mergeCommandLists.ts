import * as vscode from "vscode"

import { Package } from "../../shared/package"

/**
 * グローバル状態とワークスペース設定からコマンドリストをマージする共通ユーティリティ。
 * Command Denylist 機能のマージ戦略（検証・重複排除）を実装する。
 * ClineProvider の状態には一切依存しない純粋関数。
 *
 * @param configKey - VSCode workspace configuration key
 * @param commandType - エラーログ用のコマンド種別
 * @param globalStateCommands - グローバル状態のコマンド
 * @returns マージ・重複排除済みのコマンドリスト
 */
export function mergeCommandLists(
	configKey: "allowedCommands" | "deniedCommands",
	commandType: "allowed" | "denied",
	globalStateCommands?: string[],
): string[] {
	try {
		// Validate and sanitize global state commands
		const validGlobalCommands = Array.isArray(globalStateCommands)
			? globalStateCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
			: []

		// Get workspace configuration commands
		const workspaceCommands = vscode.workspace.getConfiguration(Package.name).get<string[]>(configKey) || []

		// Validate and sanitize workspace commands
		const validWorkspaceCommands = Array.isArray(workspaceCommands)
			? workspaceCommands.filter((cmd) => typeof cmd === "string" && cmd.trim().length > 0)
			: []

		// Combine and deduplicate commands
		// Global state takes precedence over workspace configuration
		const mergedCommands = [...new Set([...validGlobalCommands, ...validWorkspaceCommands])]

		return mergedCommands
	} catch (error) {
		console.error(`Error merging ${commandType} commands:`, error)
		// Return empty array as fallback to prevent crashes
		return []
	}
}

/**
 * Merges allowed commands from global state and workspace configuration
 * with proper validation and deduplication.
 */
export function mergeAllowedCommands(globalStateCommands?: string[]): string[] {
	return mergeCommandLists("allowedCommands", "allowed", globalStateCommands)
}

/**
 * Merges denied commands from global state and workspace configuration
 * with proper validation and deduplication.
 */
export function mergeDeniedCommands(globalStateCommands?: string[]): string[] {
	return mergeCommandLists("deniedCommands", "denied", globalStateCommands)
}
