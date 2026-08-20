// npx vitest run core/webview/__tests__/worktreeHandlers.spec.ts
//
// src/core/webview/worktree/handlers.ts は webview から届いた文字列を
// **そのまま git に渡す** 層。C0 6.7%（194 行未実行）で、削除・チェックアウトといった
// 「取り返しがつかない側」の経路が一度も試されていなかった。
//
// ここで固定するのは次の 5 点:
//   1. 本体のワークスペースディレクトリに対して破壊的な操作（git worktree remove /
//      git clean / git reset --hard / ディレクトリ削除）が飛ばないこと。
//      webview 由来の文字列が git argv になる経路には拡張ホスト側にガードがあり、
//      弾かれた入力では **git が 1 度も起動されない**
//   2. 未コミットの変更を持つ worktree を消すときの `--force` の扱い
//   3. git に渡る argv を全件アサートする（exec / execFile / spawn の引数）
//   4. パス組み立てにユーザー入力（ワークスペース名・ブランチ名）が混ざる箇所で
//      `..` やセパレータによる脱出が起きるか
//   5. 各ハンドラの失敗経路（git 不在 / 非 git / multi-root / サブフォルダ / 例外）
//
// **本物の git は絶対に起動しない。** child_process（exec / execFile / spawn）と
// fs/promises と vscode をすべて vi.mock し、「1 度も起動されていない」ことを
// アサートできるようにしている。git 実行層は本物（@openai-agent/core の
// worktreeService / worktreeIncludeService）を通すので、argv は実物と同じものが記録される。

import * as os from "os"
import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { worktreeService, worktreeIncludeService } from "@openai-agent/core"
import type { Worktree } from "@openai-agent/types"

import type { ContextProxy } from "../../config/ContextProxy"
import type { WorktreeHandlerHost } from "../worktree/worktreeHandlerHost"
import {
	handleListWorktrees,
	handleCreateWorktree,
	handleDeleteWorktree,
	handleSwitchWorktree,
	handleGetAvailableBranches,
	handleGetWorktreeDefaults,
	handleGetWorktreeIncludeStatus,
	handleCheckBranchWorktreeInclude,
	handleCreateWorktreeInclude,
	handleCheckoutBranch,
} from "../worktree"

// ---------------------------------------------------------------------------
// モック: 実プロセスと実ファイルへの経路を全部塞ぐ
// ---------------------------------------------------------------------------

const { execMock, execFileMock, spawnMock } = vi.hoisted(() => ({
	execMock: vi.fn(),
	execFileMock: vi.fn(),
	spawnMock: vi.fn(),
}))

// worktree-service.ts / worktree-include.ts は `import { exec, execFile, spawn } from "child_process"`。
// promisify() はモジュール読み込み時に評価されるので、hoist 済みのこのモックが必ず先に入る。
vi.mock("child_process", () => {
	const api = { exec: execMock, execFile: execFileMock, spawn: spawnMock }
	return { ...api, default: api }
})

const fsMock = vi.hoisted(() => ({
	access: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	readdir: vi.fn(),
	stat: vi.fn(),
	mkdir: vi.fn(),
	copyFile: vi.fn(),
	rm: vi.fn(),
	rmdir: vi.fn(),
	unlink: vi.fn(),
}))

vi.mock("fs/promises", () => ({ ...fsMock, default: fsMock }))

const vscodeState = vi.hoisted(() => ({
	workspaceFolders: undefined as Array<{ name: string; uri: { fsPath: string } }> | undefined,
	workspaceFoldersThrows: false,
}))

const { executeCommandMock, openTextDocumentMock, showTextDocumentMock } = vi.hoisted(() => ({
	executeCommandMock: vi.fn(),
	openTextDocumentMock: vi.fn(),
	showTextDocumentMock: vi.fn(),
}))

vi.mock("vscode", () => {
	const workspace = {
		// テストごとに差し替えたいので getter。例外を投げる状態も作れるようにしておく。
		get workspaceFolders() {
			if (vscodeState.workspaceFoldersThrows) {
				throw new Error("workspaceFolders unavailable")
			}
			return vscodeState.workspaceFolders
		},
		openTextDocument: openTextDocumentMock,
	}
	const api = {
		workspace,
		window: { showTextDocument: showTextDocumentMock },
		commands: { executeCommand: executeCommandMock },
		Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }) },
	}
	return { ...api, default: api }
})

// ---------------------------------------------------------------------------
// 定数とテスト用の git 世界
// ---------------------------------------------------------------------------

/** 本体のワークスペース。**ここを壊す操作が飛んだら不変条件違反。** */
const WORKSPACE = "/workspace/project"
/** 別ディレクトリに作られた linked worktree。 */
const WORKTREE_A = "/home/dev/.agent/worktrees/project-ab12c"

const DEFAULT_PORCELAIN = [
	`worktree ${WORKSPACE}`,
	"HEAD 1111111111111111111111111111111111111111",
	"branch refs/heads/main",
	"",
	`worktree ${WORKTREE_A}`,
	"HEAD 2222222222222222222222222222222222222222",
	"branch refs/heads/feature/x",
	"",
].join("\n")

type ExecOptions = { cwd?: string } | undefined
type CommandOutcome = { stdout: string; stderr: string } | { error: unknown }

/** 既定の git の応答を決めるだけの状態。テストから書き換える。 */
const gitWorld = {
	isRepo: true,
	topLevel: WORKSPACE as string | null,
	currentBranch: "main" as string | null,
	porcelain: DEFAULT_PORCELAIN,
	localBranches: "main\nfeature/x\n",
	remoteBranches: "origin/main\norigin/HEAD -> origin/main\n",
}

/** `exec("<コマンド文字列>")` の応答。既定は gitWorld から組み立てる。 */
let shellResponder: (command: string, options: ExecOptions) => CommandOutcome
/** `execFile("git", argv)` の応答。既定は成功（空出力）。 */
let argvResponder: (file: string, args: string[], options: ExecOptions) => CommandOutcome

function defaultShellResponder(command: string): CommandOutcome {
	switch (command) {
		case "git rev-parse --git-dir":
			return gitWorld.isRepo ? { stdout: ".git\n", stderr: "" } : { error: new Error("not a git repository") }
		case "git rev-parse --show-toplevel":
			return gitWorld.topLevel === null
				? { error: new Error("not a git repository") }
				: { stdout: `${gitWorld.topLevel}\n`, stderr: "" }
		case "git rev-parse --abbrev-ref HEAD":
			return { stdout: `${gitWorld.currentBranch ?? "HEAD"}\n`, stderr: "" }
		case "git worktree list --porcelain":
			return { stdout: gitWorld.porcelain, stderr: "" }
		case 'git branch --format="%(refname:short)"':
			return { stdout: gitWorld.localBranches, stderr: "" }
		case 'git branch -r --format="%(refname:short)"':
			return { stdout: gitWorld.remoteBranches, stderr: "" }
		default:
			return { error: new Error(`テストが想定していないコマンド: ${command}`) }
	}
}

// ---------------------------------------------------------------------------
// 記録の取り出しヘルパ
// ---------------------------------------------------------------------------

interface ShellCall {
	command: string
	cwd?: string
}
interface ArgvCall {
	file: string
	args: string[]
	cwd?: string
}

/** exec に渡ったシェルコマンド文字列を呼ばれた順に全件返す。 */
function shellCalls(): ShellCall[] {
	return execMock.mock.calls.map((call) => ({
		command: call[0] as string,
		cwd: (call[1] as ExecOptions)?.cwd,
	}))
}

/** execFile に渡った argv を呼ばれた順に全件返す。 */
function argvCalls(): ArgvCall[] {
	return execFileMock.mock.calls.map((call) => ({
		file: call[0] as string,
		args: call[1] as string[],
		cwd: (call[2] as ExecOptions)?.cwd,
	}))
}

/** argv を `git worktree remove --force <path>` のような 1 行に潰す（比較用）。 */
function argvLines(): string[] {
	return argvCalls().map(({ file, args }) => [file, ...args].join(" "))
}

/** **外部プロセスが 1 度も起動されていないこと。** */
function expectNoCommandRan(label: string): void {
	expect(execMock, `${label}: exec`).not.toHaveBeenCalled()
	expect(execFileMock, `${label}: execFile`).not.toHaveBeenCalled()
	expect(spawnMock, `${label}: spawn`).not.toHaveBeenCalled()
}

/** ファイル削除 API は worktree ハンドラからは決して呼ばれない。 */
function expectNoFileRemoval(label: string): void {
	expect(fsMock.rm, `${label}: fs.rm`).not.toHaveBeenCalled()
	expect(fsMock.rmdir, `${label}: fs.rmdir`).not.toHaveBeenCalled()
	expect(fsMock.unlink, `${label}: fs.unlink`).not.toHaveBeenCalled()
}

/**
 * **不変条件 1**: `dir`（＝本体のワークスペース）を壊す操作が 1 件も飛んでいないこと。
 *
 * 検査対象:
 *   - `git worktree remove <dir>`（ディレクトリごと消える）
 *   - `git clean` / `git reset --hard` / `git restore` / `git stash`（未コミット変更が消える）
 *   - `git checkout <pathspec>` や `git checkout -f`（作業ツリーが巻き戻る）
 *   - `git branch -D`（マージ前のブランチが消える）
 *   - fs の削除 API、および cp / rm の spawn
 */
function expectNoDestructionOf(dir: string, label = "破壊操作"): void {
	expectNoFileRemoval(label)
	expect(spawnMock, `${label}: spawn`).not.toHaveBeenCalled()

	const resolvedDir = path.resolve(dir)

	for (const { file, args, cwd } of argvCalls()) {
		const where = `${label}: ${[file, ...args].join(" ")} (cwd=${cwd})`
		expect(file, where).toBe("git")
		const [sub, ...rest] = args

		if (sub === "worktree" && rest[0] === "remove") {
			const target = rest[rest.length - 1]!
			expect(path.resolve(cwd ?? path.sep, target), where).not.toBe(resolvedDir)
		}

		expect(["clean", "restore", "stash"].includes(sub!), where).toBe(false)
		expect(sub === "reset" && rest.includes("--hard"), where).toBe(false)
		expect(sub === "branch" && rest.includes("-D"), where).toBe(false)

		if (sub === "checkout") {
			// `--` は end-of-options 区切り。**その後ろは全部 pathspec** なので、
			// 1 件でもあれば「ブランチ切り替え」ではなく「作業ツリーの巻き戻し」になる。
			const separator = rest.indexOf("--")
			const revisions = separator === -1 ? rest : rest.slice(0, separator)
			const pathspecs = separator === -1 ? [] : rest.slice(separator + 1)

			expect(pathspecs, `${where}: pathspec が付いている`).toEqual([])

			// `.` / `..` / `-f` / `--force` / ワークスペース内の絶対パスは pathspec や
			// オプションとして解釈され、ブランチ切り替えではなく「作業ツリーの巻き戻し」
			// になる。ブランチ名らしい相対名（feature/x など）は git がブランチとして
			// 先に解決するのでここでは咎めない。
			for (const operand of revisions) {
				expect(operand === "." || operand === "..", where).toBe(false)
				expect(operand.startsWith("-"), where).toBe(false)
				expect(path.isAbsolute(operand) && path.resolve(operand).startsWith(resolvedDir), where).toBe(false)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// ホストの贋物
// ---------------------------------------------------------------------------

function makeHost(options: { cwd?: string } = {}) {
	const setValue = vi.fn(async () => {})
	const log = vi.fn()

	// contextProxy 以外は WorktreeHandlerHost として型付けしておく（型ドリフトを拾うため）。
	const host: WorktreeHandlerHost = {
		contextProxy: { setValue } as unknown as ContextProxy,
		cwd: options.cwd ?? WORKSPACE,
		log,
	}

	return { host, setValue, log }
}

// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks()

	gitWorld.isRepo = true
	gitWorld.topLevel = WORKSPACE
	gitWorld.currentBranch = "main"
	gitWorld.porcelain = DEFAULT_PORCELAIN
	gitWorld.localBranches = "main\nfeature/x\n"
	gitWorld.remoteBranches = "origin/main\norigin/HEAD -> origin/main\n"

	shellResponder = (command) => defaultShellResponder(command)
	argvResponder = () => ({ stdout: "", stderr: "" })

	// promisify(exec) は `exec(command, options?, callback)` の形で呼ぶ。
	// util.promisify.custom を持たないモックなので、コールバックの第 2 引数が
	// そのまま await の値になる。実物に合わせて { stdout, stderr } を返す。
	execMock.mockImplementation((...args: unknown[]) => {
		const callback = args[args.length - 1] as (error: unknown, value?: unknown) => void
		const command = args[0] as string
		const options = (typeof args[1] === "object" && args[1] !== null ? args[1] : undefined) as ExecOptions
		const outcome = shellResponder(command, options)
		queueMicrotask(() => ("error" in outcome ? callback(outcome.error) : callback(null, outcome)))
		return undefined
	})

	execFileMock.mockImplementation((...args: unknown[]) => {
		const callback = args[args.length - 1] as (error: unknown, value?: unknown) => void
		const file = args[0] as string
		const argv = args[1] as string[]
		const options = (typeof args[2] === "object" && args[2] !== null ? args[2] : undefined) as ExecOptions
		const outcome = argvResponder(file, argv, options)
		queueMicrotask(() => ("error" in outcome ? callback(outcome.error) : callback(null, outcome)))
		return undefined
	})

	// spawn は copyDirectoryWithProgress からしか呼ばれない。ここに到達したら
	// テストの前提が崩れているので、即エラーにして黙って進まないようにする。
	spawnMock.mockImplementation(() => {
		const listeners = new Map<string, (arg: unknown) => void>()
		const proc = {
			on(event: string, listener: (arg: unknown) => void) {
				listeners.set(event, listener)
				return proc
			},
		}
		queueMicrotask(() => listeners.get("error")?.(new Error("テストから本物の cp を起動しようとした")))
		return proc
	})

	fsMock.access.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
	fsMock.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
	fsMock.writeFile.mockResolvedValue(undefined)
	fsMock.readdir.mockResolvedValue([])
	fsMock.stat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
	fsMock.mkdir.mockResolvedValue(undefined)
	fsMock.copyFile.mockResolvedValue(undefined)
	fsMock.rm.mockResolvedValue(undefined)
	fsMock.rmdir.mockResolvedValue(undefined)
	fsMock.unlink.mockResolvedValue(undefined)

	executeCommandMock.mockResolvedValue(undefined)
	openTextDocumentMock.mockResolvedValue({ uri: { fsPath: "" } })
	showTextDocumentMock.mockResolvedValue(undefined)

	vscodeState.workspaceFolders = [{ name: "project", uri: { fsPath: WORKSPACE } }]
	vscodeState.workspaceFoldersThrows = false
})

afterEach(() => {
	vi.restoreAllMocks()
})

// ===========================================================================
// 不変条件 1 / 2: 本体ワークスペースを壊しうる経路
// ===========================================================================

describe("worktree handlers - 本体ワークスペースの保護（不変条件 1・2）", () => {
	it("【不変条件】webview が本体ワークスペースのパスを送っても `git worktree remove` に到達しない", async () => {
		// worktreePath は webview 由来。ワークスペース自身が worktree（この機能で
		// switch した後の通常状態）なら、素通しすると **利用者が今開いているディレクトリが
		// 未コミット変更ごと消える**。UI 側の disabled だけに頼らず拡張ホストで止める。
		const { host } = makeHost()

		const result = await handleDeleteWorktree(host, WORKSPACE, true)

		expect(result).toEqual({
			success: false,
			message: `Refusing to remove the worktree currently open: ${WORKSPACE}`,
		})
		// 一覧の取得（exec）までは行くが、破壊側の argv は 1 本も組み立てられない。
		expect(argvLines()).toEqual([])
		expect(execFileMock).not.toHaveBeenCalled()
		expectNoDestructionOf(WORKSPACE, "本体ワークスペースの削除要求")
	})

	it("【不変条件】今開いている linked worktree も削除されない（cwd と一致するものは拒否）", async () => {
		// switch 後は cwd が linked worktree になる。ここが最も壊れやすい配置。
		const { host } = makeHost({ cwd: WORKTREE_A })

		const result = await handleDeleteWorktree(host, WORKTREE_A, true)

		expect(result).toEqual({
			success: false,
			message: `Refusing to remove the worktree currently open: ${WORKTREE_A}`,
		})
		expect(execFileMock).not.toHaveBeenCalled()
	})

	it("【不変条件】git が worktree として報告していないパスは `git worktree remove` に到達しない", async () => {
		// `..` でリポジトリ外を指す文字列。git 任せにせず、listWorktrees の結果に
		// 無いパスは拡張ホストの時点で拒否する。
		const escaping = `${WORKTREE_A}/../../../../../etc`
		const { host } = makeHost()

		const result = await handleDeleteWorktree(host, escaping, true)

		expect(result).toEqual({
			success: false,
			message: `Refusing to remove a path git does not report as a worktree: ${escaping}`,
		})
		expect(argvLines()).toEqual([])
		expect(execFileMock).not.toHaveBeenCalled()
		// 解決すると worktree 置き場の外を指す文字列だった、という前提の確認。
		expect(path.resolve(escaping)).toBe("/etc")
		expect(path.resolve(escaping).startsWith("/home/dev/.agent/worktrees")).toBe(false)
	})

	it("【不変条件】ブランチ名 `.` では git が 1 度も起動されない（未コミット変更が消えない）", async () => {
		// `git checkout .` は cwd（＝provider.cwd＝**本体のワークスペース**）の
		// 未コミット変更を全部捨てる。ブランチ名として妥当でない文字列は
		// git を起動する前に弾く。
		const { host } = makeHost()

		const result = await handleCheckoutBranch(host, ".")

		expect(result).toEqual({ success: false, message: 'Refusing to check out an unsafe branch name: "."' })
		expectNoCommandRan("ブランチ名 .")
	})

	it.each([["-f"], ["--force"], ["--orphan"], ["--"], ["../x"], [""]])(
		"【不変条件】ブランチ名 %j では git が 1 度も起動されない",
		async (branch) => {
			const { host } = makeHost()

			const result = await handleCheckoutBranch(host, branch)

			expect(result).toEqual({
				success: false,
				message: `Refusing to check out an unsafe branch name: ${JSON.stringify(branch)}`,
			})
			expectNoCommandRan(`ブランチ名 ${JSON.stringify(branch)}`)
		},
	)

	it("【不変条件】読み取り系ハンドラは本体ワークスペースを壊す argv を 1 本も出さない", async () => {
		const { host } = makeHost()

		await handleListWorktrees(host)
		await handleGetAvailableBranches(host)
		await handleGetWorktreeIncludeStatus(host)
		await handleCheckBranchWorktreeInclude(host, "feature/x")
		await handleGetWorktreeDefaults(host)

		expectNoDestructionOf(WORKSPACE, "読み取り系")
		// 実際に走ったのは読み取りコマンドだけ。
		expect(shellCalls().map((call) => call.command)).toEqual([
			"git rev-parse --git-dir",
			"git rev-parse --show-toplevel",
			"git rev-parse --show-toplevel",
			"git worktree list --porcelain",
			"git worktree list --porcelain",
			'git branch --format="%(refname:short)"',
			'git branch -r --format="%(refname:short)"',
			"git rev-parse --abbrev-ref HEAD",
		])
		expect(argvLines()).toEqual(["git cat-file -e -- feature/x:.worktreeinclude"])
	})

	it("【不変条件】非 git リポジトリでは worktree を作りに行かない（git が 1 度も起動されない）", async () => {
		gitWorld.isRepo = false
		const { host } = makeHost()

		const result = await handleCreateWorktree(host, { path: "/tmp/wt", branch: "x", createNewBranch: true })

		expect(result).toEqual({ success: false, message: "Not a git repository" })
		// checkGitRepo の 1 本だけで打ち止め。worktree add は組み立てられない。
		expect(shellCalls().map((call) => call.command)).toEqual(["git rev-parse --git-dir"])
		expect(execFileMock).not.toHaveBeenCalled()
		expectNoFileRemoval("非 git リポジトリ")
	})
})

// ===========================================================================
// 不変条件 2: --force と未コミット変更
// ===========================================================================

describe("handleDeleteWorktree - --force の扱い（不変条件 2）", () => {
	it("force 省略時は --force を付けない（未コミット変更があれば git が拒否する）", async () => {
		const { host } = makeHost()

		const result = await handleDeleteWorktree(host, WORKTREE_A)

		expect(result.success).toBe(true)
		expect(argvCalls()[0]).toEqual({ file: "git", args: ["worktree", "remove", WORKTREE_A], cwd: WORKSPACE })
		expectNoDestructionOf(WORKSPACE, "force 省略")
	})

	it("force=true のときだけ --force が付く（未コミット変更・未追跡ファイルごと消える経路）", async () => {
		// webview 側（DeleteWorktreeModal）はチェックボックスを入れたときだけ
		// worktreeForce: true を送る。既定経路は上の「--force なし」で、
		// 未コミット変更があれば git が拒否する。
		const { host } = makeHost()

		await handleDeleteWorktree(host, WORKTREE_A, true)

		expect(argvLines()).toEqual([`git worktree remove --force ${WORKTREE_A}`, "git branch -d feature/x"])
	})

	it("git worktree remove が失敗したらブランチ削除には進まず、失敗を返す", async () => {
		argvResponder = (_file, args) =>
			args[1] === "remove"
				? { error: new Error("contains modified or untracked files") }
				: { stdout: "", stderr: "" }
		const { host } = makeHost()

		const result = await handleDeleteWorktree(host, WORKTREE_A)

		expect(result.success).toBe(false)
		expect(result.message).toContain("Failed to delete worktree: contains modified or untracked files")
		expect(argvLines()).toEqual([`git worktree remove ${WORKTREE_A}`])
	})

	it("ブランチ削除が失敗しても worktree 削除自体は成功として返す（best-effort）", async () => {
		argvResponder = (_file, args) =>
			args[0] === "branch" ? { error: new Error("not fully merged") } : { stdout: "", stderr: "" }
		const { host } = makeHost()

		const result = await handleDeleteWorktree(host, WORKTREE_A, true)

		expect(result).toEqual({ success: true, message: `Worktree removed from ${WORKTREE_A}` })
		expect(argvLines()).toEqual([`git worktree remove --force ${WORKTREE_A}`, "git branch -d feature/x"])
	})

	it("detached HEAD の worktree ではブランチ削除に進まない", async () => {
		gitWorld.porcelain = [
			`worktree ${WORKTREE_A}`,
			"HEAD 2222222222222222222222222222222222222222",
			"detached",
			"",
		].join("\n")
		const { host } = makeHost()

		await handleDeleteWorktree(host, WORKTREE_A, true)

		expect(argvLines()).toEqual([`git worktree remove --force ${WORKTREE_A}`])
	})
})

// ===========================================================================
// handleListWorktrees
// ===========================================================================

describe("handleListWorktrees", () => {
	it("ワークスペースが開かれていなければ git を 1 度も起動しない", async () => {
		vscodeState.workspaceFolders = undefined
		const { host } = makeHost()

		expect(await handleListWorktrees(host)).toEqual({
			worktrees: [],
			isGitRepo: false,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath: "",
			error: "No workspace folder open",
		})
		expectNoCommandRan("workspaceFolders なし")
	})

	it("ワークスペースフォルダが空配列でも同じ扱い", async () => {
		vscodeState.workspaceFolders = []
		const { host } = makeHost()

		expect((await handleListWorktrees(host)).error).toBe("No workspace folder open")
		expectNoCommandRan("workspaceFolders 空")
	})

	it("multi-root ワークスペースでは非対応として git を起動しない", async () => {
		vscodeState.workspaceFolders = [
			{ name: "a", uri: { fsPath: "/a" } },
			{ name: "b", uri: { fsPath: "/b" } },
		]
		const { host } = makeHost()

		expect(await handleListWorktrees(host)).toEqual({
			worktrees: [],
			isGitRepo: false,
			isMultiRoot: true,
			isSubfolder: false,
			gitRootPath: "",
			error: "Worktrees are not supported in multi-root workspaces",
		})
		expectNoCommandRan("multi-root")
	})

	it("git リポジトリでなければ rev-parse --git-dir だけで打ち止め", async () => {
		gitWorld.isRepo = false
		const { host } = makeHost()

		expect(await handleListWorktrees(host)).toEqual({
			worktrees: [],
			isGitRepo: false,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath: "",
			error: "Not a git repository",
		})
		expect(shellCalls().map((call) => call.command)).toEqual(["git rev-parse --git-dir"])
	})

	it("ワークスペースが git ルートのサブフォルダなら非対応として返す", async () => {
		gitWorld.topLevel = "/workspace"
		const { host } = makeHost({ cwd: WORKSPACE })

		expect(await handleListWorktrees(host)).toEqual({
			worktrees: [],
			isGitRepo: true,
			isMultiRoot: false,
			isSubfolder: true,
			gitRootPath: "/workspace",
			error: "Worktrees are not supported when workspace is a subfolder of a git repository",
		})
		// worktree list までは行かない。
		expect(shellCalls().map((call) => call.command)).toEqual([
			"git rev-parse --git-dir",
			"git rev-parse --show-toplevel",
			"git rev-parse --show-toplevel",
		])
	})

	it("【バグ】区切り記号を見ない startsWith 比較なので、兄弟ディレクトリが誤ってサブフォルダ判定される", async () => {
		// handlers.ts:49 は `normalizedCwd.startsWith(normalizedGitRoot)` だけを見る。
		// /workspace-other は /workspace のサブフォルダではないのに true になり、
		// worktree 機能が理由不明で無効化される（破壊は無いが誤判定）。
		gitWorld.topLevel = "/workspace"
		const { host } = makeHost({ cwd: "/workspace-other" })

		const result = await handleListWorktrees(host)

		expect(result.isSubfolder).toBe(true)
		expect(result.error).toContain("subfolder of a git repository")
	})

	it("git ルートと cwd が一致するならサブフォルダ扱いしない", async () => {
		const { host } = makeHost({ cwd: WORKSPACE })

		const result = await handleListWorktrees(host)

		expect(result.isSubfolder).toBe(false)
		expect(result.isGitRepo).toBe(true)
		expect(result.gitRootPath).toBe(WORKSPACE)
		expect(result.worktrees).toEqual([
			{
				path: WORKSPACE,
				branch: "main",
				commitHash: "1111111111111111111111111111111111111111",
				isCurrent: true,
				isBare: false,
				isDetached: false,
				isLocked: false,
			},
			{
				path: WORKTREE_A,
				branch: "feature/x",
				commitHash: "2222222222222222222222222222222222222222",
				isCurrent: false,
				isBare: false,
				isDetached: false,
				isLocked: false,
			},
		])
	})

	it("git ルートが取れなければ gitRootPath は空文字になる", async () => {
		// isRepo は true のまま、rev-parse --show-toplevel だけ失敗する状態
		// （worktree が prune された直後などに起こりうる）。
		gitWorld.topLevel = null
		const { host } = makeHost()

		const result = await handleListWorktrees(host)

		expect(result.gitRootPath).toBe("")
		expect(result.isSubfolder).toBe(false)
		expect(result.isGitRepo).toBe(true)
	})

	it("listWorktrees が Error を投げたらメッセージを載せて返す", async () => {
		vi.spyOn(worktreeService, "listWorktrees").mockRejectedValue(new Error("git exploded"))
		const { host } = makeHost()

		expect(await handleListWorktrees(host)).toEqual({
			worktrees: [],
			isGitRepo: true,
			isMultiRoot: false,
			isSubfolder: false,
			gitRootPath: WORKSPACE,
			error: "Failed to list worktrees: git exploded",
		})
	})

	it("listWorktrees が Error 以外を投げても String 化して返す", async () => {
		vi.spyOn(worktreeService, "listWorktrees").mockRejectedValue("plain-string-failure")
		const { host } = makeHost()

		expect((await handleListWorktrees(host)).error).toBe("Failed to list worktrees: plain-string-failure")
	})
})

// ===========================================================================
// handleCreateWorktree
// ===========================================================================

describe("handleCreateWorktree", () => {
	const createdWorktree: Worktree = {
		path: WORKTREE_A,
		branch: "feature/x",
		commitHash: "2222222222222222222222222222222222222222",
		isCurrent: false,
		isBare: false,
		isDetached: false,
		isLocked: false,
	}

	it("新規ブランチ作成では `git worktree add -b <branch> <path> <base>` を組み立てる", async () => {
		const { host } = makeHost()

		const result = await handleCreateWorktree(host, {
			path: WORKTREE_A,
			branch: "feature/x",
			baseBranch: "main",
			createNewBranch: true,
		})

		expect(argvCalls()).toEqual([
			{ file: "git", args: ["worktree", "add", "-b", "feature/x", WORKTREE_A, "main"], cwd: WORKSPACE },
		])
		expect(result.success).toBe(true)
		expect(result.message).toBe(`Worktree created at ${WORKTREE_A}`)
		expect(result.worktree).toEqual(createdWorktree)
		expectNoDestructionOf(WORKSPACE, "worktree add")
	})

	it("baseBranch 省略時は base を付けない", async () => {
		const { host } = makeHost()

		await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x", createNewBranch: true })

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", "-b", "feature/x", WORKTREE_A])
	})

	it("既存ブランチのチェックアウトでは `git worktree add <path> <branch>`", async () => {
		const { host } = makeHost()

		await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x", createNewBranch: false })

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", WORKTREE_A, "feature/x"])
	})

	it("ブランチ未指定なら --detach", async () => {
		const { host } = makeHost()

		await handleCreateWorktree(host, { path: WORKTREE_A })

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", "--detach", WORKTREE_A])
	})

	it("【現状の挙動】worktree のパスとブランチ名は検証されず、`--` 区切りも無いまま git に届く", async () => {
		// createNewBranch=true の分岐は `-b <branch> <path>` の順で積むので、
		// branch に `--force` のような文字列を入れると git のオプションとして解釈される。
		const { host } = makeHost()

		await handleCreateWorktree(host, {
			path: "../../../tmp/escaped",
			branch: "--force",
			createNewBranch: true,
		})

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", "-b", "--force", "../../../tmp/escaped"])
		// パスは相対のまま渡るので、解決先は cwd 基準で worktree 置き場の外になる。
		expect(path.resolve(WORKSPACE, "../../../tmp/escaped")).toBe("/tmp/escaped")
	})

	it("git worktree add が失敗したら .worktreeinclude のコピーへ進まない", async () => {
		argvResponder = () => ({ error: new Error("fatal: '/x' already exists") })
		const copySpy = vi.spyOn(worktreeIncludeService, "copyWorktreeIncludeFiles")
		const { host } = makeHost()

		const result = await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x" })

		expect(result.success).toBe(false)
		expect(result.message).toContain("Failed to create worktree: fatal: '/x' already exists")
		expect(copySpy).not.toHaveBeenCalled()
	})

	it("作成した worktree が list に現れなければ copy もしない（worktree が undefined）", async () => {
		// git worktree add は成功したが porcelain に出てこない状態。
		gitWorld.porcelain = `worktree ${WORKSPACE}\nHEAD 1111\nbranch refs/heads/main\n`
		const copySpy = vi.spyOn(worktreeIncludeService, "copyWorktreeIncludeFiles")
		const { host } = makeHost()

		const result = await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x" })

		expect(result.success).toBe(true)
		expect(result.worktree).toBeUndefined()
		expect(copySpy).not.toHaveBeenCalled()
	})

	it(".worktreeinclude のコピー対象が 0 件ならメッセージを書き換えない", async () => {
		// fs.access が全部 ENOENT なので copyWorktreeIncludeFiles は [] を返す。
		const { host } = makeHost()

		const result = await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x" })

		expect(result.message).toBe(`Worktree created at ${WORKTREE_A}`)
		// コピー判定は「.worktreeinclude と .gitignore が両方ある」ことの確認から始まる。
		expect(fsMock.access.mock.calls.map((call) => call[0])).toEqual([
			path.join(WORKSPACE, ".worktreeinclude"),
			path.join(WORKSPACE, ".gitignore"),
		])
		expectNoDestructionOf(WORKSPACE, "コピー無し")
	})

	it("コピーした件数をメッセージに追記する", async () => {
		vi.spyOn(worktreeIncludeService, "copyWorktreeIncludeFiles").mockResolvedValue(["node_modules", ".env"])
		const { host } = makeHost()

		const result = await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x" })

		expect(result.message).toBe(`Worktree created at ${WORKTREE_A} (copied 2 item(s) from .worktreeinclude)`)
	})

	it("コピー先は git が報告した worktree のパスで、コピー元は provider.cwd", async () => {
		const copySpy = vi.spyOn(worktreeIncludeService, "copyWorktreeIncludeFiles").mockResolvedValue([])
		const onCopyProgress = vi.fn()
		const { host } = makeHost()

		await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x" }, onCopyProgress)

		expect(copySpy).toHaveBeenCalledExactlyOnceWith(WORKSPACE, WORKTREE_A, onCopyProgress)
	})

	it("進捗コールバックは呼び出し元へそのまま中継される", async () => {
		vi.spyOn(worktreeIncludeService, "copyWorktreeIncludeFiles").mockImplementation(
			async (_source, _target, onProgress) => {
				onProgress?.({ bytesCopied: 1024, itemName: "node_modules" })
				return ["node_modules"]
			},
		)
		const onCopyProgress = vi.fn()
		const { host } = makeHost()

		await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x" }, onCopyProgress)

		expect(onCopyProgress).toHaveBeenCalledExactlyOnceWith({ bytesCopied: 1024, itemName: "node_modules" })
	})

	it("進捗コールバック省略でもコピーは動く", async () => {
		const copySpy = vi.spyOn(worktreeIncludeService, "copyWorktreeIncludeFiles").mockResolvedValue(["x"])
		const { host } = makeHost()

		await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x" })

		expect(copySpy).toHaveBeenCalledExactlyOnceWith(WORKSPACE, WORKTREE_A, undefined)
	})

	it("コピーが失敗しても worktree 作成は成功のまま、警告だけ残す", async () => {
		vi.spyOn(worktreeIncludeService, "copyWorktreeIncludeFiles").mockRejectedValue(new Error("EACCES"))
		const { host, log } = makeHost()

		const result = await handleCreateWorktree(host, { path: WORKTREE_A, branch: "feature/x" })

		expect(result.success).toBe(true)
		expect(result.message).toBe(`Worktree created at ${WORKTREE_A}`)
		expect(log).toHaveBeenCalledExactlyOnceWith("Warning: Failed to copy .worktreeinclude files: Error: EACCES")
	})
})

// ===========================================================================
// handleSwitchWorktree
// ===========================================================================

describe("handleSwitchWorktree", () => {
	it("新しいウィンドウで開くときは自動オープンパスを保存してから openFolder", async () => {
		const { host, setValue } = makeHost()

		const result = await handleSwitchWorktree(host, WORKTREE_A, true)

		expect(setValue).toHaveBeenCalledExactlyOnceWith("worktreeAutoOpenPath", WORKTREE_A)
		expect(executeCommandMock).toHaveBeenCalledExactlyOnceWith(
			"vscode.openFolder",
			{ fsPath: WORKTREE_A, path: WORKTREE_A, scheme: "file" },
			{ forceNewWindow: true },
		)
		expect(result).toEqual({ success: true, message: `Opened worktree at ${WORKTREE_A}` })
		expectNoCommandRan("switch(new window)")
	})

	it("現在のウィンドウで開くときは forceNewWindow=false", async () => {
		const { host, setValue } = makeHost()

		const result = await handleSwitchWorktree(host, WORKTREE_A, false)

		expect(setValue).toHaveBeenCalledExactlyOnceWith("worktreeAutoOpenPath", WORKTREE_A)
		expect(executeCommandMock.mock.calls[0]![2]).toEqual({ forceNewWindow: false })
		expect(result.success).toBe(true)
	})

	it("openFolder が Error で失敗したらメッセージを載せて success:false", async () => {
		executeCommandMock.mockRejectedValue(new Error("window is closing"))
		const { host } = makeHost()

		expect(await handleSwitchWorktree(host, WORKTREE_A, true)).toEqual({
			success: false,
			message: "Failed to switch worktree: window is closing",
		})
	})

	it("Error 以外で失敗しても String 化して返す", async () => {
		executeCommandMock.mockRejectedValue("nope")
		const { host } = makeHost()

		expect((await handleSwitchWorktree(host, WORKTREE_A, true)).message).toBe("Failed to switch worktree: nope")
	})

	it("状態保存が失敗した場合はウィンドウを開かない", async () => {
		const { host, setValue } = makeHost()
		setValue.mockRejectedValue(new Error("storage full"))

		expect((await handleSwitchWorktree(host, WORKTREE_A, false)).success).toBe(false)
		expect(executeCommandMock).not.toHaveBeenCalled()
	})
})

// ===========================================================================
// handleGetAvailableBranches
// ===========================================================================

describe("handleGetAvailableBranches", () => {
	it("worktree に載っているブランチも含めて返す（base branch 選択用）", async () => {
		const { host } = makeHost()

		const result = await handleGetAvailableBranches(host)

		// includeWorktreeBranches=true なので feature/x も残る。
		expect(result).toEqual({
			localBranches: ["main", "feature/x"],
			remoteBranches: ["origin/main"],
			currentBranch: "main",
		})
		expectNoDestructionOf(WORKSPACE, "ブランチ一覧")
	})

	it("git が全部失敗しても空のブランチ一覧を返す", async () => {
		shellResponder = () => ({ error: new Error("git not found") })
		const { host } = makeHost()

		expect(await handleGetAvailableBranches(host)).toEqual({
			localBranches: [],
			remoteBranches: [],
			currentBranch: "",
		})
	})
})

// ===========================================================================
// handleGetWorktreeDefaults
// ===========================================================================

describe("handleGetWorktreeDefaults", () => {
	it("ワークスペース名とランダム接尾辞から候補パスを組む", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		const { host } = makeHost()

		const result = await handleGetWorktreeDefaults(host)

		expect(result).toEqual({
			suggestedBranch: "worktree/roo-aaaaa",
			suggestedPath: path.join(os.homedir(), ".agent", "worktrees", "project-aaaaa"),
		})
		expectNoCommandRan("既定値の生成")
	})

	it("接尾辞は 5 文字で、乱数の値が変われば中身も変わる", async () => {
		// Math.floor(0.999 * 36) = 35 → 文字集合の最後 "9"。
		vi.spyOn(Math, "random").mockReturnValue(0.999)
		const { host } = makeHost()

		const result = await handleGetWorktreeDefaults(host)

		expect(result.suggestedBranch).toBe("worktree/roo-99999")
		expect(result.suggestedBranch.replace("worktree/roo-", "")).toHaveLength(5)
	})

	it.each([
		["ワークスペース未オープン", undefined],
		["ワークスペースフォルダが空", [] as Array<{ name: string; uri: { fsPath: string } }>],
	])("%s なら project という名前にフォールバックする", async (_label, folders) => {
		vscodeState.workspaceFolders = folders
		vi.spyOn(Math, "random").mockReturnValue(0)
		const { host } = makeHost()

		expect((await handleGetWorktreeDefaults(host)).suggestedPath).toBe(
			path.join(os.homedir(), ".agent", "worktrees", "project-aaaaa"),
		)
	})

	it("【バグ】ワークスペース名が検証されないため、候補パスが ~/.agent/worktrees の外へ出る", async () => {
		// handlers.ts:227,230 は workspaceFolders[0].name をそのまま path.join に渡す。
		// VS Code のワークスペースフォルダ名は .code-workspace の `name` で任意に付けられ、
		// path.join が `..` を畳むため候補パスが worktree 置き場の外を指す。
		// この候補パスはそのまま createWorktree の path になりうる。
		vscodeState.workspaceFolders = [{ name: "../../../../tmp/pwned", uri: { fsPath: WORKSPACE } }]
		vi.spyOn(Math, "random").mockReturnValue(0)
		const { host } = makeHost()

		const { suggestedPath } = await handleGetWorktreeDefaults(host)

		const worktreesRoot = path.join(os.homedir(), ".agent", "worktrees")
		expect(suggestedPath.startsWith(`${worktreesRoot}${path.sep}`)).toBe(false)
		expect(suggestedPath.endsWith(path.join("tmp", "pwned-aaaaa"))).toBe(true)
	})
})

// ===========================================================================
// .worktreeinclude 系
// ===========================================================================

describe("handleGetWorktreeIncludeStatus", () => {
	it("両方無ければ exists / hasGitignore ともに false", async () => {
		const { host } = makeHost()

		expect(await handleGetWorktreeIncludeStatus(host)).toEqual({
			exists: false,
			hasGitignore: false,
			gitignoreContent: undefined,
		})
		expect(fsMock.access).toHaveBeenCalledExactlyOnceWith(path.join(WORKSPACE, ".worktreeinclude"))
		expect(fsMock.readFile).toHaveBeenCalledExactlyOnceWith(path.join(WORKSPACE, ".gitignore"), "utf-8")
		expectNoCommandRan("include status")
	})

	it("両方あれば .gitignore の中身まで返す", async () => {
		fsMock.access.mockResolvedValue(undefined)
		fsMock.readFile.mockResolvedValue("node_modules\n.env\n")
		const { host } = makeHost()

		expect(await handleGetWorktreeIncludeStatus(host)).toEqual({
			exists: true,
			hasGitignore: true,
			gitignoreContent: "node_modules\n.env\n",
		})
	})
})

describe("handleCheckBranchWorktreeInclude", () => {
	it("`git cat-file -e -- <branch>:.worktreeinclude` で存在を確認する", async () => {
		const { host } = makeHost()

		expect(await handleCheckBranchWorktreeInclude(host, "feature/x")).toBe(true)
		expect(argvCalls()).toEqual([
			{ file: "git", args: ["cat-file", "-e", "--", "feature/x:.worktreeinclude"], cwd: WORKSPACE },
		])
	})

	it("ファイルが無い（cat-file が失敗する）なら false", async () => {
		argvResponder = () => ({ error: new Error("Not a valid object name") })
		const { host } = makeHost()

		expect(await handleCheckBranchWorktreeInclude(host, "feature/x")).toBe(false)
	})

	it("ブランチ名にオプションらしき文字列が来ても `--` の後ろに置かれる", async () => {
		// ここは worktree-include.ts 側が `--` を入れているので、checkout と違い
		// オプションとして解釈されない。差が出ていることを固定しておく。
		const { host } = makeHost()

		await handleCheckBranchWorktreeInclude(host, "--force")

		expect(argvCalls()[0]!.args).toEqual(["cat-file", "-e", "--", "--force:.worktreeinclude"])
	})
})

describe("handleCreateWorktreeInclude", () => {
	it(".worktreeinclude を書いてエディタで開く", async () => {
		const { host } = makeHost()

		const result = await handleCreateWorktreeInclude(host, "node_modules\n")

		expect(fsMock.writeFile).toHaveBeenCalledExactlyOnceWith(
			path.join(WORKSPACE, ".worktreeinclude"),
			"node_modules\n",
			"utf-8",
		)
		expect(openTextDocumentMock).toHaveBeenCalledExactlyOnceWith(path.join(WORKSPACE, ".worktreeinclude"))
		expect(showTextDocumentMock).toHaveBeenCalledOnce()
		expect(result).toEqual({ success: true, message: ".worktreeinclude file created" })
		// 書き込むのは .worktreeinclude ただ 1 ファイルで、削除は一切しない。
		expectNoFileRemoval("createWorktreeInclude")
		expectNoCommandRan("createWorktreeInclude")
	})

	it("エディタで開けなくても成功として返す（利便機能なので握り潰す）", async () => {
		openTextDocumentMock.mockRejectedValue(new Error("no editor"))
		const { host } = makeHost()

		expect(await handleCreateWorktreeInclude(host, "x")).toEqual({
			success: true,
			message: ".worktreeinclude file created",
		})
		expect(showTextDocumentMock).not.toHaveBeenCalled()
	})

	it("書き込みが Error で失敗したらメッセージを載せて success:false", async () => {
		fsMock.writeFile.mockRejectedValue(new Error("EROFS"))
		const { host } = makeHost()

		expect(await handleCreateWorktreeInclude(host, "x")).toEqual({
			success: false,
			message: "Failed to create .worktreeinclude: EROFS",
		})
		expect(openTextDocumentMock).not.toHaveBeenCalled()
	})

	it("Error 以外で失敗しても String 化して返す", async () => {
		fsMock.writeFile.mockRejectedValue("disk-is-gone")
		const { host } = makeHost()

		expect((await handleCreateWorktreeInclude(host, "x")).message).toBe(
			"Failed to create .worktreeinclude: disk-is-gone",
		)
	})
})

// ===========================================================================
// handleCheckoutBranch
// ===========================================================================

describe("handleCheckoutBranch", () => {
	it("【不変条件】通常のブランチ名は `git checkout <branch> --` になる（末尾の `--` で pathspec 解釈を封じる）", async () => {
		const { host } = makeHost()

		expect(await handleCheckoutBranch(host, "feature/x")).toEqual({
			success: true,
			message: "Checked out branch feature/x",
		})
		expect(argvCalls()).toEqual([{ file: "git", args: ["checkout", "feature/x", "--"], cwd: WORKSPACE }])
		expectNoDestructionOf(WORKSPACE, "通常の checkout")
	})

	it("チェックアウトが失敗したらメッセージを載せて success:false", async () => {
		argvResponder = () => ({ error: new Error("local changes would be overwritten") })
		const { host } = makeHost()

		const result = await handleCheckoutBranch(host, "feature/x")

		expect(result.success).toBe(false)
		expect(result.message).toContain("Failed to checkout branch: local changes would be overwritten")
	})
})
