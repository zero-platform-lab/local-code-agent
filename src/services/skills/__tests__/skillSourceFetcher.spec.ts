// npx vitest run services/skills/__tests__/skillSourceFetcher.spec.ts

import * as path from "path"

import * as os from "os"
import { promises as fsp } from "fs"

import { defaultDeps, fetchSkillSource, redactCredentials } from "../skillSourceFetcher"

const resolveEffectiveProxy = vi.hoisted(() => vi.fn())

vi.mock("../../../utils/proxyDispatcher", () => ({ resolveEffectiveProxy }))

const BASE = path.join("/home", "kurogane", ".agent", "skill-sources")
const TARGET = path.join(BASE, "gitlab.example.com", "platform", "skills")

type GitStub = {
	env: ReturnType<typeof vi.fn>
	pull: ReturnType<typeof vi.fn>
	clone: ReturnType<typeof vi.fn>
}

const makeDeps = (options: { existingRepo?: boolean } = {}) => {
	const git: GitStub = {
		env: vi.fn(),
		pull: vi.fn().mockResolvedValue(undefined),
		clone: vi.fn().mockResolvedValue(undefined),
	}
	const gitFactory = vi.fn().mockReturnValue(git)
	const ensureDirectory = vi.fn().mockResolvedValue(undefined)
	const directoryExists = vi.fn().mockResolvedValue(options.existingRepo ?? false)

	return { git, gitFactory, ensureDirectory, directoryExists, deps: { gitFactory, ensureDirectory, directoryExists } }
}

const configOf = (gitFactory: ReturnType<typeof vi.fn>) => gitFactory.mock.calls[0][0].config as string[]

describe("fetchSkillSource", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resolveEffectiveProxy.mockReturnValue({ url: undefined, source: "none" })
	})

	it("初回は clone し、URL から決めた場所へ置く（FR-EXT-05c1）", async () => {
		const { git, gitFactory, ensureDirectory, deps } = makeDeps()

		const result = await fetchSkillSource(
			{ url: "https://gitlab.example.com/platform/skills.git", baseDir: BASE },
			deps as never,
		)

		expect(result).toMatchObject({ ok: true, action: "cloned", directory: TARGET })
		expect(ensureDirectory).toHaveBeenCalledWith(path.dirname(TARGET))
		expect(git.clone).toHaveBeenCalledWith("https://gitlab.example.com/platform/skills.git", TARGET)
		expect(gitFactory.mock.calls[0][0].baseDir).toBe(path.dirname(TARGET))
	})

	it("2 回目は更新する。消して clone し直さない（FR-EXT-05d）", async () => {
		const { git, deps } = makeDeps({ existingRepo: true })

		const result = await fetchSkillSource(
			{ url: "https://gitlab.example.com/platform/skills", baseDir: BASE },
			deps as never,
		)

		expect(result).toMatchObject({ ok: true, action: "updated", directory: TARGET })
		expect(git.pull).toHaveBeenCalled()
		expect(git.clone).not.toHaveBeenCalled()
	})

	it("入力を待たせない環境変数を渡す（FR-EXT-06d）", async () => {
		const { git, deps } = makeDeps()

		await fetchSkillSource({ url: "https://host/a/b", baseDir: BASE }, deps as never)

		expect(git.env).toHaveBeenCalledWith(expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }))
	})

	it("解決した proxy を http.proxy として渡す（FR-NET-13a）", async () => {
		resolveEffectiveProxy.mockReturnValue({ url: "http://proxy:3128", source: "profile" })
		const { gitFactory, deps } = makeDeps()

		await fetchSkillSource(
			{ url: "https://host/a/b", baseDir: BASE, proxy: { mode: "custom", url: "http://proxy:3128" } },
			deps as never,
		)

		expect(configOf(gitFactory)).toEqual(["http.proxy=http://proxy:3128"])
	})

	it("SOCKS は proxy 側で名前を解決する形へ書き換えて渡す（FR-EXT-05b2）", async () => {
		resolveEffectiveProxy.mockReturnValue({ url: "socks5://proxy:1080", source: "profile" })
		const { gitFactory, deps } = makeDeps()

		await fetchSkillSource({ url: "https://host/a/b", baseDir: BASE }, deps as never)

		expect(configOf(gitFactory)).toEqual(["http.proxy=socks5h://proxy:1080"])
	})

	it("SSH の取得元には proxy を渡さず、無視されたことを返す（FR-EXT-05b3）", async () => {
		resolveEffectiveProxy.mockReturnValue({ url: "socks5://proxy:1080", source: "profile" })
		const { gitFactory, deps } = makeDeps()

		const result = await fetchSkillSource({ url: "git@host:a/b.git", baseDir: BASE }, deps as never)

		expect(result).toMatchObject({ ok: true, proxyIgnored: true })
		expect(configOf(gitFactory)).toEqual([])
	})

	it("受け付けない URL は git を起動せずに拒む（FR-EXT-05c2）", async () => {
		const { gitFactory, deps } = makeDeps()

		const result = await fetchSkillSource({ url: "https://host/a/../../etc", baseDir: BASE }, deps as never)

		expect(result).toMatchObject({ ok: false })
		expect(gitFactory).not.toHaveBeenCalled()
	})

	it("git が失敗したら、資格情報を落としたうえで理由を返す", async () => {
		const { git, deps } = makeDeps()
		git.clone.mockRejectedValue(new Error("fatal: unable to access 'https://user:token@host/a/b/'"))

		const result = await fetchSkillSource({ url: "https://host/a/b", baseDir: BASE }, deps as never)

		expect(result).toMatchObject({ ok: false })
		if (result.ok) throw new Error("失敗するはず")
		expect(result.error).not.toContain("token")
		expect(result.error).toContain("<伏せた>@host")
	})

	it("Error でないものが投げられても理由を返す", async () => {
		const { git, deps } = makeDeps()
		git.clone.mockRejectedValue("こわれた")

		const result = await fetchSkillSource({ url: "https://host/a/b", baseDir: BASE }, deps as never)

		expect(result).toEqual({ ok: false, error: "こわれた" })
	})
})

describe("redactCredentials", () => {
	it("URL に埋まった資格情報を落とす", () => {
		expect(redactCredentials("https://user:token@host/a")).toBe("https://<伏せた>@host/a")
	})

	it("複数あっても全部落とす", () => {
		expect(redactCredentials("https://a:b@h1/ and ssh://c:d@h2/")).toBe(
			"https://<伏せた>@h1/ and ssh://<伏せた>@h2/",
		)
	})

	it("資格情報が無ければ変えない", () => {
		expect(redactCredentials("fatal: repository not found")).toBe("fatal: repository not found")
	})
})

describe("defaultDeps（実ファイルを触る部分）", () => {
	let root: string

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "skill-source-"))
	})

	afterEach(async () => {
		await fsp.rm(root, { recursive: true, force: true })
	})

	it("directoryExists はディレクトリに真を返す", async () => {
		await expect(defaultDeps.directoryExists(root)).resolves.toBe(true)
	})

	it("directoryExists は無いパスに偽を返す", async () => {
		await expect(defaultDeps.directoryExists(path.join(root, "nope"))).resolves.toBe(false)
	})

	it("directoryExists はファイルに偽を返す。`.git` がファイルのときに更新扱いしない", async () => {
		const file = path.join(root, "a-file")
		await fsp.writeFile(file, "x")

		await expect(defaultDeps.directoryExists(file)).resolves.toBe(false)
	})

	it("ensureDirectory は入れ子ごと作る", async () => {
		const nested = path.join(root, "a", "b", "c")

		await defaultDeps.ensureDirectory(nested)

		await expect(defaultDeps.directoryExists(nested)).resolves.toBe(true)
	})

	it("ensureDirectory は既にあっても失敗しない", async () => {
		await expect(defaultDeps.ensureDirectory(root)).resolves.toBeUndefined()
	})
})
