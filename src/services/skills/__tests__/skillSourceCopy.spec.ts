// npx vitest run services/skills/__tests__/skillSourceCopy.spec.ts
//
// 取得したスキルを `~/.agents/skills` へ複製する層。
//
// **本物のファイルを使う。** 守りたいのは「ほかのツールが置いたものに触らない」
// ことで、これはモックでは確かめられない。消す対象の判定そのものを見たい。

import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"

import {
	COPIED_MARKER,
	COPY_MARKER,
	clearCopiedMarker,
	copySkillsToShared,
	isCopiedSource,
	listSkillDirectories,
	removeCopiedSkills,
} from "../skillSourceCopy"

const URL = "https://gitlab.example.com/platform/skills.git"

let root: string
let sourceDir: string
let sharedDir: string

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-copy-"))
	sourceDir = path.join(root, "source")
	sharedDir = path.join(root, "shared")
	await fs.mkdir(sourceDir, { recursive: true })
})

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

const makeSkill = async (dir: string, name: string, body = "# skill") => {
	await fs.mkdir(path.join(dir, name), { recursive: true })
	await fs.writeFile(path.join(dir, name, "SKILL.md"), body, "utf8")
}

const read = (...segments: string[]) => fs.readFile(path.join(...segments), "utf8")

const exists = async (...segments: string[]) => {
	try {
		await fs.access(path.join(...segments))
		return true
	} catch {
		return false
	}
}

describe("listSkillDirectories", () => {
	it("SKILL.md を持つものだけを、順序をそろえて返す", async () => {
		await makeSkill(sourceDir, "review")
		await makeSkill(sourceDir, "deploy")
		await fs.mkdir(path.join(sourceDir, ".git"), { recursive: true })
		await fs.mkdir(path.join(sourceDir, "docs"), { recursive: true })
		await fs.writeFile(path.join(sourceDir, "README.md"), "x", "utf8")

		expect(await listSkillDirectories(sourceDir)).toEqual(["deploy", "review"])
	})

	it("ディレクトリが無ければ空", async () => {
		expect(await listSkillDirectories(path.join(root, "無い"))).toEqual([])
	})
})

describe("copySkillsToShared", () => {
	it("スキルを複製し、取得元の URL を目印に残す", async () => {
		await makeSkill(sourceDir, "review", "# review")
		await fs.mkdir(path.join(sourceDir, "review", "nested"), { recursive: true })
		await fs.writeFile(path.join(sourceDir, "review", "nested", "note.md"), "中身", "utf8")

		const result = await copySkillsToShared({ sourceDir, sharedDir, url: URL })

		expect(result).toEqual({ copied: ["review"], skipped: [] })
		expect(await read(sharedDir, "review", "SKILL.md")).toBe("# review")
		// 入れ子ごと複製する。
		expect(await read(sharedDir, "review", "nested", "note.md")).toBe("中身")
		expect((await read(sharedDir, "review", COPY_MARKER)).trim()).toBe(URL)
	})

	it("ほかのツールが置いたものには触らない（FR-EXT-05f2）", async () => {
		await makeSkill(sourceDir, "review", "# こちらの中身")
		await makeSkill(sharedDir, "review", "# よそが置いた中身")

		const result = await copySkillsToShared({ sourceDir, sharedDir, url: URL })

		expect(result).toEqual({ copied: [], skipped: ["review"] })
		// 上書きしない。目印も置かない。
		expect(await read(sharedDir, "review", "SKILL.md")).toBe("# よそが置いた中身")
		expect(await exists(sharedDir, "review", COPY_MARKER)).toBe(false)
	})

	it("2 回目は、取得元から消えた file を残さない", async () => {
		await makeSkill(sourceDir, "review")
		await fs.writeFile(path.join(sourceDir, "review", "old.md"), "古い", "utf8")
		await copySkillsToShared({ sourceDir, sharedDir, url: URL })

		await fs.rm(path.join(sourceDir, "review", "old.md"))
		const result = await copySkillsToShared({ sourceDir, sharedDir, url: URL })

		expect(result).toEqual({ copied: ["review"], skipped: [] })
		expect(await exists(sharedDir, "review", "old.md")).toBe(false)
	})

	it("複製した取得元には、探索先へ足さない目印を置く（FR-EXT-05f1）", async () => {
		await makeSkill(sourceDir, "review")

		expect(await isCopiedSource(sourceDir)).toBe(false)

		await copySkillsToShared({ sourceDir, sharedDir, url: URL })

		expect(await isCopiedSource(sourceDir)).toBe(true)
		expect((await read(sourceDir, COPIED_MARKER)).trim()).toBe(URL)
	})

	it("スキルが 1 つも無くても、目印だけは置く", async () => {
		const result = await copySkillsToShared({ sourceDir, sharedDir, url: URL })

		expect(result).toEqual({ copied: [], skipped: [] })
		expect(await isCopiedSource(sourceDir)).toBe(true)
	})
})

describe("removeCopiedSkills", () => {
	it("その取得元の目印が付いたものだけを取り除く（FR-EXT-05f2）", async () => {
		await makeSkill(sourceDir, "review")
		await makeSkill(sourceDir, "deploy")
		await copySkillsToShared({ sourceDir, sharedDir, url: URL })
		// ほかのツールが置いたもの。
		await makeSkill(sharedDir, "other")
		// 別の取得元から複製したもの。
		await makeSkill(sharedDir, "another")
		await fs.writeFile(path.join(sharedDir, "another", COPY_MARKER), "https://other.example/x.git\n", "utf8")

		const removed = await removeCopiedSkills({ sharedDir, url: URL })

		expect(removed).toEqual(["deploy", "review"])
		expect(await exists(sharedDir, "other", "SKILL.md")).toBe(true)
		expect(await exists(sharedDir, "another", "SKILL.md")).toBe(true)
		expect(await exists(sharedDir, "review")).toBe(false)
	})

	it("共有する場所がまだ無ければ何もしない", async () => {
		expect(await removeCopiedSkills({ sharedDir, url: URL })).toEqual([])
	})
})

describe("clearCopiedMarker", () => {
	it("目印を外すと、探索先へ足される側に戻る", async () => {
		await makeSkill(sourceDir, "review")
		await copySkillsToShared({ sourceDir, sharedDir, url: URL })

		await clearCopiedMarker(sourceDir)

		expect(await isCopiedSource(sourceDir)).toBe(false)
	})

	it("目印が無くても落ちない", async () => {
		await expect(clearCopiedMarker(sourceDir)).resolves.toBeUndefined()
	})
})
