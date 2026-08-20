import * as path from "path"

/**
 * mode ごとの rules フォルダ (`rules-{slug}`) の場所を決める規則と、
 * import 時に書き込んで良いパスかどうかの判定。
 *
 * 分割前は同じ規則が 4 メソッド（delete / checkRulesDirectoryHasContent / export / import）に
 * インラインで重複しており、しかも delete だけ `os.homedir() + "/.agent"` を直に組み立てて
 * いた（`getGlobalAgentDirectory()` と同値だが、片方を変えると壊れる形）。
 *
 * base ディレクトリを引数で受けるので vscode / os に依存しない純関数。
 */

export type ModeScope = "global" | "project"

export interface ModeRulesDirInput {
	slug: string
	scope: ModeScope
	/** ワークスペースが無い場合は undefined。project scope のとき解決不能になる。 */
	workspacePath: string | undefined
	/** `getGlobalAgentDirectory()` の値（= `~/.agent`）。 */
	globalAgentDir: string
}

/**
 * rules フォルダの絶対パス。project scope でワークスペースが無いときだけ `undefined`
 * （呼び出し側は「何もしない」を選ぶ）。
 *
 * - global : `<globalAgentDir>/rules-{slug}`
 * - project: `<workspacePath>/.agent/rules-{slug}`
 */
export function resolveModeRulesDir(input: ModeRulesDirInput): string | undefined {
	if (input.scope === "global") {
		return path.join(input.globalAgentDir, `rules-${input.slug}`)
	}

	if (!input.workspacePath) {
		return undefined
	}

	return path.join(input.workspacePath, ".agent", `rules-${input.slug}`)
}

/** 旧 export 形式の `rules-xxx/` 先頭ディレクトリを剥がすための判定。 */
const LEGACY_RULES_PREFIX = /^rules-[^/\\]+[/\\]/

export type RuleFileTarget =
	| {
			ok: true
			/** 実際に書き込む絶対パス。 */
			targetPath: string
			/** 旧形式で剥がした接頭辞（`rules-foo/`）。剥がしていなければ undefined。 */
			strippedLegacyPrefix?: string
	  }
	| {
			ok: false
			/** `invalid-path`: 絶対パス or `..` を含む / `path-traversal`: 結合結果が rules フォルダ外 */
			reason: "invalid-path" | "path-traversal"
	  }

/**
 * import される rule ファイルの相対パスを検証し、書き込み先の絶対パスを決める。
 *
 * 2 段構えなのは元コードのまま: まず素の相対パスを弾き、次に結合後のパスが rules フォルダ内に
 * 収まっているかを再確認する（`rules-*` 接頭辞の除去を挟むため、1 段目だけでは足りない）。
 */
export function resolveRuleFileTarget(rulesFolderPath: string, relativePath: string): RuleFileTarget {
	const normalized = path.normalize(relativePath)

	if (normalized.includes("..") || path.isAbsolute(normalized)) {
		return { ok: false, reason: "invalid-path" }
	}

	const legacyMatch = normalized.match(LEGACY_RULES_PREFIX)
	const cleaned = legacyMatch ? normalized.substring(legacyMatch[0].length) : normalized

	const targetPath = path.join(rulesFolderPath, cleaned)

	if (!path.normalize(targetPath).startsWith(path.normalize(rulesFolderPath))) {
		return { ok: false, reason: "path-traversal" }
	}

	return legacyMatch ? { ok: true, targetPath, strippedLegacyPrefix: legacyMatch[0] } : { ok: true, targetPath }
}
