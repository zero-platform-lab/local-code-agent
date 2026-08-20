// npx vitest run src/services/glob/__tests__/list-files-fs-fallback.spec.ts
//
// ripgrep が見つからない環境（rg 未同梱の VS Code 等）で、listFiles が fs 走査に
// fallback してファイル一覧を返すこと（＝環境情報が空にならないこと）を検証する。

import * as path from "path"
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"
import ignore from "ignore"

const { getBinPathMock } = vi.hoisted(() => ({ getBinPathMock: vi.fn() }))

vi.mock("vscode", () => ({ env: { appRoot: "/mock/app/root" } }))
vi.mock("child_process")
vi.mock("../../ripgrep", () => ({ getBinPath: getBinPathMock }))
vi.mock("fs", () => ({
	promises: {
		readdir: vi.fn(),
		readFile: vi.fn().mockResolvedValue(""),
		access: vi.fn().mockRejectedValue(new Error("not found")),
	},
}))

import * as fs from "fs"
import { listFiles, listFilesWithFs } from "../list-files"

const ent = (name: string, kind: "file" | "dir" | "link") => ({
	name,
	isFile: () => kind === "file",
	isDirectory: () => kind === "dir",
	isSymbolicLink: () => kind === "link",
})

beforeEach(() => {
	vi.clearAllMocks()
	;(fs.promises.readFile as Mock).mockResolvedValue("")
	;(fs.promises.access as Mock).mockRejectedValue(new Error("not found"))
})

describe("listFilesWithFs (ripgrep 不在時の fs 走査)", () => {
	it("再帰: node_modules/.git/hidden/symlink/ignore を除外して絶対パスのファイルを返す", async () => {
		const root = "/repo"
		;(fs.promises.readdir as Mock).mockImplementation(async (p: string) => {
			if (p === root) {
				return [
					ent("a.ts", "file"),
					ent(".gitignore", "file"), // ignoreInstance が常に無視
					ent("secret.env", "file"), // 下の ignore パターンで無視
					ent("src", "dir"),
					ent("node_modules", "dir"), // DIRS_TO_IGNORE で降りない
					ent(".hidden", "dir"), // hidden dir は降りない
					ent("nogo", "dir"), // ignore パターンで降りない
					ent("mylink", "link"), // symlink は辿らない
					ent("bad", "dir"), // 読めない → skip
				]
			}
			if (p === path.join(root, "src")) return [ent("b.ts", "file")]
			if (p === path.join(root, "bad")) throw new Error("EACCES")
			return []
		})
		const ig = ignore().add(".gitignore\nsecret.env\nnogo/")

		const files = await listFilesWithFs(root, true, 1000, ig)

		expect(files).toContain(path.join(root, "a.ts"))
		expect(files).toContain(path.join(root, "src", "b.ts"))
		expect(files).not.toContain(path.join(root, ".gitignore"))
		expect(files).not.toContain(path.join(root, "secret.env"))
		expect(files.some((f) => f.includes("node_modules"))).toBe(false)
		expect(files.some((f) => f.includes(".hidden"))).toBe(false)
		expect(files.some((f) => f.includes("nogo"))).toBe(false)
		expect(files.some((f) => f.includes("mylink"))).toBe(false)
	})

	it("非再帰: トップレベルのファイルのみ（ディレクトリに降りない）", async () => {
		const root = "/repo"
		;(fs.promises.readdir as Mock).mockImplementation(async (p: string) => {
			if (p === root) return [ent("a.ts", "file"), ent("src", "dir")]
			return [ent("should-not-appear.ts", "file")]
		})

		const files = await listFilesWithFs(root, false, 1000, ignore())

		expect(files).toEqual([path.join(root, "a.ts")])
	})

	it("limit で打ち切る", async () => {
		const root = "/repo"
		;(fs.promises.readdir as Mock).mockImplementation(async (p: string) => {
			if (p === root) return [ent("a.ts", "file"), ent("b.ts", "file"), ent("c.ts", "file")]
			return []
		})

		const files = await listFilesWithFs(root, true, 2, ignore())

		expect(files).toHaveLength(2)
	})
})

describe("listFiles: ripgrep 不在なら fs にフォールバック", () => {
	it("getBinPath が undefined のとき ripgrep を spawn せず fs でファイルを返す", async () => {
		getBinPathMock.mockResolvedValue(undefined)
		const childProcess = await import("child_process")
		const root = "/repo"
		;(fs.promises.readdir as Mock).mockImplementation(async (p: string) => {
			if (path.resolve(p) === path.resolve(root)) return [ent("a.ts", "file")]
			return []
		})

		const [files] = await listFiles(root, true, 100)

		expect(files.some((f) => f.endsWith("a.ts"))).toBe(true)
		expect(childProcess.spawn).not.toHaveBeenCalled()
	})
})
