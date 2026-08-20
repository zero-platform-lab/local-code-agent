import path from "path"
import fs from "fs/promises"

import { getCommand, getCommands, getCommandNames, getCommandNameFromFile, isMarkdownFile } from "../commands"

// commands.ts の未到達分岐（getCommands/getCommandNames 経路、tryLoadCommand の各早期 return、
// scanCommandDirectory の非ディレクトリ/catch/mode 解析、シンボリックリンクの深さ上限）を、
// 実 FS を使わず検証する。fs / agent ディレクトリ / built-in はすべてモック。
vi.mock("fs/promises", () => ({
	default: {
		stat: vi.fn(),
		readdir: vi.fn(),
		readFile: vi.fn(),
		lstat: vi.fn(),
		readlink: vi.fn(),
	},
}))

const GLOBAL_AGENT = "/mock/global/.agent"
const PROJECT_AGENT = "/mock/project/.agent"
vi.mock("../../agent-config", () => ({
	getGlobalAgentDirectory: vi.fn(() => GLOBAL_AGENT),
	getProjectAgentDirectoryForCwd: vi.fn(() => PROJECT_AGENT),
}))

const { mockGetBuiltInCommands, mockGetBuiltInCommand } = vi.hoisted(() => ({
	mockGetBuiltInCommands: vi.fn(),
	mockGetBuiltInCommand: vi.fn(),
}))
vi.mock("../built-in-commands", () => ({
	getBuiltInCommands: mockGetBuiltInCommands,
	getBuiltInCommand: mockGetBuiltInCommand,
	getBuiltInCommandNames: vi.fn(() => Promise.resolve([])),
}))

const mockFs = vi.mocked(fs)
const GLOBAL_COMMANDS = path.join(GLOBAL_AGENT, "commands")
const PROJECT_COMMANDS = path.join(PROJECT_AGENT, "commands")

const isDir = (v: boolean) => ({ isDirectory: () => v }) as any

beforeEach(() => {
	vi.clearAllMocks()
	mockGetBuiltInCommands.mockResolvedValue([])
	mockGetBuiltInCommand.mockResolvedValue(undefined)
})

describe("純関数の分岐", () => {
	it("getCommandNameFromFile は .md のみ剥がす（361-363 行）", () => {
		expect(getCommandNameFromFile("deploy.md")).toBe("deploy")
		expect(getCommandNameFromFile("deploy.MD")).toBe("deploy")
		// .md 以外はそのまま（361 の偽側 → 362-363 行）
		expect(getCommandNameFromFile("notes.txt")).toBe("notes.txt")
		expect(getCommandNameFromFile("Makefile")).toBe("Makefile")
	})

	it("isMarkdownFile", () => {
		expect(isMarkdownFile("a.md")).toBe(true)
		expect(isMarkdownFile("a.txt")).toBe(false)
	})
})

describe("getCommands / getCommandNames", () => {
	it("built-in を土台に global の mode 付きコマンドを取り込む（127-129, 322-323 行）", async () => {
		mockGetBuiltInCommands.mockResolvedValue([{ name: "help", content: "h", source: "built-in", filePath: "" }])
		// global commands はディレクトリ。deploy.md（mode 付き frontmatter）を1件持つ。
		mockFs.stat.mockImplementation(async (p: any) => {
			if (String(p) === GLOBAL_COMMANDS) return isDir(true)
			return isDir(false) // project は非ディレクトリ（279-281 行）
		})
		mockFs.readdir.mockImplementation(async (p: any) => {
			if (String(p) === GLOBAL_COMMANDS) {
				return [
					{
						name: "deploy.md",
						isFile: () => true,
						isSymbolicLink: () => false,
						parentPath: GLOBAL_COMMANDS,
					},
				] as any
			}
			return [] as any
		})
		mockFs.readFile.mockResolvedValue("---\nmode: code\ndescription: Deploy\n---\nrun deploy")

		const commands = await getCommands("/workspace")
		const names = commands.map((c) => c.name).sort()
		expect(names).toContain("help")
		expect(names).toContain("deploy")
		const deploy = commands.find((c) => c.name === "deploy")!
		expect(deploy.mode).toBe("code")
		expect(deploy.source).toBe("global")
	})

	it("getCommandNames は getCommands の名前配列を返す（265-267 行）", async () => {
		mockGetBuiltInCommands.mockResolvedValue([{ name: "help", content: "h", source: "built-in", filePath: "" }])
		mockFs.stat.mockResolvedValue(isDir(false)) // どのディレクトリも無い
		const names = await getCommandNames("/workspace")
		expect(names).toEqual(["help"])
	})

	it("scanCommandDirectory は stat が投げても握りつぶす（350-352 行）", async () => {
		mockFs.stat.mockRejectedValue(new Error("EACCES"))
		const commands = await getCommands("/workspace")
		// built-in 空 + どちらのディレクトリも読めない → 空
		expect(commands).toEqual([])
	})
})

describe("tryLoadCommand（getCommand 経由）の早期 return", () => {
	it("ディレクトリでなければ undefined（177-179 行）", async () => {
		mockFs.stat.mockResolvedValue(isDir(false))
		const result = await getCommand("/workspace", "deploy")
		expect(result).toBeUndefined()
	})

	it("stat が投げたら outer catch で undefined（255-258 行）", async () => {
		mockFs.stat.mockRejectedValue(new Error("boom"))
		const result = await getCommand("/workspace", "deploy")
		expect(result).toBeUndefined()
	})

	it("内容が空文字なら undefined（215-217 行）", async () => {
		mockFs.stat.mockResolvedValue(isDir(true))
		mockFs.readFile.mockResolvedValue("") // 空 → !content
		const result = await getCommand("/workspace", "deploy")
		expect(result).toBeUndefined()
	})

	it("シンボリックリンク先が読めない場合は undefined（206-209 行）", async () => {
		mockFs.stat.mockImplementation(async (p: any) => {
			// commands ディレクトリは存在。symlink 先ファイルの stat は isFile:true。
			if (String(p) === PROJECT_COMMANDS || String(p) === GLOBAL_COMMANDS) return isDir(true)
			return { isFile: () => true } as any
		})
		// 直接 readFile は失敗させ、symlink 解決へ倒す
		mockFs.readFile.mockRejectedValue(new Error("ENOENT"))
		mockFs.lstat.mockResolvedValue({ isSymbolicLink: () => true } as any)
		mockFs.readlink.mockResolvedValue("/elsewhere/target.md")
		const result = await getCommand("/workspace", "deploy")
		expect(result).toBeUndefined()
	})
})

describe("scanCommandDirectory: シンボリックリンクの深さ上限", () => {
	it("depth が MAX_DEPTH を超えると resolveCommandDirectoryEntry は打ち切る（77-79 行）", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		// global commands ディレクトリだけ存在。中身は常に「ディレクトリを指す symlink」1件で、
		// 無限に潜れるが depth ガードで必ず打ち切られる。
		mockFs.stat.mockImplementation(async (p: any) => {
			if (String(p) === GLOBAL_COMMANDS) return isDir(true)
			return isDir(false)
		})
		mockFs.readdir.mockResolvedValue([
			{ name: "link", isFile: () => false, isSymbolicLink: () => true, parentPath: GLOBAL_COMMANDS },
		] as any)
		mockFs.readlink.mockResolvedValue("nested")
		// symlink 先は常にディレクトリ（さらに symlink を含む）
		mockFs.lstat.mockResolvedValue({
			isFile: () => false,
			isDirectory: () => true,
			isSymbolicLink: () => false,
		} as any)

		const commands = await getCommands("/workspace")
		// 深さ上限で安全に止まり、有効な .md は1件も無いので空。無限ループにならないことが要点。
		expect(commands).toEqual([])
	})
})
