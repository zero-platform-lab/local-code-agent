import * as path from "path"
import { promises as fs } from "fs"

import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git"

import { buildGitInvocation, type SkillSourceProxy } from "./skillSourceGit"
import { parseSkillSourceUrl } from "./skillSourcePath"

/**
 * スキルの取得元を clone / pull する（`FR-EXT-05` `FR-EXT-05d`）。
 *
 * 置き場所は `<baseDir>/<ホスト名>/<パス>` で、URL から機械的に決まる
 * （`FR-EXT-05c1`）。**`~/.agent/skills` へは置かない。** 利用者が手で置いたスキルと
 * 混ざると、取得のたびにどれを消してよいか判別できなくなる（`FR-EXT-05e`）。
 *
 * git を起動する層はここだけにする。設定の組み立ては `skillSourceGit.ts`、URL の解釈は
 * `skillSourcePath.ts` にあり、どちらも git を起動しないので単体で確かめられる。
 */

export type FetchSkillSourceParams = {
	url: string
	/** 取得元を置く根。ふつうは `~/.agent/skill-sources`。 */
	baseDir: string
	proxy?: SkillSourceProxy
}

export type FetchSkillSourceResult =
	| {
			ok: true
			/** 取得したディレクトリの絶対パス。探索先へ足すのはここ。 */
			directory: string
			action: "cloned" | "updated"
			/** SSH の取得元に proxy を指定していた。git は黙って無視する（`FR-EXT-05b3`）。 */
			proxyIgnored: boolean
	  }
	| { ok: false; error: string }

export type GitFactory = (options: Partial<SimpleGitOptions>) => SimpleGit

type Deps = {
	gitFactory: GitFactory
	directoryExists: (dirPath: string) => Promise<boolean>
	ensureDirectory: (dirPath: string) => Promise<void>
}

/** 既定の依存。実ファイルに触るのはここだけで、ほかは注入で差し替えられる。 */
export const defaultDeps: Deps = {
	gitFactory: simpleGit,
	directoryExists: async (dirPath) => {
		try {
			return (await fs.stat(dirPath)).isDirectory()
		} catch {
			return false
		}
	},
	ensureDirectory: async (dirPath) => {
		await fs.mkdir(dirPath, { recursive: true })
	},
}

function gitOptions(baseDir: string, config: string[]): Partial<SimpleGitOptions> {
	return {
		baseDir,
		config,
		// simple-git は、環境変数が editor / pager / askpass を起動させ得る状態だと
		// 操作そのものを拒む。こちらは `GIT_TERMINAL_PROMPT=0` で入力を待たせない側に
		// 倒しているので、親から紛れ込んだ変数で止まらないよう明示的に許す。
		unsafe: {
			allowUnsafeEditor: true,
			allowUnsafePager: true,
			allowUnsafeAskPass: true,
		},
	}
}

export async function fetchSkillSource(
	params: FetchSkillSourceParams,
	deps: Deps = defaultDeps,
): Promise<FetchSkillSourceResult> {
	const parsed = parseSkillSourceUrl(params.url)
	if (!parsed.valid) {
		return { ok: false, error: parsed.error }
	}

	const directory = path.join(params.baseDir, parsed.value.directory)
	const invocation = buildGitInvocation(parsed.value.transport, params.proxy)

	try {
		if (await deps.directoryExists(path.join(directory, ".git"))) {
			// 2 回目以降は更新する（`FR-EXT-05d`）。消して clone し直すと、取得元に
			// 無いものまで巻き添えで消える。
			const git = deps.gitFactory(gitOptions(directory, invocation.config))
			git.env({ ...process.env, ...invocation.env })
			await git.pull()
			return { ok: true, directory, action: "updated", proxyIgnored: invocation.proxyIgnored }
		}

		const parent = path.dirname(directory)
		await deps.ensureDirectory(parent)

		const git = deps.gitFactory(gitOptions(parent, invocation.config))
		git.env({ ...process.env, ...invocation.env })
		await git.clone(params.url, directory)

		return { ok: true, directory, action: "cloned", proxyIgnored: invocation.proxyIgnored }
	} catch (error) {
		// git の出力には proxy の URL が混じり得る。利用者へ返す前に資格情報を落とす。
		const message = error instanceof Error ? error.message : String(error)
		return { ok: false, error: redactCredentials(message) }
	}
}

/**
 * git の出力から、URL に埋まった資格情報を落とす（`FR-EXT-06e`）。
 * こちらは URL へ埋めない方針だが、利用者が `https://user:token@host/...` と
 * 書いた場合はそのまま出力へ現れる。
 */
export function redactCredentials(message: string): string {
	return message.replace(/([a-z0-9+.-]+:\/\/)[^@\s/]*@/gi, "$1<伏せた>@")
}
