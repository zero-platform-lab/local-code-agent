import type { ModeConfig } from "@openai-agent/types"

/**
 * project (`.agentmodes`) と global (settings YAML) の mode 一覧を 1 本にまとめる規則。
 *
 * 規則は 2 つだけ:
 *   1. **slug の重複は先に来たものが勝つ**（同一ファイル内の重複も含む）
 *   2. project が global より先に並ぶ = project が優先
 *
 * 併せて `source` を「どちらのファイル由来か」で上書きする。ファイル側の記述を信用せず
 * 常に読み込み元で決めるのは、`.agentmodes` に `source: global` と書かれていても
 * project mode として扱う必要があるため。
 *
 * vscode / fs に依存しない純関数。CustomModesManager が「読み込み」「watcher からの再構築」
 * 「書き込み後の再構築」の 3 経路で同じ規則を使う。
 */
export function mergeCustomModes(projectModes: ModeConfig[], globalModes: ModeConfig[]): ModeConfig[] {
	const seen = new Set<string>()
	const merged: ModeConfig[] = []

	for (const [modes, source] of [
		[projectModes, "project"],
		[globalModes, "global"],
	] as const) {
		for (const mode of modes) {
			if (seen.has(mode.slug)) {
				continue
			}

			seen.add(mode.slug)
			merged.push({ ...mode, source })
		}
	}

	return merged
}
