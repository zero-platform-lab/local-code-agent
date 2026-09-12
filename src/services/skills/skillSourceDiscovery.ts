import * as path from "path"
import { promises as fs } from "fs"

import { COPIED_MARKER } from "./skillSourceCopy"

/**
 * 取得済みのスキルの取得元を、ディスクから見つける（`FR-EXT-05e`）。
 *
 * **設定を読まない。** 取得元は `<baseDir>/<ホスト名>/<パス>` へ置かれ、深さは URL の
 * パスによって変わる。`.git` を持つディレクトリが取得元の根なので、そこまで降りて
 * 集める。設定を引数に取ると `SkillsManagerProvider`（いまは `cwd` だけの最小表面）へ
 * 依存が増えるため、ディスクを唯一の出所にする。
 *
 * 取得元を消すのはディレクトリを消すだけでよく、この関数は自然に追随する。
 */

/** 降りる深さの上限。`<ホスト名>/<グループ>/…/<リポジトリ>` を想定した余裕を持つ。 */
const MAX_DEPTH = 6

type Deps = {
	readDirectory: (dirPath: string) => Promise<string[]>
	isDirectory: (dirPath: string) => Promise<boolean>
}

export const defaultDiscoveryDeps: Deps = {
	readDirectory: async (dirPath) => {
		try {
			return await fs.readdir(dirPath)
		} catch {
			return []
		}
	},
	isDirectory: async (dirPath) => {
		try {
			return (await fs.stat(dirPath)).isDirectory()
		} catch {
			return false
		}
	},
}

/**
 * `baseDir` の下から、取得元の根（`.git` を持つディレクトリ）を集める。
 * 見つかった枝はそこで止める。リポジトリの中に入れ子のリポジトリがあっても追わない。
 */
export async function findSkillSourceRoots(baseDir: string, deps: Deps = defaultDiscoveryDeps): Promise<string[]> {
	const roots: string[] = []

	const walk = async (dirPath: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH) return

		const entries = await deps.readDirectory(dirPath)
		if (entries.length === 0) return

		if (entries.includes(".git")) {
			// 複製した取得元は足さない（`FR-EXT-05f1`）。足すと、複製した先と取得元の
			// 両方から同じスキルが見つかり、一覧に二重に並ぶ。
			if (!entries.includes(COPIED_MARKER)) {
				roots.push(dirPath)
			}
			return
		}

		for (const entry of entries) {
			const child = path.join(dirPath, entry)
			if (await deps.isDirectory(child)) {
				await walk(child, depth + 1)
			}
		}
	}

	await walk(baseDir, 0)

	// 並び順をそろえる。探索先の順で優先が決まるので、実行のたびに変わると
	// 同名のスキルの勝ち負けが揺れる。
	return roots.sort()
}
