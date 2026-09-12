// npx vitest run services/skills/__tests__/skillSourceDiscovery.spec.ts

import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"

import { defaultDiscoveryDeps, findSkillSourceRoots } from "../skillSourceDiscovery"

/** `{ "a/b": [".git", "skill"] }` の形で木を与える。 */
const treeDeps = (tree: Record<string, string[]>) => ({
	readDirectory: async (dirPath: string) => tree[dirPath] ?? [],
	isDirectory: async (dirPath: string) => dirPath in tree,
})

const BASE = path.join("/base")
const j = (...parts: string[]) => path.join(BASE, ...parts)

describe("findSkillSourceRoots", () => {
	it("`.git` を持つディレクトリを取得元の根として返す", async () => {
		const deps = treeDeps({
			[BASE]: ["gitlab.example.com"],
			[j("gitlab.example.com")]: ["platform"],
			[j("gitlab.example.com", "platform")]: ["skills"],
			[j("gitlab.example.com", "platform", "skills")]: [".git", "kubernetes-review"],
		})

		await expect(findSkillSourceRoots(BASE, deps)).resolves.toEqual([j("gitlab.example.com", "platform", "skills")])
	})

	it("複数の取得元を集める", async () => {
		const deps = treeDeps({
			[BASE]: ["host-a", "host-b"],
			[j("host-a")]: ["one"],
			[j("host-a", "one")]: [".git"],
			[j("host-b")]: ["two"],
			[j("host-b", "two")]: [".git"],
		})

		await expect(findSkillSourceRoots(BASE, deps)).resolves.toEqual([j("host-a", "one"), j("host-b", "two")])
	})

	it("根が見つかったら、その中へは降りない", async () => {
		const deps = treeDeps({
			[BASE]: ["host"],
			[j("host")]: ["repo"],
			[j("host", "repo")]: [".git", "nested"],
			[j("host", "repo", "nested")]: [".git"],
		})

		await expect(findSkillSourceRoots(BASE, deps)).resolves.toEqual([j("host", "repo")])
	})

	it("深すぎる木は途中で止める", async () => {
		const deep: Record<string, string[]> = { [BASE]: ["a"] }
		let current = j("a")
		for (let i = 0; i < 10; i++) {
			deep[current] = ["a"]
			current = path.join(current, "a")
		}
		deep[current] = [".git"]

		await expect(findSkillSourceRoots(BASE, deep && treeDeps(deep))).resolves.toEqual([])
	})

	it("並び順をそろえる。実行のたびに優先が揺れない", async () => {
		const deps = treeDeps({
			[BASE]: ["z-host", "a-host"],
			[j("z-host")]: [".git"],
			[j("a-host")]: [".git"],
		})

		await expect(findSkillSourceRoots(BASE, deps)).resolves.toEqual([j("a-host"), j("z-host")])
	})

	it("何も無ければ空を返す", async () => {
		await expect(findSkillSourceRoots(BASE, treeDeps({}))).resolves.toEqual([])
	})

	it("ファイルは降りる対象にしない", async () => {
		const deps = {
			readDirectory: async (dirPath: string) => (dirPath === BASE ? ["a-file"] : []),
			isDirectory: async () => false,
		}

		await expect(findSkillSourceRoots(BASE, deps)).resolves.toEqual([])
	})
})

describe("defaultDiscoveryDeps（実ファイルを触る部分）", () => {
	let root: string

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-discovery-"))
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("実物の木から取得元を見つける", async () => {
		const repo = path.join(root, "gitlab.example.com", "platform", "skills")
		await fs.mkdir(path.join(repo, ".git"), { recursive: true })

		await expect(findSkillSourceRoots(root)).resolves.toEqual([repo])
	})

	it("readDirectory は読めないパスに空を返す", async () => {
		await expect(defaultDiscoveryDeps.readDirectory(path.join(root, "nope"))).resolves.toEqual([])
	})

	it("isDirectory は無いパスに偽を返す", async () => {
		await expect(defaultDiscoveryDeps.isDirectory(path.join(root, "nope"))).resolves.toBe(false)
	})

	it("isDirectory はファイルに偽を返す", async () => {
		const file = path.join(root, "a-file")
		await fs.writeFile(file, "x")

		await expect(defaultDiscoveryDeps.isDirectory(file)).resolves.toBe(false)
	})
})
