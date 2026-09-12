import * as path from "path"
import { promises as fs } from "fs"

/**
 * 取得したスキルを、ほかの AI コーディングツールと共有する場所へ複製する
 * （`FR-EXT-05f`）。
 *
 * 共有する場所は `~/.agents/skills` で、ほかのツールが置いたものが同居している。
 * **こちらが置いたものだけを後から取り除けるようにする**（`FR-EXT-05f2`）。そのため、
 * 複製した各スキルの中に取得元の URL を書いた目印を置き、取り除くときはその目印が
 * あるものだけを見る。目印が無いディレクトリには触らない。
 *
 * **複製した取得元は探索先へ足さない**（`FR-EXT-05f1`）。足すと、複製した先と取得元の
 * 両方から同じスキルが見つかり、二重に並ぶ。取得元の根にも目印を置き、
 * `findSkillSourceRoots` がそれを見て外す。設定を読まずに済む。
 *
 * `.git` ごとは複製しない。共有する場所に履歴を置くと、ほかのツールが管理している
 * ものと混ざる。
 */

/** 複製したスキルの中に置く目印。中身は取得元の URL。 */
export const COPY_MARKER = ".agent-skill-source"

/** 複製した取得元の根に置く目印。探索先へ足さないことを示す（`FR-EXT-05f1`）。 */
export const COPIED_MARKER = ".agent-copied-to-shared"

/** スキルはこの file を持つディレクトリ。持たないものはスキルではない。 */
const SKILL_FILE = "SKILL.md"

export type CopySkillsParams = {
	/** 取得元のディレクトリ。`~/.agent/skill-sources/<ホスト名>/<パス>`。 */
	sourceDir: string
	/** 共有する場所。`~/.agents/skills`。 */
	sharedDir: string
	/** 取得元の URL。目印に書いて、取り除くときの目当てにする。 */
	url: string
}

export type CopySkillsResult = {
	/** 複製したスキルの名前。 */
	copied: string[]
	/** ほかのツールが置いていたので触らなかった名前（`FR-EXT-05f2`）。 */
	skipped: string[]
}

async function readMarker(dirPath: string): Promise<string | undefined> {
	try {
		return (await fs.readFile(path.join(dirPath, COPY_MARKER), "utf8")).trim()
	} catch {
		return undefined
	}
}

async function directoryExists(dirPath: string): Promise<boolean> {
	try {
		return (await fs.stat(dirPath)).isDirectory()
	} catch {
		return false
	}
}

/** `SKILL.md` を持つ直下のディレクトリの名前を、順序をそろえて返す。 */
export async function listSkillDirectories(sourceDir: string): Promise<string[]> {
	let entries: string[]
	try {
		entries = await fs.readdir(sourceDir)
	} catch {
		return []
	}

	const names: string[] = []
	for (const entry of entries.sort()) {
		try {
			await fs.access(path.join(sourceDir, entry, SKILL_FILE))
			names.push(entry)
		} catch {
			// SKILL.md を持たないものはスキルではない。`.git` もここで外れる。
		}
	}

	return names
}

/** 取得元が複製済みかを見る。探索先へ足すかの判断に使う（`FR-EXT-05f1`）。 */
export async function isCopiedSource(sourceDir: string): Promise<boolean> {
	try {
		await fs.access(path.join(sourceDir, COPIED_MARKER))
		return true
	} catch {
		return false
	}
}

export async function copySkillsToShared(params: CopySkillsParams): Promise<CopySkillsResult> {
	const { sourceDir, sharedDir, url } = params
	const copied: string[] = []
	const skipped: string[] = []

	await fs.mkdir(sharedDir, { recursive: true })

	for (const name of await listSkillDirectories(sourceDir)) {
		const target = path.join(sharedDir, name)

		if ((await directoryExists(target)) && (await readMarker(target)) === undefined) {
			// 目印が無い。ほかのツールか利用者が置いたものなので触らない。
			skipped.push(name)
			continue
		}

		// 目印があるものは、こちらが前に置いたもの。取得元に無くなった file を
		// 残さないよう、消してから置き直す。
		await fs.rm(target, { recursive: true, force: true })
		await fs.cp(path.join(sourceDir, name), target, { recursive: true })
		await fs.writeFile(path.join(target, COPY_MARKER), `${url}\n`, "utf8")
		copied.push(name)
	}

	await fs.writeFile(path.join(sourceDir, COPIED_MARKER), `${url}\n`, "utf8")

	return { copied, skipped }
}

/**
 * その取得元から複製したものだけを取り除く（`FR-EXT-05f2`）。
 * 目印が無いものと、別の取得元の目印が付いたものには触らない。
 */
export async function removeCopiedSkills(params: { sharedDir: string; url: string }): Promise<string[]> {
	let entries: string[]
	try {
		entries = await fs.readdir(params.sharedDir)
	} catch {
		return []
	}

	const removed: string[] = []
	for (const name of entries.sort()) {
		const target = path.join(params.sharedDir, name)
		if ((await readMarker(target)) !== params.url) {
			continue
		}

		await fs.rm(target, { recursive: true, force: true })
		removed.push(name)
	}

	return removed
}

/** 取得元の根の目印を外す。以降は探索先へ足される。 */
export async function clearCopiedMarker(sourceDir: string): Promise<void> {
	await fs.rm(path.join(sourceDir, COPIED_MARKER), { force: true })
}
