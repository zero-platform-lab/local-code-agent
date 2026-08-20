import type { McpTool } from "@openai-agent/types"

/** `alwaysAllow` に入れると全ツールを自動承認するワイルドカード。 */
const ALWAYS_ALLOW_WILDCARD = "*"

/** 設定ファイルから読んだ、サーバ単位のツール許可設定。 */
export interface ServerToolFlags {
	/** 自動承認するツール名。`"*"` を含むと全許可。 */
	alwaysAllow?: string[]
	/** システムプロンプトに載せないツール名。 */
	disabledTools?: string[]
}

/**
 * サーバから取得したツール一覧に、設定ファイル由来のフラグを載せる。
 *
 * `alwaysAllow` はユーザーの自動承認設定、`enabledForPrompt` は
 * 「モデルにこのツールを見せるか」。どちらも設定ファイルが正で、サーバ応答には含まれない。
 */
export function applyToolConfigFlags(tools: McpTool[], flags: ServerToolFlags): McpTool[] {
	const alwaysAllow = flags.alwaysAllow ?? []
	const disabledTools = flags.disabledTools ?? []
	const hasWildcard = alwaysAllow.includes(ALWAYS_ALLOW_WILDCARD)

	return tools.map((tool) => ({
		...tool,
		alwaysAllow: hasWildcard || alwaysAllow.includes(tool.name),
		enabledForPrompt: !disabledTools.includes(tool.name),
	}))
}

/**
 * ツール名リストへの追加/削除を行う。
 *
 * 追加は重複を作らず、削除は存在しなければ何もしない（どちらも冪等）。
 *
 * @param list 現在のリスト。未定義なら空から始める。
 * @param shouldContain true なら含める、false なら取り除く。
 * @returns 更新後のリスト（入力配列を直接書き換える。未定義だった場合のみ新規配列）。
 */
export function toggleToolInList(list: string[] | undefined, toolName: string, shouldContain: boolean): string[] {
	const targetList = list ?? []
	const toolIndex = targetList.indexOf(toolName)

	if (shouldContain && toolIndex === -1) {
		targetList.push(toolName)
	} else if (!shouldContain && toolIndex !== -1) {
		targetList.splice(toolIndex, 1)
	}

	return targetList
}
