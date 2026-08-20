import type { McpServer } from "@openai-agent/types"

import { sanitizeMcpName } from "../../utils/mcp-name"

import type { McpConnection } from "./mcpConnection"
import {
	findConnection,
	resolveServerNameFromSanitized,
	selectEnabledServers,
	sortConnectionsByConfigOrder,
} from "./mcpConnectionRegistry"

/**
 * MCP 接続の集合と、サニタイズ名 → 実名の対応表を所有する。
 *
 * McpHub が `connections` 配列と `sanitizedNameRegistry` を public/private フィールドで
 * 直接持ち、15 前後のメソッドが `push` / `filter` / 再代入で好き勝手に触っていたのを
 * 所有権ごと切り出したもの。呼び出し側は配列ではなく**意図の名前**（{@link add} /
 * {@link remove} / {@link withSource} …）で操作する。
 *
 * 問い合わせロジックそのものは `mcpConnectionRegistry.ts` の純関数に委譲していて、
 * 本クラスの責務は「状態を持つこと」と「2 つのコレクションの整合を保つこと」に限られる。
 */
export class McpConnectionStore {
	private connections: McpConnection[] = []
	private readonly sanitizedNames = new Map<string, string>()

	/**
	 * 現在の接続一覧（読み取り専用ビュー）。
	 *
	 * 反復中に {@link remove} などで配列が差し替わっても、`for...of` は反復開始時点の
	 * 配列を最後まで見る（`dispose` はこの性質に依存している）。
	 */
	get items(): readonly McpConnection[] {
		return this.connections
	}

	get size(): number {
		return this.connections.length
	}

	/** 反復しながら削除しても影響を受けないコピー。 */
	snapshot(): McpConnection[] {
		return [...this.connections]
	}

	/** 名前（+ 任意の source）で 1 件引き当てる。source 未指定なら project 優先。 */
	find(serverName: string, source?: "global" | "project"): McpConnection | undefined {
		return findConnection(this.connections, serverName, source)
	}

	/**
	 * 削除対象になる接続（名前一致、source 指定時はさらに source 厳密一致）。
	 * {@link remove} と同じ述語を使うので、「閉じてから消す」を安全に 2 段で行える。
	 */
	matching(serverName: string, source?: "global" | "project"): McpConnection[] {
		return this.connections.filter((conn) => this.isTarget(conn, serverName, source))
	}

	/** source が厳密一致する接続（source 未設定のものは含めない）。 */
	withSource(source: "global" | "project"): McpConnection[] {
		return this.connections.filter((conn) => conn.server.source === source)
	}

	/**
	 * その source が受け持っているサーバ名の集合。
	 *
	 * {@link withSource} と違い **source 未設定を global とみなす**（古い設定ファイル由来の
	 * 接続を global の差分計算から取りこぼさないための既存挙動）。
	 */
	namesOwnedBy(source: "global" | "project"): Set<string> {
		const owned = this.connections.filter(
			(conn) => conn.server.source === source || (!conn.server.source && source === "global"),
		)
		return new Set(owned.map((conn) => conn.server.name))
	}

	/** 無効化されていないサーバ一覧（同名は project 優先で重複排除）。 */
	enabledServers(): McpServer[] {
		return selectEnabledServers(this.connections)
	}

	/** 状態を問わず全サーバ。 */
	allServers(): McpServer[] {
		return this.connections.map((conn) => conn.server)
	}

	/** 設定ファイルの記述順（project が先）に並べたサーバ一覧。 */
	serversInConfigOrder(order: { global: readonly string[]; project: readonly string[] }): McpServer[] {
		return sortConnectionsByConfigOrder(this.connections, order).map((conn) => conn.server)
	}

	/** API 応答のサニタイズ済みサーバ名から実名を解決する。 */
	resolveName(sanitizedServerName: string): string | null {
		return resolveServerNameFromSanitized(this.connections, this.sanitizedNames, sanitizedServerName)
	}

	/**
	 * サニタイズ名 → 実名の対応を覚える。
	 *
	 * 接続の成否に関わらず、接続を試みた時点で登録する（transport の生成に失敗しても
	 * モデルが同じ名前で呼び直せるようにする既存挙動）。
	 */
	rememberName(serverName: string): void {
		this.sanitizedNames.set(sanitizeMcpName(serverName), serverName)
	}

	/** 接続を追加する。 */
	add(connection: McpConnection): void {
		this.connections.push(connection)
	}

	/**
	 * 名前（+ 任意の source）に一致する接続を取り除く。
	 * その名前の接続が 1 つも残らなければサニタイズ名の対応も落とす。
	 */
	remove(serverName: string, source?: "global" | "project"): void {
		this.connections = this.connections.filter((conn) => !this.isTarget(conn, serverName, source))

		if (!this.connections.some((conn) => conn.server.name === serverName)) {
			this.sanitizedNames.delete(sanitizeMcpName(serverName))
		}
	}

	/** 接続一覧を丸ごと差し替える（テストのセットアップ用）。 */
	replaceAll(connections: McpConnection[]): void {
		this.connections = [...connections]
	}

	/** 接続一覧を空にする（サニタイズ名の対応は保つ: dispose 後の解決に使われうる）。 */
	clear(): void {
		this.connections = []
	}

	private isTarget(conn: McpConnection, serverName: string, source?: "global" | "project"): boolean {
		if (conn.server.name !== serverName) return false
		if (source && conn.server.source !== source) return false
		return true
	}
}
