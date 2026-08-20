// npx vitest run core/prompts/sections/__tests__/custom-instructions-coverage.spec.ts
//
// custom-instructions.ts の防御分岐（深い再帰ガード・壊れた symlink・サブフォルダ規則・
// rooIgnore 指示）を狙って埋めるための補完テスト。
// fs/promises と agent-config をモックし、path は本物を使う。

import * as path from "path"

const {
	mockStat,
	mockReadFile,
	mockReaddir,
	mockReadlink,
	mockLstat,
	mockGetAgentDirectoriesForCwd,
	mockGetAllAgentDirectoriesForCwd,
	mockGetAgentsDirectoriesForCwd,
} = vi.hoisted(() => ({
	mockStat: vi.fn(),
	mockReadFile: vi.fn(),
	mockReaddir: vi.fn(),
	mockReadlink: vi.fn(),
	mockLstat: vi.fn(),
	mockGetAgentDirectoriesForCwd: vi.fn(),
	mockGetAllAgentDirectoriesForCwd: vi.fn(),
	mockGetAgentsDirectoriesForCwd: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	default: {
		stat: mockStat,
		readFile: mockReadFile,
		readdir: mockReaddir,
		readlink: mockReadlink,
		lstat: mockLstat,
	},
}))

vi.mock("../../../../services/agent-config", () => ({
	getAgentDirectoriesForCwd: mockGetAgentDirectoriesForCwd,
	getAllAgentDirectoriesForCwd: mockGetAllAgentDirectoriesForCwd,
	getAgentsDirectoriesForCwd: mockGetAgentsDirectoriesForCwd,
}))

import { loadRuleFiles, addCustomInstructions } from "../custom-instructions"

const CWD = "/mock/project"
const PROJECT_AGENT = path.join(CWD, ".agent")

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" })
const eperm = () => Object.assign(new Error("EPERM"), { code: "EPERM" })

beforeEach(() => {
	vi.clearAllMocks()
	// 既定: 何も存在しない
	mockStat.mockRejectedValue(enoent())
	mockReadFile.mockRejectedValue(enoent())
	mockReaddir.mockResolvedValue([])
	mockReadlink.mockRejectedValue(enoent())
	mockLstat.mockRejectedValue(enoent())
	mockGetAgentDirectoriesForCwd.mockReturnValue([PROJECT_AGENT])
	mockGetAllAgentDirectoriesForCwd.mockResolvedValue([PROJECT_AGENT])
	mockGetAgentsDirectoriesForCwd.mockResolvedValue([CWD])
})

describe("loadRuleFiles サブフォルダ規則", () => {
	it("enableSubfolderRules=true では getAllAgentDirectoriesForCwd を使う", async () => {
		await loadRuleFiles(CWD, true)
		expect(mockGetAllAgentDirectoriesForCwd).toHaveBeenCalledWith(CWD)
		expect(mockGetAgentDirectoriesForCwd).not.toHaveBeenCalled()
	})
})

describe("readTextFilesFromDirectory の防御分岐", () => {
	it("ファイル stat が失敗したエントリは無視する（null 化）", async () => {
		const rulesDir = path.join(PROJECT_AGENT, "rules")
		mockStat.mockImplementation((p: string) => {
			if (p === rulesDir) {
				return Promise.resolve({ isDirectory: () => true } as any)
			}
			// ファイルの stat は失敗させる → map 内 catch → null
			return Promise.reject(new Error("stat boom"))
		})
		mockReaddir.mockResolvedValueOnce([
			{ name: "a.md", isFile: () => true, isSymbolicLink: () => false, parentPath: rulesDir } as any,
		])
		// フォールバック .agentrules も無し
		const result = await loadRuleFiles(CWD)
		expect(result).toBe("")
	})

	it("stat 成功でもディレクトリ（isFile=false）だったエントリは無視する", async () => {
		const rulesDir = path.join(PROJECT_AGENT, "rules")
		const fileEntry = path.join(rulesDir, "x.md")
		mockStat.mockImplementation((p: string) => {
			if (p === rulesDir) return Promise.resolve({ isDirectory: () => true } as any)
			// readdir 時点ではファイル扱いだが、再 stat ではディレクトリ（isFile=false）
			if (p === fileEntry) return Promise.resolve({ isFile: () => false } as any)
			return Promise.reject(enoent())
		})
		mockReaddir.mockResolvedValueOnce([
			{ name: "x.md", isFile: () => true, isSymbolicLink: () => false, parentPath: rulesDir } as any,
		])

		const result = await loadRuleFiles(CWD)
		expect(result).toBe("")
	})

	it("壊れた symlink（readlink 失敗）はスキップする", async () => {
		const rulesDir = path.join(PROJECT_AGENT, "rules")
		mockStat.mockImplementation((p: string) => {
			if (p === rulesDir) return Promise.resolve({ isDirectory: () => true } as any)
			return Promise.reject(enoent())
		})
		mockReaddir.mockResolvedValueOnce([
			{ name: "link", isFile: () => false, isSymbolicLink: () => true, parentPath: rulesDir } as any,
		])
		mockReadlink.mockRejectedValue(new Error("readlink boom"))

		const result = await loadRuleFiles(CWD)
		expect(result).toBe("")
	})

	it("循環 symlink→ディレクトリでも深さ上限で停止する（resolveDirectoryEntry の depth ガード）", async () => {
		const rulesDir = path.join(PROJECT_AGENT, "rules")
		// rulesDir はディレクトリ、その他の解決先も全てディレクトリ扱い
		mockStat.mockResolvedValue({
			isFile: () => false,
			isDirectory: () => true,
			isSymbolicLink: () => false,
		} as any)
		// どのディレクトリを readdir しても symlink エントリを返し続ける（循環）
		mockReaddir.mockResolvedValue([
			{ name: "loop", isFile: () => false, isSymbolicLink: () => true, parentPath: rulesDir } as any,
		])
		mockReadlink.mockResolvedValue("loop-target")

		// 深さ上限で停止し、例外なく空を返す
		await expect(loadRuleFiles(CWD)).resolves.toBe("")
	})

	it("循環 symlink→symlink でも深さ上限で停止する（resolveSymLink の depth ガード）", async () => {
		const rulesDir = path.join(PROJECT_AGENT, "rules")
		mockStat.mockImplementation((p: string) => {
			if (p === rulesDir) {
				return Promise.resolve({
					isFile: () => false,
					isDirectory: () => true,
					isSymbolicLink: () => false,
				} as any)
			}
			// 解決先は常に symlink → resolveSymLink が再帰
			return Promise.resolve({
				isFile: () => false,
				isDirectory: () => false,
				isSymbolicLink: () => true,
			} as any)
		})
		mockReaddir.mockResolvedValueOnce([
			{ name: "link", isFile: () => false, isSymbolicLink: () => true, parentPath: rulesDir } as any,
		])
		mockReadlink.mockResolvedValue("next")

		await expect(loadRuleFiles(CWD)).resolves.toBe("")
	})
})

describe("addCustomInstructions: AGENTS.md サブフォルダとエラー処理", () => {
	it("サブフォルダの AGENTS.md / AGENTS.local.md はパス付きヘッダで読み込む", async () => {
		const subdir = path.join(CWD, "packages", "app")
		mockGetAgentsDirectoriesForCwd.mockResolvedValue([CWD, subdir])

		mockLstat.mockImplementation((p: string) => {
			const s = p.toString()
			if (s.includes(subdir) && (s.endsWith("AGENTS.md") || s.endsWith("AGENTS.local.md"))) {
				return Promise.resolve({ isSymbolicLink: () => false } as any)
			}
			return Promise.reject(enoent())
		})
		mockReadFile.mockImplementation((p: string) => {
			const s = p.toString()
			if (s.includes(subdir) && s.endsWith("AGENTS.local.md")) return Promise.resolve("sub local rules")
			if (s.includes(subdir) && s.endsWith("AGENTS.md")) return Promise.resolve("sub standard rules")
			return Promise.reject(enoent())
		})

		const result = await addCustomInstructions("", "", CWD, "code", {
			settings: {
				todoListEnabled: true,
				useAgentRules: true,
				newTaskRequireTodos: false,
				enableSubfolderRules: true,
			},
		})

		// enableSubfolderRules=true 経路で getAll/getAgents を使う
		expect(mockGetAllAgentDirectoriesForCwd).toHaveBeenCalled()
		expect(mockGetAgentsDirectoriesForCwd).toHaveBeenCalledWith(CWD)
		// サブディレクトリはパス付きヘッダ
		const relSub = path.relative(CWD, subdir)
		expect(result).toContain(`# Agent Rules Standard (AGENTS.md) from ${relSub}:`)
		expect(result).toContain("sub standard rules")
		expect(result).toContain(`# Agent Rules Local (AGENTS.local.md) from ${relSub}:`)
		expect(result).toContain("sub local rules")
	})

	it("AGENTS.md / AGENTS.local.md 読み込みが EPERM で失敗しても握りつぶす", async () => {
		mockLstat.mockImplementation((p: string) => {
			const s = p.toString()
			if (s.endsWith("AGENTS.md") || s.endsWith("AGENTS.local.md")) {
				return Promise.resolve({ isSymbolicLink: () => false } as any)
			}
			return Promise.reject(enoent())
		})
		mockReadFile.mockImplementation((p: string) => {
			const s = p.toString()
			// AGENTS 系だけ EPERM を投げ、readAgentRulesFile 外へ伝播 → ループの catch で握りつぶし
			if (s.endsWith("AGENTS.md") || s.endsWith("AGENTS.local.md")) return Promise.reject(eperm())
			return Promise.reject(enoent())
		})

		const result = await addCustomInstructions("global", "", CWD, "code", {
			settings: { todoListEnabled: true, useAgentRules: true, newTaskRequireTodos: false },
		})

		// 例外を投げず、AGENTS 内容は含まれない
		expect(typeof result).toBe("string")
		expect(result).not.toContain("Agent Rules Standard")
	})

	it("rooIgnoreInstructions は Rules セクションに追加される", async () => {
		const result = await addCustomInstructions("", "", CWD, "code", {
			rooIgnoreInstructions: "DO NOT READ secrets/**",
			settings: { todoListEnabled: true, useAgentRules: false, newTaskRequireTodos: false },
		})
		expect(result).toContain("DO NOT READ secrets/**")
	})
})
