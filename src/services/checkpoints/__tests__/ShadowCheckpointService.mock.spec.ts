// 全モックの単体テスト。実 git は一切起動しない。
// simple-git / fs / ripgrep / i18n / excludes / p-wait-for をすべてモックし、
// 実行される git コマンドの引数を全件アサートする。特に「本体ワークスペースへ
// 破壊的 git（reset --hard / clean / checkout）が意図せず飛ばない」ことと
// 「復元対象が shadow リポジトリ範囲に収まる」ことを不変条件として検証する。
//
// npx vitest run src/services/checkpoints/__tests__/ShadowCheckpointService.mock.spec.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import os from "os"
import path from "path"

import { RepoPerTaskCheckpointService } from "../RepoPerTaskCheckpointService"
import { ShadowCheckpointService } from "../ShadowCheckpointService"

// ---------------------------------------------------------------------------
// simple-git モック本体。
// 生成されたインスタンスごとに { baseDir, calls[] } を記録し、
// メソッドの戻り値/例外は gitEnv.config から動的に解決する（生成後にテストが
// config を差し替えられるよう、呼び出し時に評価する）。
// ---------------------------------------------------------------------------
const gitEnv = vi.hoisted(() => {
	type Call = { method: string; args: unknown[] }
	type Instance = { baseDir: string | undefined; calls: Call[] }
	const state: {
		instances: Instance[]
		config: Record<string, any>
	} = {
		instances: [],
		config: {},
	}
	return state
})

vi.mock("simple-git", () => {
	const makeGit = (options: any) => {
		const inst: { baseDir: string | undefined; calls: Array<{ method: string; args: unknown[] }> } = {
			baseDir: options?.baseDir,
			calls: [],
		}
		gitEnv.instances.push(inst)

		const rec =
			(method: string) =>
			(...args: unknown[]) => {
				inst.calls.push({ method, args })
				const c = gitEnv.config

				// メソッド単位の明示的な reject 指定（エラー分岐用）。
				if (c.reject && Object.prototype.hasOwnProperty.call(c.reject, method)) {
					return Promise.reject(c.reject[method])
				}

				switch (method) {
					case "version":
						return Promise.resolve(c.version ?? "git version 2.43.0")
					case "commit":
						return Promise.resolve({ commit: c.commitHash ?? "newcommithash" })
					case "raw": {
						const a = (args[0] as unknown[]) ?? []
						if (Array.isArray(a) && a.includes("rev-list")) {
							return Promise.resolve(`${c.revListHash ?? "roothash"}\n`)
						}
						return Promise.resolve(c.rawResult ?? "")
					}
					case "revparse": {
						const a = (args[0] as unknown[]) ?? []
						if (Array.isArray(a) && a.includes("--abbrev-ref")) {
							return Promise.resolve(c.currentBranch ?? "main")
						}
						return Promise.resolve(c.headHash ?? "headhash")
					}
					case "diffSummary":
						return Promise.resolve({ files: c.diffFiles ?? [] })
					case "show":
						if (c.showReject) {
							return Promise.reject(new Error("show failed"))
						}
						return Promise.resolve(c.showContent ?? "BEFORE")
					case "getConfig":
						if (c.getConfigReject) {
							return Promise.reject(c.getConfigReject)
						}
						return Promise.resolve({ value: c.getConfigValue ?? "" })
					case "branchLocal":
						return Promise.resolve({ all: c.branchAll ?? [] })
					default:
						return Promise.resolve(undefined)
				}
			}

		const git: any = {
			version: rec("version"),
			init: rec("init"),
			addConfig: rec("addConfig"),
			add: rec("add"),
			commit: rec("commit"),
			clean: rec("clean"),
			reset: rec("reset"),
			raw: rec("raw"),
			revparse: rec("revparse"),
			diffSummary: rec("diffSummary"),
			show: rec("show"),
			getConfig: rec("getConfig"),
			branchLocal: rec("branchLocal"),
			branch: rec("branch"),
			checkout: rec("checkout"),
		}
		// env はチェーン可能（createSanitizedGit が git.env(...) を呼ぶ）。
		git.env = (...a: unknown[]) => {
			inst.calls.push({ method: "env", args: a })
			return git
		}
		return git
	}

	const simpleGit = vi.fn((options: any) => makeGit(options))
	return { default: simpleGit, simpleGit }
})

// fs/promises は全メソッドをモック。getDiff の readFile 分岐のみ戻り値を差し替える。
vi.mock("fs/promises", () => ({
	default: {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("AFTER"),
	},
}))

// fileExistsAtPath は dotGit の存在有無を制御（既存 repo / 新規 repo の分岐）。
vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn(async () => !!gitEnv.config.dotGitExists),
}))

// getExcludePatterns は固定配列（excludes.ts 内部の fs アクセスを回避）。
vi.mock("../excludes", () => ({
	getExcludePatterns: vi.fn(async () => [".git/", "*.log"]),
}))

// ripgrep（ネスト git 検出）。デフォルトは「無し」。
vi.mock("../../../services/search/file-search", () => ({
	executeRipgrep: vi.fn(async () => gitEnv.config.ripgrep ?? []),
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key)),
}))

// p-wait-for は条件関数を一度だけ実行して解決する（deleteBranch の待機分岐用）。
vi.mock("p-wait-for", () => ({
	default: vi.fn(async (cond: () => unknown | Promise<unknown>) => {
		await cond()
	}),
}))

import fsPromises from "fs/promises"
import * as fileSearch from "../../../services/search/file-search"
import simpleGitDefault from "simple-git"

const fs = fsPromises as unknown as {
	mkdir: ReturnType<typeof vi.fn>
	writeFile: ReturnType<typeof vi.fn>
	readFile: ReturnType<typeof vi.fn>
}

const TASK_ID = "task-abc"
const GLOBAL_STORAGE = "/global/storage"
const WORKSPACE = "/home/user/project"
// RepoPerTaskCheckpointService.create と同じ規則で算出した shadow ディレクトリ。
const SHADOW_DIR = path.join(GLOBAL_STORAGE, "tasks", TASK_ID, "checkpoints")

const makeService = (opts?: { workspaceDir?: string; checkpointsDir?: string; taskId?: string }) =>
	new RepoPerTaskCheckpointService(
		opts?.taskId ?? TASK_ID,
		opts?.checkpointsDir ?? SHADOW_DIR,
		opts?.workspaceDir ?? WORKSPACE,
		() => {},
	)

// 直近に生成された git インスタンス（= createSanitizedGit の結果）。
const lastGit = () => gitEnv.instances[gitEnv.instances.length - 1]
const methodsOf = (inst: { calls: Array<{ method: string; args: unknown[] }> }) => inst.calls.map((c) => c.method)
const callArgs = (inst: { calls: Array<{ method: string; args: unknown[] }> }, method: string) =>
	inst.calls.filter((c) => c.method === method).map((c) => c.args)

beforeEach(() => {
	gitEnv.instances = []
	gitEnv.config = {}
	vi.clearAllMocks()
	fs.readFile.mockResolvedValue("AFTER")
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("createSanitizedGit (env サニタイズ)", () => {
	it("git 系 env を除去し undefined 値をスキップして simpleGit を生成する", async () => {
		const original = process.env
		const crafted: Record<string, unknown> = { NORMAL_VAR: "1", GIT_DIR: "/should/strip", GIT_EDITOR: "vim" }
		Object.defineProperty(crafted, "UNDEF_VAR", { get: () => undefined, enumerable: true, configurable: true })
		process.env = crafted as NodeJS.ProcessEnv

		try {
			const service = makeService()
			await service.initShadowGit()
		} finally {
			process.env = original
		}

		// simpleGit は baseDir=shadowDir で生成される。
		expect(vi.mocked(simpleGitDefault)).toHaveBeenCalledWith(expect.objectContaining({ baseDir: SHADOW_DIR }))
		// env() に渡された環境から GIT_DIR / GIT_EDITOR / UNDEF_VAR は消えている。
		const envCall = lastGit().calls.find((c) => c.method === "env")
		expect(envCall).toBeDefined()
		const passedEnv = envCall!.args[0] as Record<string, string>
		expect(passedEnv.NORMAL_VAR).toBe("1")
		expect(passedEnv).not.toHaveProperty("GIT_DIR")
		expect(passedEnv).not.toHaveProperty("GIT_EDITOR")
		expect(passedEnv).not.toHaveProperty("UNDEF_VAR")
	})

	it("git 系 env が無ければ removedVars は空のまま生成する", async () => {
		const original = process.env
		process.env = { NORMAL_ONLY: "42" } as unknown as NodeJS.ProcessEnv
		try {
			const service = makeService()
			await service.initShadowGit()
		} finally {
			process.env = original
		}
		const envCall = lastGit().calls.find((c) => c.method === "env")
		expect((envCall!.args[0] as Record<string, string>).NORMAL_ONLY).toBe("42")
	})
})

describe("constructor (保護パス)", () => {
	it("ホームディレクトリ配下では checkpoints を拒否する", () => {
		expect(() => makeService({ workspaceDir: os.homedir() })).toThrow(/Cannot use checkpoints/)
	})

	it("通常のワークスペースなら生成できる", () => {
		const service = makeService()
		expect(service.taskId).toBe(TASK_ID)
		expect(service.workspaceDir).toBe(WORKSPACE)
		expect(service.isInitialized).toBe(false)
		expect(service.getCheckpoints()).toEqual([])
	})
})

describe("initShadowGit", () => {
	it("新規 shadow repo を baseDir=shadowDir で初期化する（本体 workspace では git init しない）", async () => {
		gitEnv.config = { dotGitExists: false, commitHash: "base-commit" }
		const service = makeService()
		const onInit = vi.fn().mockResolvedValue(undefined)

		const { created, duration } = await service.initShadowGit(onInit)

		expect(created).toBe(true)
		expect(typeof duration).toBe("number")
		expect(service.isInitialized).toBe(true)
		expect(service.baseHash).toBe("base-commit")
		expect(onInit).toHaveBeenCalledTimes(1)

		// git は shadow ディレクトリでのみ生成され、本体 workspace は baseDir に現れない。
		const inst = lastGit()
		expect(inst.baseDir).toBe(SHADOW_DIR)
		expect(inst.baseDir).not.toBe(WORKSPACE)

		// init / addConfig の引数を全件アサート。core.worktree が本体 workspace を指す。
		expect(callArgs(inst, "init")).toEqual([[{ "--template": "" }]])
		expect(callArgs(inst, "addConfig")).toEqual([
			["core.worktree", WORKSPACE],
			["commit.gpgSign", "false"],
			["user.name", "Agent"],
			["user.email", "noreply@example.com"],
		])
		// 初期化時のステージングと空コミット。
		expect(callArgs(inst, "add")).toEqual([[[".", "--ignore-errors"]]])
		expect(callArgs(inst, "commit")).toEqual([["initial commit", { "--allow-empty": null }]])
		// 破壊的コマンドは初期化では一切呼ばれない。
		expect(methodsOf(inst)).not.toContain("reset")
		expect(methodsOf(inst)).not.toContain("clean")
		expect(methodsOf(inst)).not.toContain("checkout")
	})

	it("onInit 未指定でも初期化できる（optional chaining）", async () => {
		gitEnv.config = { dotGitExists: false }
		const service = makeService()
		const res = await service.initShadowGit()
		expect(res.created).toBe(true)
	})

	it("initialize イベントを正しいペイロードで emit する", async () => {
		gitEnv.config = { dotGitExists: false, commitHash: "base-xyz" }
		const service = makeService()
		const handler = vi.fn()
		service.on("initialize", handler)
		await service.initShadowGit()
		expect(handler).toHaveBeenCalledTimes(1)
		const ev = handler.mock.calls[0][0]
		expect(ev).toMatchObject({ type: "initialize", workspaceDir: WORKSPACE, baseHash: "base-xyz", created: true })
	})

	it("二重初期化は拒否する", async () => {
		gitEnv.config = { dotGitExists: false }
		const service = makeService()
		await service.initShadowGit()
		await expect(service.initShadowGit()).rejects.toThrow(/already initialized/)
	})

	it("既存 repo かつ core.worktree 一致なら HEAD を baseHash に採用する", async () => {
		gitEnv.config = { dotGitExists: true, getConfigValue: WORKSPACE, headHash: "existing-head" }
		const service = makeService()
		await service.initShadowGit()
		expect(service.baseHash).toBe("existing-head")
		const inst = lastGit()
		// 既存 repo では init/commit せず、HEAD 参照のみ。
		expect(methodsOf(inst)).not.toContain("init")
		expect(callArgs(inst, "revparse")).toEqual([[["HEAD"]]])
	})

	it("既存 repo で core.worktree 未設定なら例外", async () => {
		gitEnv.config = { dotGitExists: true, getConfigValue: "" }
		const service = makeService()
		await expect(service.initShadowGit()).rejects.toThrow(/core\.worktree to be set/)
	})

	it("既存 repo で core.worktree が別ディレクトリなら例外（範囲外の workspace を拒否）", async () => {
		gitEnv.config = { dotGitExists: true, getConfigValue: "/somewhere/else" }
		const service = makeService()
		await expect(service.initShadowGit()).rejects.toThrow(/only be used in the original workspace/)
	})

	it("ネスト git 検出時は error を表示して例外（フィルタ全分岐）", async () => {
		gitEnv.config = {
			dotGitExists: false,
			ripgrep: [
				{ type: "folder", path: "x/.git/HEAD" }, // type!=="file" → 除外
				{ type: "file", path: ".git/HEAD" }, // ルート → 除外
				{ type: "file", path: "notes.txt" }, // .git/HEAD を含まない → 除外
				{ type: "file", path: "sub\\.git\\HEAD" }, // バックスラッシュ正規化 → 採用
			],
		}
		const service = makeService()
		await expect(service.initShadowGit()).rejects.toThrow(/nested git repository was detected/)
	})

	it("ネスト無し（ripgrep 空）なら初期化を継続する", async () => {
		gitEnv.config = { dotGitExists: false, ripgrep: [] }
		const service = makeService()
		await expect(service.initShadowGit()).resolves.toMatchObject({ created: true })
	})

	it("ripgrep が例外を投げてもブロックせず初期化する（Error）", async () => {
		gitEnv.config = { dotGitExists: false }
		vi.mocked(fileSearch.executeRipgrep).mockRejectedValueOnce(new Error("rg boom"))
		const service = makeService()
		await expect(service.initShadowGit()).resolves.toMatchObject({ created: true })
	})

	it("ripgrep が非 Error で reject してもブロックしない（String 分岐）", async () => {
		gitEnv.config = { dotGitExists: false }
		vi.mocked(fileSearch.executeRipgrep).mockRejectedValueOnce("rg string failure")
		const service = makeService()
		await expect(service.initShadowGit()).resolves.toMatchObject({ created: true })
	})

	it("getConfig が例外でも getShadowGitConfigWorktree は握りつぶす（Error）", async () => {
		// 既存 repo 経路で getConfig を reject → worktree 未取得 → core.worktree 未設定例外。
		gitEnv.config = { dotGitExists: true, getConfigReject: new Error("cfg boom") }
		const service = makeService()
		await expect(service.initShadowGit()).rejects.toThrow(/core\.worktree to be set/)
	})

	it("getConfig が非 Error で reject でも握りつぶす（String 分岐）", async () => {
		gitEnv.config = { dotGitExists: true, getConfigReject: "cfg string" }
		const service = makeService()
		await expect(service.initShadowGit()).rejects.toThrow(/core\.worktree to be set/)
	})
})

describe("stageAll (add のエラー握りつぶし)", () => {
	it("add が Error で失敗してもログのみで継続する", async () => {
		gitEnv.config = { dotGitExists: false, reject: { add: new Error("add boom") } }
		const service = makeService()
		// 初期化中の stageAll は握りつぶされ、commit まで到達する。
		await expect(service.initShadowGit()).resolves.toMatchObject({ created: true })
	})

	it("add が非 Error で失敗しても継続する（String 分岐）", async () => {
		gitEnv.config = { dotGitExists: false, reject: { add: "add string fail" } }
		const service = makeService()
		await expect(service.initShadowGit()).resolves.toMatchObject({ created: true })
	})
})

describe("saveCheckpoint", () => {
	const initNew = async () => {
		gitEnv.config = { dotGitExists: false, commitHash: "base-commit" }
		const service = makeService()
		await service.initShadowGit()
		return service
	}

	it("未初期化なら例外", async () => {
		const service = makeService()
		await expect(service.saveCheckpoint("m")).rejects.toThrow(/not initialized/)
	})

	it("変更があれば commit し checkpoint イベントを emit（allowEmpty 無し）", async () => {
		const service = await initNew()
		const handler = vi.fn()
		service.on("checkpoint", handler)
		gitEnv.config.commitHash = "cp1"

		const result = await service.saveCheckpoint("save 1")
		expect(result?.commit).toBe("cp1")

		const inst = lastGit()
		// allowEmpty 無し → commit の第2引数は undefined。
		expect(callArgs(inst, "commit").slice(-1)[0]).toEqual(["save 1", undefined])

		expect(handler).toHaveBeenCalledTimes(1)
		const ev = handler.mock.calls[0][0]
		// checkpoints 空なので fromHash は baseHash。
		expect(ev).toMatchObject({ type: "checkpoint", fromHash: "base-commit", toHash: "cp1", suppressMessage: false })
		expect(service.getCheckpoints()).toEqual(["cp1"])
	})

	it("allowEmpty=true と suppressMessage=true を引数/イベントに反映する", async () => {
		const service = await initNew()
		const handler = vi.fn()
		service.on("checkpoint", handler)
		gitEnv.config.commitHash = "cpE"

		const result = await service.saveCheckpoint("empty save", { allowEmpty: true, suppressMessage: true })
		expect(result?.commit).toBe("cpE")

		const inst = lastGit()
		expect(callArgs(inst, "commit").slice(-1)[0]).toEqual(["empty save", { "--allow-empty": null }])
		expect(handler.mock.calls[0][0].suppressMessage).toBe(true)
	})

	it("2 回目の checkpoint では fromHash が直前の checkpoint になる", async () => {
		const service = await initNew()
		gitEnv.config.commitHash = "cp1"
		await service.saveCheckpoint("save 1")
		const handler = vi.fn()
		service.on("checkpoint", handler)
		gitEnv.config.commitHash = "cp2"
		await service.saveCheckpoint("save 2")
		expect(handler.mock.calls[0][0]).toMatchObject({ fromHash: "cp1", toHash: "cp2" })
		expect(service.getCheckpoints()).toEqual(["cp1", "cp2"])
	})

	it("commit が空（変更なし）なら undefined を返しイベントも出さない", async () => {
		const service = await initNew()
		const handler = vi.fn()
		service.on("checkpoint", handler)
		gitEnv.config.commitHash = "" // commit 無し

		const result = await service.saveCheckpoint("no changes")
		expect(result).toBeUndefined()
		expect(handler).not.toHaveBeenCalled()
	})

	it("commit が Error で失敗したら error を emit して再スロー", async () => {
		const service = await initNew()
		const errHandler = vi.fn()
		service.on("error", errHandler)
		gitEnv.config.reject = { commit: new Error("commit boom") }

		await expect(service.saveCheckpoint("boom")).rejects.toThrow(/commit boom/)
		expect(errHandler).toHaveBeenCalledTimes(1)
		expect(errHandler.mock.calls[0][0].error).toBeInstanceOf(Error)
	})

	it("commit が非 Error で失敗しても Error に包んで再スロー（String 分岐）", async () => {
		const service = await initNew()
		const errHandler = vi.fn()
		service.on("error", errHandler)
		gitEnv.config.reject = { commit: "commit string fail" }

		await expect(service.saveCheckpoint("boom")).rejects.toThrow(/commit string fail/)
		expect(errHandler.mock.calls[0][0].error).toBeInstanceOf(Error)
	})
})

describe("restoreCheckpoint (破壊的復元の不変条件)", () => {
	const initWith = async () => {
		gitEnv.config = { dotGitExists: false, commitHash: "base-commit" }
		const service = makeService()
		await service.initShadowGit()
		gitEnv.config.commitHash = "cp1"
		await service.saveCheckpoint("s1")
		gitEnv.config.commitHash = "cp2"
		await service.saveCheckpoint("s2")
		return service
	}

	it("未初期化なら例外", async () => {
		const service = makeService()
		await expect(service.restoreCheckpoint("cp1")).rejects.toThrow(/not initialized/)
	})

	it("shadow repo に対して clean → reset --hash の順で復元し、checkout は使わない", async () => {
		const service = await initWith()
		const inst = lastGit()
		const before = inst.calls.length
		const restoreHandler = vi.fn()
		service.on("restore", restoreHandler)

		await service.restoreCheckpoint("cp1")

		const newCalls = inst.calls.slice(before)
		// 不変条件: 破壊的操作は shadow repo(baseDir=shadowDir)上でのみ実行。
		expect(inst.baseDir).toBe(SHADOW_DIR)
		expect(inst.baseDir).not.toBe(WORKSPACE)
		// clean と reset --hard <commit> がこの順で、引数厳密一致で呼ばれる。
		const clean = newCalls.find((c) => c.method === "clean")!
		const reset = newCalls.find((c) => c.method === "reset")!
		expect(clean.args).toEqual(["f", ["-d", "-f"]])
		expect(reset.args).toEqual([["--hard", "cp1"]])
		expect(newCalls.indexOf(clean)).toBeLessThan(newCalls.indexOf(reset))
		// 復元では checkout を絶対に呼ばない。
		expect(newCalls.map((c) => c.method)).not.toContain("checkout")
		// 復元対象より後ろの checkpoint は切り詰められる（shadow 範囲内）。
		expect(service.getCheckpoints()).toEqual(["cp1"])
		expect(restoreHandler).toHaveBeenCalledTimes(1)
		expect(restoreHandler.mock.calls[0][0]).toMatchObject({ type: "restore", commitHash: "cp1" })
	})

	it("checkpoints に無いハッシュへの復元では切り詰めを行わない", async () => {
		const service = await initWith()
		await service.restoreCheckpoint("unknown-hash")
		// indexOf === -1 のため配列は不変。
		expect(service.getCheckpoints()).toEqual(["cp1", "cp2"])
	})

	it("reset が Error で失敗したら error を emit して再スロー", async () => {
		const service = await initWith()
		const errHandler = vi.fn()
		service.on("error", errHandler)
		gitEnv.config.reject = { reset: new Error("reset boom") }
		await expect(service.restoreCheckpoint("cp1")).rejects.toThrow(/reset boom/)
		expect(errHandler.mock.calls[0][0].error).toBeInstanceOf(Error)
	})

	it("reset が非 Error で失敗しても Error に包んで再スロー（String 分岐）", async () => {
		const service = await initWith()
		const errHandler = vi.fn()
		service.on("error", errHandler)
		gitEnv.config.reject = { reset: "reset string" }
		await expect(service.restoreCheckpoint("cp1")).rejects.toThrow(/reset string/)
		expect(errHandler.mock.calls[0][0].error).toBeInstanceOf(Error)
	})
})

describe("getDiff (非破壊であることの不変条件)", () => {
	const initNew = async () => {
		gitEnv.config = { dotGitExists: false, commitHash: "base-commit" }
		const service = makeService()
		await service.initShadowGit()
		return service
	}

	it("未初期化なら例外", async () => {
		const service = makeService()
		await expect(service.getDiff({})).rejects.toThrow(/not initialized/)
	})

	it("from/to 指定あり: show で before/after を取得し、破壊的 git を一切呼ばない", async () => {
		const service = await initNew()
		gitEnv.config.getConfigValue = WORKSPACE
		gitEnv.config.diffFiles = [{ file: "a.ts" }]
		gitEnv.config.showContent = "CONTENT"

		const inst = lastGit()
		const before = inst.calls.length
		const diff = await service.getDiff({ from: "h1", to: "h2" })

		expect(diff).toEqual([
			{
				paths: { relative: "a.ts", absolute: path.join(WORKSPACE, "a.ts") },
				content: { before: "CONTENT", after: "CONTENT" },
			},
		])
		const newCalls = inst.calls.slice(before).map((c) => c.method)
		// diff は add(ステージング)/diffSummary/show のみ。破壊的操作なし。
		expect(newCalls).not.toContain("reset")
		expect(newCalls).not.toContain("clean")
		expect(newCalls).not.toContain("checkout")
		// diffSummary は from..to 形式。
		expect(callArgs(inst, "diffSummary").slice(-1)[0]).toEqual([["h1..h2"]])
		// to 指定時は show([`${to}:rel`]) で after を取る。
		expect(callArgs(inst, "show")).toContainEqual([["h2:a.ts"]])
	})

	it("from 未指定なら rev-list でルートを算出し、to 無しは readFile で after を取得", async () => {
		const service = await initNew()
		gitEnv.config.getConfigValue = WORKSPACE
		gitEnv.config.revListHash = "rootc"
		gitEnv.config.diffFiles = [{ file: "b.ts" }]
		gitEnv.config.showContent = "BEFORE_B"
		fs.readFile.mockResolvedValueOnce("WORKING_B")

		const inst = lastGit()
		const diff = await service.getDiff({})

		expect(callArgs(inst, "raw")).toContainEqual([["rev-list", "--max-parents=0", "HEAD"]])
		// from のみ → diffSummary([from])
		expect(callArgs(inst, "diffSummary").slice(-1)[0]).toEqual([["rootc"]])
		expect(diff[0].content.before).toBe("BEFORE_B")
		expect(diff[0].content.after).toBe("WORKING_B")
		expect(fs.readFile).toHaveBeenCalledWith(path.join(WORKSPACE, "b.ts"), "utf8")
	})

	it("show が失敗したら before/after は空文字にフォールバック（to 指定）", async () => {
		const service = await initNew()
		gitEnv.config.getConfigValue = WORKSPACE
		gitEnv.config.diffFiles = [{ file: "c.ts" }]
		gitEnv.config.showReject = true

		const diff = await service.getDiff({ from: "h1", to: "h2" })
		expect(diff[0].content).toEqual({ before: "", after: "" })
	})

	it("readFile が失敗したら after は空文字にフォールバック（to 未指定）", async () => {
		const service = await initNew()
		gitEnv.config.getConfigValue = WORKSPACE
		gitEnv.config.diffFiles = [{ file: "d.ts" }]
		fs.readFile.mockRejectedValueOnce(new Error("read boom"))

		const diff = await service.getDiff({ from: "h1" })
		expect(diff[0].content.after).toBe("")
	})

	it("差分ファイルが無ければ空配列", async () => {
		const service = await initNew()
		gitEnv.config.getConfigValue = WORKSPACE
		gitEnv.config.diffFiles = []
		const diff = await service.getDiff({ from: "h1", to: "h2" })
		expect(diff).toEqual([])
	})

	it("core.worktree 取得不可なら workspaceDir を絶対パス基準にする", async () => {
		const service = await initNew()
		gitEnv.config.getConfigValue = "" // worktree 空 → undefined
		gitEnv.config.diffFiles = [{ file: "e.ts" }]
		const diff = await service.getDiff({ from: "h1", to: "h2" })
		expect(diff[0].paths.absolute).toBe(path.join(WORKSPACE, "e.ts"))
	})

	it("worktree も workspaceDir も空なら基準は空文字（相対パス）", async () => {
		gitEnv.config = { dotGitExists: false, commitHash: "base" }
		const service = makeService({ workspaceDir: "" })
		await service.initShadowGit()
		gitEnv.config.getConfigValue = ""
		gitEnv.config.diffFiles = [{ file: "f.ts" }]
		const diff = await service.getDiff({ from: "h1", to: "h2" })
		expect(diff[0].paths.absolute).toBe("f.ts")
	})

	it("既存 repo 初期化で取得済みの worktree はキャッシュされ再取得しない", async () => {
		// 既存 repo 経路で getShadowGitConfigWorktree が worktree をキャッシュ。
		gitEnv.config = { dotGitExists: true, getConfigValue: WORKSPACE, headHash: "head" }
		const service = makeService()
		await service.initShadowGit()
		const inst = lastGit()
		const getConfigCallsAfterInit = callArgs(inst, "getConfig").length

		gitEnv.config.diffFiles = [{ file: "g.ts" }]
		await service.getDiff({ from: "h1", to: "h2" })
		// キャッシュ利用のため getConfig の呼び出し回数は増えない。
		expect(callArgs(inst, "getConfig").length).toBe(getConfigCallsAfterInit)
	})
})

describe("EventEmitter オーバーライド", () => {
	it("once / off が機能する", async () => {
		gitEnv.config = { dotGitExists: false, commitHash: "base" }
		const service = makeService()
		await service.initShadowGit()

		const onceHandler = vi.fn()
		service.once("checkpoint", onceHandler)
		gitEnv.config.commitHash = "c1"
		await service.saveCheckpoint("s1")
		gitEnv.config.commitHash = "c2"
		await service.saveCheckpoint("s2")
		expect(onceHandler).toHaveBeenCalledTimes(1)

		const offHandler = vi.fn()
		service.on("checkpoint", offHandler)
		service.off("checkpoint", offHandler)
		gitEnv.config.commitHash = "c3"
		await service.saveCheckpoint("s3")
		expect(offHandler).not.toHaveBeenCalled()
	})
})

describe("静的ヘルパ", () => {
	it("hashWorkspaceDir は 8 桁 hex", () => {
		const h = ShadowCheckpointService.hashWorkspaceDir(WORKSPACE)
		expect(h).toMatch(/^[0-9a-f]{8}$/)
	})

	it("taskRepoDir は tasks/<id>/checkpoints を返す", () => {
		const dir = (ShadowCheckpointService as any).taskRepoDir({ taskId: TASK_ID, globalStorageDir: GLOBAL_STORAGE })
		expect(dir).toBe(path.join(GLOBAL_STORAGE, "tasks", TASK_ID, "checkpoints"))
	})

	it("workspaceRepoDir は checkpoints/<hash> を返す", () => {
		const dir = (ShadowCheckpointService as any).workspaceRepoDir({
			globalStorageDir: GLOBAL_STORAGE,
			workspaceDir: WORKSPACE,
		})
		expect(dir).toBe(path.join(GLOBAL_STORAGE, "checkpoints", ShadowCheckpointService.hashWorkspaceDir(WORKSPACE)))
	})
})

describe("deleteTask / deleteBranch (ブランチ削除の安全性)", () => {
	const WS_REPO_DIR = path.join(GLOBAL_STORAGE, "checkpoints", ShadowCheckpointService.hashWorkspaceDir(WORKSPACE))
	const BRANCH = `roo-${TASK_ID}`

	it("deleteTask: 削除成功時は成功ログ、workspace repo(baseDir) を使い本体 workspace は触らない", async () => {
		gitEnv.config = { branchAll: [BRANCH, "main"], currentBranch: "main" }
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})

		await ShadowCheckpointService.deleteTask({
			taskId: TASK_ID,
			globalStorageDir: GLOBAL_STORAGE,
			workspaceDir: WORKSPACE,
		})

		const inst = lastGit()
		// 生成された git は workspace repo(shadow 側) を指し、本体 workspace ではない。
		expect(inst.baseDir).toBe(WS_REPO_DIR)
		expect(inst.baseDir).not.toBe(WORKSPACE)
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`deleted branch ${BRANCH}`))
	})

	it("deleteTask: 削除失敗時はエラーログ", async () => {
		gitEnv.config = { branchAll: ["main"] } // 対象ブランチ無し → false
		vi.spyOn(console, "log").mockImplementation(() => {})
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await ShadowCheckpointService.deleteTask({
			taskId: TASK_ID,
			globalStorageDir: GLOBAL_STORAGE,
			workspaceDir: WORKSPACE,
		})
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(`failed to delete branch ${BRANCH}`))
	})

	it("deleteBranch: 対象ブランチが存在しなければ false", async () => {
		gitEnv.config = { branchAll: ["main"] }
		vi.spyOn(console, "error").mockImplementation(() => {})
		const git = (simpleGitDefault as unknown as (o: any) => any)({ baseDir: WS_REPO_DIR })
		const ok = await ShadowCheckpointService.deleteBranch(git, BRANCH)
		expect(ok).toBe(false)
	})

	it("deleteBranch: 別ブランチにいる場合は -D で削除して true", async () => {
		gitEnv.config = { branchAll: [BRANCH, "main"], currentBranch: "main" }
		const git = (simpleGitDefault as unknown as (o: any) => any)({ baseDir: WS_REPO_DIR })
		const inst = lastGit()
		const ok = await ShadowCheckpointService.deleteBranch(git, BRANCH)
		expect(ok).toBe(true)
		expect(callArgs(inst, "branch")).toEqual([[["-D", BRANCH]]])
		// 別ブランチにいるので破壊的リセット類は不要。
		expect(methodsOf(inst)).not.toContain("reset")
		expect(methodsOf(inst)).not.toContain("clean")
		expect(methodsOf(inst)).not.toContain("checkout")
	})

	it("deleteBranch: 対象がカレントの場合、core.worktree を外してから reset/clean/checkout する（本体保護の順序）", async () => {
		// 対象ブランチがカレント。default は main。worktree.value あり → finally で復元。
		gitEnv.config = { branchAll: [BRANCH, "main"], currentBranch: BRANCH, getConfigValue: WORKSPACE }
		const git = (simpleGitDefault as unknown as (o: any) => any)({ baseDir: WS_REPO_DIR })
		const inst = lastGit()

		const ok = await ShadowCheckpointService.deleteBranch(git, BRANCH)
		expect(ok).toBe(true)

		const seq = inst.calls
		const idxUnset = seq.findIndex((c) => c.method === "raw" && (c.args[0] as string[]).includes("--unset"))
		const idxReset = seq.findIndex((c) => c.method === "reset")
		const idxClean = seq.findIndex((c) => c.method === "clean")
		const idxCheckout = seq.findIndex((c) => c.method === "checkout")

		// 不変条件: 破壊的操作の前に必ず core.worktree を unset している
		// （さもないと reset --hard / clean / checkout が本体 workspace を破壊する）。
		expect(idxUnset).toBeGreaterThanOrEqual(0)
		expect(idxUnset).toBeLessThan(idxReset)
		expect(idxUnset).toBeLessThan(idxClean)
		expect(idxUnset).toBeLessThan(idxCheckout)

		// 引数を全件アサート。
		expect(seq[idxUnset].args).toEqual([["config", "--unset", "core.worktree"]])
		expect(seq[idxReset].args).toEqual([["--hard"]])
		expect(seq[idxClean].args).toEqual(["f", ["-d"]])
		expect(seq[idxCheckout].args).toEqual([["main", "--force"]])
		expect(callArgs(inst, "branch")).toEqual([[["-D", BRANCH]]])

		// finally: 退避した core.worktree を addConfig で復元する。
		expect(callArgs(inst, "addConfig")).toEqual([["core.worktree", WORKSPACE]])
	})

	it("deleteBranch: main が無ければ master を default に checkout する", async () => {
		gitEnv.config = { branchAll: [BRANCH, "master"], currentBranch: BRANCH, getConfigValue: WORKSPACE }
		const git = (simpleGitDefault as unknown as (o: any) => any)({ baseDir: WS_REPO_DIR })
		const inst = lastGit()
		await ShadowCheckpointService.deleteBranch(git, BRANCH)
		expect(callArgs(inst, "checkout")).toEqual([[["master", "--force"]]])
	})

	it("deleteBranch: worktree.value が無ければ finally で復元しない", async () => {
		gitEnv.config = { branchAll: [BRANCH, "main"], currentBranch: BRANCH, getConfigValue: "" }
		const git = (simpleGitDefault as unknown as (o: any) => any)({ baseDir: WS_REPO_DIR })
		const inst = lastGit()
		await ShadowCheckpointService.deleteBranch(git, BRANCH)
		// getConfigValue 空 → addConfig による復元は呼ばれない。
		expect(methodsOf(inst)).not.toContain("addConfig")
	})

	it("deleteBranch: 途中で例外(Error)なら false を返し worktree を復元する", async () => {
		gitEnv.config = {
			branchAll: [BRANCH, "main"],
			currentBranch: BRANCH,
			getConfigValue: WORKSPACE,
			reject: { checkout: new Error("checkout boom") },
		}
		vi.spyOn(console, "error").mockImplementation(() => {})
		const git = (simpleGitDefault as unknown as (o: any) => any)({ baseDir: WS_REPO_DIR })
		const inst = lastGit()
		const ok = await ShadowCheckpointService.deleteBranch(git, BRANCH)
		expect(ok).toBe(false)
		// 例外でも finally で core.worktree を復元。
		expect(callArgs(inst, "addConfig")).toEqual([["core.worktree", WORKSPACE]])
	})

	it("deleteBranch: catch 内のログ出力が例外を投げても finally で core.worktree を復元する", async () => {
		// catch がさらに例外を投げると finally は「例外伝播経路」で実行される。
		// この経路でも退避した core.worktree が確実に復元されることを保証する
		// （復元漏れは本体 workspace を壊れた状態に残す破壊的バグになりうる）。
		gitEnv.config = {
			branchAll: [BRANCH, "main"],
			currentBranch: BRANCH,
			getConfigValue: WORKSPACE,
			reject: { checkout: new Error("checkout boom") },
		}
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {
			throw new Error("logging boom")
		})
		const git = (simpleGitDefault as unknown as (o: any) => any)({ baseDir: WS_REPO_DIR })
		const inst = lastGit()

		await expect(ShadowCheckpointService.deleteBranch(git, BRANCH)).rejects.toThrow(/logging boom/)
		// 例外伝播中でも finally は走り、core.worktree を復元している。
		expect(callArgs(inst, "addConfig")).toEqual([["core.worktree", WORKSPACE]])
		errSpy.mockRestore()
	})

	it("deleteBranch: 非 Error で失敗しても false（String 分岐）", async () => {
		gitEnv.config = {
			branchAll: [BRANCH, "main"],
			currentBranch: BRANCH,
			getConfigValue: WORKSPACE,
			reject: { checkout: "checkout string" },
		}
		vi.spyOn(console, "error").mockImplementation(() => {})
		const git = (simpleGitDefault as unknown as (o: any) => any)({ baseDir: WS_REPO_DIR })
		const ok = await ShadowCheckpointService.deleteBranch(git, BRANCH)
		expect(ok).toBe(false)
	})
})
