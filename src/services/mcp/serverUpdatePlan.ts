import deepEqual from "fast-deep-equal"

import { validateServerConfig, type ServerConfig } from "./serverConfigSchema"

/**
 * 設定ファイルの内容と現在の接続集合から、「どのサーバをどう扱うか」を決める純粋な調停。
 *
 * 副作用（実接続・watcher 操作・エラー表示）は持たず、実行計画だけを返す。McpHub は
 * この計画をそのままの順序で実行する。接続 lifecycle のうち判断部分だけを切り出したので、
 * fake の入力で網羅的に単体テストできる。
 */

export type ServerConnectionAction =
	| { kind: "connect"; name: string; config: ServerConfig }
	| { kind: "reconnect"; name: string; config: ServerConfig }
	| { kind: "invalid"; name: string; error: unknown }

export interface ServerUpdatePlan {
	/** 新しい設定から消えたサーバ（先に切断する）。 */
	toDelete: string[]
	/**
	 * 新しい設定に載っているサーバへの操作（設定ファイルの記述順）。
	 * 設定が同一の既存サーバは何もしないので含めない。
	 */
	actions: ServerConnectionAction[]
}

/**
 * @param newServers 検証前の宣言（設定ファイル由来）。
 * @param currentNames 現在このソースが所有する接続名。
 * @param getCurrentConnection 名前から既存接続（の宣言済み設定）を引く。無ければ undefined。
 */
export function planServerConnectionUpdates(
	newServers: Record<string, unknown>,
	currentNames: Iterable<string>,
	getCurrentConnection: (name: string) => { declaredConfig: ServerConfig } | undefined,
): ServerUpdatePlan {
	const newNames = new Set(Object.keys(newServers))
	const toDelete = [...currentNames].filter((name) => !newNames.has(name))

	const actions: ServerConnectionAction[] = []
	for (const [name, config] of Object.entries(newServers)) {
		let validatedConfig: ServerConfig
		try {
			validatedConfig = validateServerConfig(config, name)
		} catch (error) {
			actions.push({ kind: "invalid", name, error })
			continue
		}

		const current = getCurrentConnection(name)
		if (!current) {
			actions.push({ kind: "connect", name, config: validatedConfig })
		} else if (!deepEqual(current.declaredConfig, validatedConfig)) {
			// 既存だが宣言（変数展開前）が変わった＝張り直し。展開後で比較すると
			// ${env:...} を含む設定が毎回「変わった」と誤判定されるため宣言で比べる（#250）。
			actions.push({ kind: "reconnect", name, config: validatedConfig })
		}
		// 既存かつ同一設定 → 何もしない
	}

	return { toDelete, actions }
}
