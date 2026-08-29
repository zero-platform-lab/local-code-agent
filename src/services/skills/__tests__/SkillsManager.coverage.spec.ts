import * as path from "path"
import type { SkillMetadata } from "../../../shared/skills"

// SkillsManager.ts の未到達分岐を埋める補完スペック。既存 SkillsManager.spec.ts と同じ
// モック方針（fs/promises・os・vscode・agent-config・i18n をモック）に加え、
// ファイルウォッチャのコールバック本体を検証するため vscode ウォッチャの購読を捕捉する。
const {
	mockStat,
	mockReadFile,
	mockReaddir,
	mockRealpath,
	mockMkdir,
	mockWriteFile,
	mockRm,
	mockRename,
	mockRmdir,
	mockDirectoryExists,
	mockFileExists,
	mockCreateWatcher,
	watcherSubs,
} = vi.hoisted(() => ({
	mockStat: vi.fn(),
	mockReadFile: vi.fn(),
	mockReaddir: vi.fn(),
	mockRealpath: vi.fn(),
	mockMkdir: vi.fn(),
	mockWriteFile: vi.fn(),
	mockRm: vi.fn(),
	mockRename: vi.fn(),
	mockRmdir: vi.fn(),
	mockDirectoryExists: vi.fn(),
	mockFileExists: vi.fn(),
	mockCreateWatcher: vi.fn(),
	watcherSubs: { change: [] as any[], create: [] as any[], delete: [] as any[] },
}))

vi.mock("fs/promises", () => ({
	default: {
		stat: mockStat,
		readFile: mockReadFile,
		readdir: mockReaddir,
		realpath: mockRealpath,
		mkdir: mockMkdir,
		writeFile: mockWriteFile,
		rm: mockRm,
		rename: mockRename,
		rmdir: mockRmdir,
	},
	stat: mockStat,
	readFile: mockReadFile,
	readdir: mockReaddir,
	realpath: mockRealpath,
	mkdir: mockMkdir,
	writeFile: mockWriteFile,
	rm: mockRm,
	rename: mockRename,
	rmdir: mockRmdir,
}))

const HOME_DIR = "/home/user"
const PROJECT_DIR = "/test/project"
const GLOBAL_ROO_DIR = path.join(HOME_DIR, ".agent")
const GLOBAL_AGENTS_DIR = path.join(HOME_DIR, ".agents")

vi.mock("os", () => ({ homedir: () => HOME_DIR }))

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: mockCreateWatcher,
	},
	RelativePattern: vi.fn(),
}))

vi.mock("../../agent-config", () => ({
	getGlobalAgentDirectory: () => GLOBAL_ROO_DIR,
	getGlobalAgentsDirectory: () => GLOBAL_AGENTS_DIR,
	getProjectAgentsDirectoryForCwd: (cwd: string) => path.join(cwd, ".agents"),
	directoryExists: mockDirectoryExists,
	fileExists: mockFileExists,
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, params?: Record<string, any>) => `${key}:${JSON.stringify(params ?? {})}`,
}))

import { SkillsManager, type SkillsManagerProvider } from "../SkillsManager"

function makeProvider(overrides: Partial<SkillsManagerProvider> = {}): SkillsManagerProvider {
	return {
		cwd: PROJECT_DIR,
		...overrides,
	}
}

/** this.skills に直接メタデータを差し込む（純粋ロジックの分岐検証用）。key は getSkillKey と同形式。 */
function setSkill(sm: SkillsManager, meta: SkillMetadata) {
	const primaryMode = meta.modeSlugs?.[0] ?? meta.mode
	const key = `${meta.source}:${primaryMode || "generic"}:${meta.name}`
	;(sm as any).skills.set(key, meta)
}

const skill = (over: Partial<SkillMetadata> & Pick<SkillMetadata, "name" | "source">): SkillMetadata => ({
	description: "d",
	path: `/skills/${over.name}/SKILL.md`,
	...over,
})

beforeEach(() => {
	vi.clearAllMocks()
	watcherSubs.change = []
	watcherSubs.create = []
	watcherSubs.delete = []
	mockDirectoryExists.mockResolvedValue(false)
	mockFileExists.mockResolvedValue(false)
	mockRealpath.mockImplementation(async (p: string) => p)
	mockCreateWatcher.mockImplementation(() => ({
		onDidChange: (cb: any) => watcherSubs.change.push(cb),
		onDidCreate: (cb: any) => watcherSubs.create.push(cb),
		onDidDelete: (cb: any) => watcherSubs.delete.push(cb),
		dispose: vi.fn(),
	}))
})

describe("discoverSkills: SKILL.md のバリデーションと mode 解決", () => {
	// 1つの skills ディレクトリに1つの skill サブディレクトリを持たせるヘルパ。
	function primeSingleSkill(skillDirName: string, skillMd: string) {
		const skillsDir = path.join(GLOBAL_ROO_DIR, "skills")
		const skillDir = path.join(skillsDir, skillDirName)
		const skillMdPath = path.join(skillDir, "SKILL.md")
		mockDirectoryExists.mockImplementation(async (dir: string) => dir === skillsDir)
		mockReaddir.mockImplementation(async (dir: string) => (dir === skillsDir ? [skillDirName] : []))
		mockStat.mockImplementation(async (p: string) =>
			p === skillDir ? { isDirectory: () => true } : Promise.reject(new Error("nope")),
		)
		mockFileExists.mockImplementation(async (f: string) => f === skillMdPath)
		mockReadFile.mockImplementation(async (f: string) =>
			f === skillMdPath ? skillMd : Promise.reject(new Error("x")),
		)
	}

	it("name フィールドが無い SKILL.md はスキップ（118-121 行）", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		primeSingleSkill("thing", `---\ndescription: has no name\n---\nbody`)
		const sm = new SkillsManager(makeProvider())
		await sm.discoverSkills()
		expect(sm.getAllSkills()).toHaveLength(0)
	})

	it("modeSlugs 配列を解釈する（157-158 行）", async () => {
		primeSingleSkill("multi", `---\nname: multi\ndescription: d\nmodeSlugs:\n  - code\n  - architect\n---\nb`)
		const sm = new SkillsManager(makeProvider())
		await sm.discoverSkills()
		const s = sm.getAllSkills()
		expect(s).toHaveLength(1)
		expect(s[0].modeSlugs).toEqual(["code", "architect"])
	})

	it("modeSlugs が空配列に絞られると any mode 扱い（159-161 行）", async () => {
		// 非文字列のみ → filter で空 → undefined
		primeSingleSkill("empty", `---\nname: empty\ndescription: d\nmodeSlugs:\n  - 123\n  - true\n---\nb`)
		const sm = new SkillsManager(makeProvider())
		await sm.discoverSkills()
		const s = sm.getAllSkills()
		expect(s).toHaveLength(1)
		expect(s[0].modeSlugs).toBeUndefined()
	})

	it("legacy な単一 mode 文字列を modeSlugs に変換（162, 164 行）", async () => {
		primeSingleSkill("legacy", `---\nname: legacy\ndescription: d\nmode: code\n---\nb`)
		const sm = new SkillsManager(makeProvider())
		await sm.discoverSkills()
		const s = sm.getAllSkills()
		expect(s).toHaveLength(1)
		expect(s[0].modeSlugs).toEqual(["code"])
	})

	it("SKILL.md 読み取り例外は握りつぶす（183-185 行）", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const skillsDir = path.join(GLOBAL_ROO_DIR, "skills")
		const skillDir = path.join(skillsDir, "boom")
		const skillMdPath = path.join(skillDir, "SKILL.md")
		mockDirectoryExists.mockImplementation(async (dir: string) => dir === skillsDir)
		mockReaddir.mockImplementation(async (dir: string) => (dir === skillsDir ? ["boom"] : []))
		mockStat.mockImplementation(async (p: string) =>
			p === skillDir ? { isDirectory: () => true } : Promise.reject(new Error("nope")),
		)
		mockFileExists.mockImplementation(async (f: string) => f === skillMdPath)
		mockReadFile.mockRejectedValue(new Error("read fail"))
		const sm = new SkillsManager(makeProvider())
		await sm.discoverSkills()
		expect(sm.getAllSkills()).toHaveLength(0)
	})

	it("エントリが非ディレクトリなら skip（85 行）", async () => {
		const skillsDir = path.join(GLOBAL_ROO_DIR, "skills")
		mockDirectoryExists.mockImplementation(async (dir: string) => dir === skillsDir)
		mockReaddir.mockImplementation(async (dir: string) => (dir === skillsDir ? ["afile", "gone"] : []))
		mockStat.mockImplementation(async (p: string) => {
			if (p.endsWith("afile")) return { isDirectory: () => false } as any
			throw new Error("stat fail") // gone → .catch(()=>null)
		})
		const sm = new SkillsManager(makeProvider())
		await sm.discoverSkills()
		expect(sm.getAllSkills()).toHaveLength(0)
	})

	it("scanSkillsDirectory は realpath/readdir 例外を握りつぶす（90-92 行）", async () => {
		const skillsDir = path.join(GLOBAL_ROO_DIR, "skills")
		mockDirectoryExists.mockImplementation(async (dir: string) => dir === skillsDir)
		mockRealpath.mockRejectedValue(new Error("realpath fail"))
		const sm = new SkillsManager(makeProvider())
		await expect(sm.discoverSkills()).resolves.toBeUndefined()
		expect(sm.getAllSkills()).toHaveLength(0)
	})
})

describe("getSkillsForMode: override 解決", () => {
	it("project は global を上書きする（250 行）", () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "global" }))
		setSkill(sm, skill({ name: "x", source: "project" }))
		const result = sm.getSkillsForMode("code")
		expect(result).toHaveLength(1)
		expect(result[0].source).toBe("project")
	})

	it("global は project を上書きしない（251 行）", () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "project" }))
		setSkill(sm, skill({ name: "x", source: "global" }))
		const result = sm.getSkillsForMode("code")
		expect(result).toHaveLength(1)
		expect(result[0].source).toBe("project")
	})

	it("同一 source では mode 特化が generic を上書きする（255-257 行）", () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "global" })) // generic
		setSkill(sm, skill({ name: "x", source: "global", modeSlugs: ["code"] })) // mode 特化
		const result = sm.getSkillsForMode("code")
		expect(result).toHaveLength(1)
		expect(result[0].modeSlugs).toEqual(["code"])
	})

	it("mode 特化は generic に上書きされない（258 行）", () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "global", modeSlugs: ["code"] }))
		setSkill(sm, skill({ name: "x", source: "global" })) // generic は勝てない
		const result = sm.getSkillsForMode("code")
		expect(result).toHaveLength(1)
		expect(result[0].modeSlugs).toEqual(["code"])
	})

	it("同一 source・同一特化度なら先勝ち（261-262 行）", () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "global", description: "first", path: "/a/SKILL.md" }))
		// 2件目は別 mode key を持たせて Map に共存させる（どちらも generic 特化度）
		;(sm as any).skills.set("global:generic2:x", skill({ name: "x", source: "global", description: "second" }))
		const result = sm.getSkillsForMode("code")
		expect(result).toHaveLength(1)
		expect(result[0].description).toBe("first")
	})
})

describe("参照系のヘルパ", () => {
	it("getSkillContent は currentMode 指定でモード対象から探す（275-277 行）", async () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "global", path: "/s/x/SKILL.md", modeSlugs: ["code"] }))
		mockReadFile.mockResolvedValue("---\nname: x\n---\nHello body")
		const content = await sm.getSkillContent("x", "code")
		expect(content?.instructions).toBe("Hello body")
	})

	it("findSkillByNameAndSource は該当を返し、無ければ undefined（316-322 行）", () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "project" }))
		expect(sm.findSkillByNameAndSource("x", "project")?.name).toBe("x")
		expect(sm.findSkillByNameAndSource("x", "global")).toBeUndefined()
		expect(sm.findSkillByNameAndSource("nope", "project")).toBeUndefined()
	})
})

describe("provider が GC された/未設定のケース", () => {
	afterEach(() => vi.unstubAllGlobals())

	it("providerRef.deref() が undefined でも discoverSkills は builtin モードで走る（588-589, 641-643 行）", async () => {
		vi.stubGlobal(
			"WeakRef",
			class {
				deref() {
					return undefined
				}
			},
		)
		const sm = new SkillsManager(makeProvider())
		await expect(sm.discoverSkills()).resolves.toBeUndefined()
		expect(sm.getAllSkills()).toHaveLength(0)
	})
})

describe("createSkill / deleteSkill / moveSkill / updateSkillModes", () => {
	it("空名の createSkill は Empty エラーメッセージで throw（341-342 行）", async () => {
		const sm = new SkillsManager(makeProvider())
		await expect(sm.createSkill("", "global", "desc")).rejects.toThrow(/name_length/)
	})

	it("project skill 作成で workspace が無ければ throw（382-384 行）", async () => {
		const sm = new SkillsManager(makeProvider({ cwd: "" }))
		await expect(sm.createSkill("valid-skill", "project", "desc")).rejects.toThrow(/no_workspace/)
	})

	it("deleteSkill は該当があればディレクトリごと削除（446 行の found 側）", async () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "global", path: "/s/x/SKILL.md" }))
		await sm.deleteSkill("x", "global")
		expect(mockRm).toHaveBeenCalledWith("/s/x", { recursive: true, force: true })
	})

	it("moveSkill は該当が無ければ throw（481 行）", async () => {
		const sm = new SkillsManager(makeProvider())
		await expect(sm.moveSkill("ghost", "project", undefined, "code")).rejects.toThrow(/not_found/)
	})

	it("moveSkill(project) は移動して空になった元ディレクトリを削除（489 偽側, 490-495, 523 行）", async () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "project", path: `${PROJECT_DIR}/.agent/skills/x/SKILL.md` }))
		mockFileExists.mockResolvedValue(false) // dest 未存在
		mockReaddir.mockResolvedValue([]) // 元 skills ディレクトリは空 → rmdir
		await sm.moveSkill("x", "project", undefined, "code")
		expect(mockRename).toHaveBeenCalled()
		expect(mockRmdir).toHaveBeenCalled()
	})

	it("moveSkill(global) の元ディレクトリ掃除で readdir が投げても握りつぶす（489 真側, 525 行）", async () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "global", path: `${GLOBAL_ROO_DIR}/skills/x/SKILL.md` }))
		mockFileExists.mockResolvedValue(false)
		mockReaddir.mockRejectedValue(new Error("readdir fail")) // cleanup で例外 → catch
		await expect(sm.moveSkill("x", "global", undefined, "code")).resolves.toBeUndefined()
		expect(mockRename).toHaveBeenCalled()
	})

	it("updateSkillModes は modeSlugs 指定で frontmatter を書き換える（537-559, 571 行）", async () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "global", path: "/s/x/SKILL.md" }))
		mockReadFile.mockResolvedValue("---\nname: x\nmode: old\n---\nbody")
		await sm.updateSkillModes("x", "global", ["code"])
		expect(mockWriteFile).toHaveBeenCalled()
		const written = String(mockWriteFile.mock.calls[0][1])
		expect(written).toContain("code")
	})

	it("updateSkillModes は空指定で mode 制限を外す（561-564 行）", async () => {
		const sm = new SkillsManager(makeProvider())
		setSkill(sm, skill({ name: "x", source: "global", path: "/s/x/SKILL.md", modeSlugs: ["code"] }))
		mockReadFile.mockResolvedValue("---\nname: x\nmodeSlugs:\n  - code\n---\nbody")
		await sm.updateSkillModes("x", "global", [])
		expect(mockWriteFile).toHaveBeenCalled()
	})

	it("updateSkillModes は該当が無ければ throw（547 行）", async () => {
		const sm = new SkillsManager(makeProvider())
		await expect(sm.updateSkillModes("ghost", "global", ["code"])).rejects.toThrow(/not_found/)
	})

	it("deleteSkill は該当が無ければ throw（445 行）", async () => {
		const sm = new SkillsManager(makeProvider())
		await expect(sm.deleteSkill("ghost", "global")).rejects.toThrow(/not_found/)
	})

	it("deleteSkill の not_found メッセージは mode 有りで mode 情報を含む（446 行の三項真側）", async () => {
		const sm = new SkillsManager(makeProvider())
		await expect(sm.deleteSkill("ghost", "global", "code")).rejects.toThrow(/mode: code/)
	})

	it("moveSkill の not_found メッセージは currentMode 有りで mode 情報を含む（481 行の三項真側）", async () => {
		const sm = new SkillsManager(makeProvider())
		// currentMode を指定して getSkill が見つからない → modeInfo の三項の真側を通す
		await expect(sm.moveSkill("ghost", "global", "code", "architect")).rejects.toThrow(/mode: code/)
	})

	it("moveSkill(project) で workspace が無ければ throw（491-493 行）", async () => {
		const sm = new SkillsManager(makeProvider({ cwd: "" }))
		setSkill(sm, skill({ name: "x", source: "project", path: "/p/.agent/skills/x/SKILL.md" }))
		await expect(sm.moveSkill("x", "project", undefined, "code")).rejects.toThrow(/no_workspace/)
	})
})

describe("loadSkillMetadata の残り分岐", () => {
	it("SKILL.md が存在しなければ skip（109 行の真側）", async () => {
		const skillsDir = path.join(GLOBAL_ROO_DIR, "skills")
		const skillDir = path.join(skillsDir, "nomd")
		mockDirectoryExists.mockImplementation(async (dir: string) => dir === skillsDir)
		mockReaddir.mockImplementation(async (dir: string) => (dir === skillsDir ? ["nomd"] : []))
		mockStat.mockImplementation(async (p: string) =>
			p === skillDir ? { isDirectory: () => true } : Promise.reject(new Error("nope")),
		)
		mockFileExists.mockResolvedValue(false) // SKILL.md 無し
		const sm = new SkillsManager(makeProvider())
		await sm.discoverSkills()
		expect(sm.getAllSkills()).toHaveLength(0)
	})

	it("skillName 未指定ならディレクトリ名を採用する（129 行の basename フォールバック）", async () => {
		// scanSkillsDirectory は常に entryName を渡すため、fallback は private 直呼びで検証する。
		const sm = new SkillsManager(makeProvider())
		const skillDir = "/anywhere/my-skill"
		mockFileExists.mockResolvedValue(true)
		mockReadFile.mockResolvedValue(`---\nname: my-skill\ndescription: d\n---\nbody`)
		await (sm as any).loadSkillMetadata(skillDir, "global", undefined, undefined)
		const s = sm.getAllSkills()
		expect(s).toHaveLength(1)
		expect(s[0].name).toBe("my-skill")
	})
})

describe("initialize / setupFileWatchers / watchDirectory", () => {
	const ORIGINAL_ENV = process.env.NODE_ENV

	afterEach(() => {
		process.env.NODE_ENV = ORIGINAL_ENV
	})

	it("test 環境以外では実際にウォッチャを張り、コールバックで再探索する（42-44, 660-721 行）", async () => {
		// setupFileWatchers/watchDirectory は NODE_ENV==="test" だと早期 return するため一時的に切り替える。
		process.env.NODE_ENV = "development"
		const sm = new SkillsManager(makeProvider())

		await sm.initialize()

		// 少なくとも1つのウォッチャが張られ、購読が登録されている
		expect(mockCreateWatcher).toHaveBeenCalled()
		expect(watcherSubs.change.length).toBeGreaterThan(0)

		const discoverSpy = vi.spyOn(sm, "discoverSkills")

		// 破棄前: onDidChange/Create/Delete のコールバックが discoverSkills を呼ぶ（705-718 行, isDisposed 偽側）
		await watcherSubs.change[0]({} as any)
		await watcherSubs.create[0]({} as any)
		await watcherSubs.delete[0]({} as any)
		expect(discoverSpy).toHaveBeenCalledTimes(3)

		// 破棄後: isDisposed 真側で早期 return（onDidChange/Create/Delete すべて 706/711/716 の真側）
		discoverSpy.mockClear()
		await sm.dispose()
		await watcherSubs.change[0]({} as any)
		await watcherSubs.create[0]({} as any)
		await watcherSubs.delete[0]({} as any)
		expect(discoverSpy).not.toHaveBeenCalled()
	})

	it("NODE_ENV=test では setupFileWatchers が早期 return する（660-662 行）", async () => {
		process.env.NODE_ENV = "test"
		const sm = new SkillsManager(makeProvider())
		await sm.initialize()
		expect(mockCreateWatcher).not.toHaveBeenCalled()
	})

	it("cwd が無ければウォッチャを張らずに return（665 行の真側）", async () => {
		process.env.NODE_ENV = "development"
		const sm = new SkillsManager(makeProvider({ cwd: "" }))
		await sm.initialize()
		expect(mockCreateWatcher).not.toHaveBeenCalled()
	})

	it("watchDirectory 単体も test 環境ガードで何もしない（698-700 行）", () => {
		process.env.NODE_ENV = "test"
		const sm = new SkillsManager(makeProvider())
		// setupFileWatchers は test 環境で watchDirectory へ到達しないため、防御ガードを直接叩く
		;(sm as any).watchDirectory("/some/dir")
		expect(mockCreateWatcher).not.toHaveBeenCalled()
	})
})
