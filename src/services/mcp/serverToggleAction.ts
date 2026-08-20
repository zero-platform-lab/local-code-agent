import type { McpServer } from "@openai-agent/types"

/**
 * 有効/無効の切り替えで、接続に対して取るべき操作。
 *
 * - `reconnect-as-disabled`: 稼働中のサーバを止め、無効な placeholder として置き直す
 * - `reconnect-as-enabled`: 止まっているサーバを繋ぎ直す
 * - `refresh-capabilities`: 接続は保ったままツール/リソース一覧を取り直す
 * - `none`: 何もしない（既に止まっているサーバを無効化した場合）
 */
export type ServerToggleAction = "reconnect-as-disabled" | "reconnect-as-enabled" | "refresh-capabilities" | "none"

/**
 * `toggleServerDisabled` の分岐判定。
 *
 * 「今の接続状態」と「これから無効にするのか有効にするのか」だけで決まる純粋な判定で、
 * ファイル書き込みや再接続の実行とは独立している。3 分岐が入れ子の if/else で
 * 埋もれていたのを表に出したもの。
 *
 * @param disabled 切り替え後に無効であってほしいか
 * @param status 現在の接続状態
 */
export function resolveServerToggleAction(disabled: boolean, status: McpServer["status"]): ServerToggleAction {
	if (disabled) {
		// 稼働中のものだけ止める必要がある。既に落ちていれば触らない。
		return status === "connected" ? "reconnect-as-disabled" : "none"
	}

	if (status === "disconnected") {
		return "reconnect-as-enabled"
	}

	// 有効なまま接続も生きている場合は、設定変更をツール一覧に反映するだけでよい。
	return status === "connected" ? "refresh-capabilities" : "none"
}
