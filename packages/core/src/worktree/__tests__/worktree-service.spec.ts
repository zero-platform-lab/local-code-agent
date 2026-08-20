// npx vitest run src/worktree/__tests__/worktree-service.spec.ts
//
// WorktreeService は webview 由来の文字列（ブランチ名・worktree のパス）を
// そのまま git の argv に載せる層。取り返しがつかない操作が並ぶので、
// ここで固定するのは次の 4 点:
//
//   1. **不変条件**: ブランチ名として妥当でない文字列では git を 1 度も起動しない
//      （`.` は pathspec、`-f` / `--orphan` はオプションとして解釈され、
//      どちらも「ブランチ切り替え」ではなく作業ツリーの破壊になる）
//   2. **不変条件**: `git checkout` の argv は末尾に `--` を置き、
//      pathspec としての解釈を封じる
//   3. **不変条件**: `git worktree remove` は「git が worktree として報告したパス」
//      かつ「今開いているディレクトリではない」ものにしか到達しない
//   4. git に渡る argv を全件アサートする
//
// **本物の git は絶対に起動しない。** child_process の exec / execFile を vi.mock し、
// 「1 度も起動されていない」ことをアサートできるようにしている。

import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { WorktreeService, isPlausibleBranchName } from "../worktree-service.js"

// ---------------------------------------------------------------------------
// モック: 実プロセスへの経路を塞ぐ
// ---------------------------------------------------------------------------

const { execMock, execFileMock } = vi.hoisted(() => ({
	execMock: vi.fn(),
	execFileMock: vi.fn(),
}))

// worktree-service.ts は `import { exec, execFile } from "child_process"`。
// promisify() はモジュール読み込み時に評価されるので、hoist 済みのこのモックが先に入る。
vi.mock("child_process", () => {
	const api = { exec: execMock, execFile: execFileMock }
	return { ...api, default: api }
})

// ---------------------------------------------------------------------------
// 定数とテスト用の git 世界
// ---------------------------------------------------------------------------

/** 今開いているディレクトリ（main working tree）。**ここを消す argv が出たら不変条件違反。** */
const CWD = "/repo"
/** 別ディレクトリに作られた linked worktree。 */
const WORKTREE_A = "/wt/a"

const DEFAULT_PORCELAIN = [
	`worktree ${CWD}`,
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
	version: "git version 2.45.0\n" as string | null,
	isRepo: true,
	topLevel: CWD as string | null,
	currentBranch: "main" as string | null,
	porcelain: DEFAULT_PORCELAIN as string | null,
	localBranches: "main\nfeature/x\n" as string | null,
	remoteBranches: "origin/main\norigin/HEAD -> origin/main\n" as string | null,
}

function ok(stdout: string): CommandOutcome {
	return { stdout, stderr: "" }
}

function orFail(value: string | null, message: string): CommandOutcome {
	return value === null ? { error: new Error(message) } : ok(value)
}

/** `exec("<コマンド文字列>")` の応答。既定は gitWorld から組み立てる。 */
let shellResponder: (command: string, options: ExecOptions) => CommandOutcome
/** `execFile("git", argv)` の応答。既定は成功（空出力）。 */
let argvResponder: (file: string, args: string[], options: ExecOptions) => CommandOutcome

function defaultShellResponder(command: string): CommandOutcome {
	switch (command) {
		case "git --version":
			return orFail(gitWorld.version, "git: command not found")
		case "git rev-parse --git-dir":
			return gitWorld.isRepo ? ok(".git\n") : { error: new Error("not a git repository") }
		case "git rev-parse --show-toplevel":
			return orFail(gitWorld.topLevel === null ? null : `${gitWorld.topLevel}\n`, "not a git repository")
		case "git rev-parse --abbrev-ref HEAD":
			return orFail(gitWorld.currentBranch === null ? null : `${gitWorld.currentBranch}\n`, "no HEAD")
		case "git worktree list --porcelain":
			return orFail(gitWorld.porcelain, "worktree list failed")
		case 'git branch --format="%(refname:short)"':
			return orFail(gitWorld.localBranches, "branch listing failed")
		case 'git branch -r --format="%(refname:short)"':
			return orFail(gitWorld.remoteBranches, "remote branch listing failed")
		default:
			return { error: new Error(`テストが想定していないコマンド: ${command}`) }
	}
}

// ---------------------------------------------------------------------------
// 記録の取り出しヘルパ
// ---------------------------------------------------------------------------

interface ArgvCall {
	file: string
	args: string[]
	cwd?: string
}

/** exec に渡ったシェルコマンド文字列を呼ばれた順に全件返す。 */
function shellCommands(): string[] {
	return execMock.mock.calls.map((call) => call[0] as string)
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
}

// ---------------------------------------------------------------------------

let service: WorktreeService

beforeEach(() => {
	vi.clearAllMocks()

	gitWorld.version = "git version 2.45.0\n"
	gitWorld.isRepo = true
	gitWorld.topLevel = CWD
	gitWorld.currentBranch = "main"
	gitWorld.porcelain = DEFAULT_PORCELAIN
	gitWorld.localBranches = "main\nfeature/x\n"
	gitWorld.remoteBranches = "origin/main\norigin/HEAD -> origin/main\n"

	shellResponder = (command) => defaultShellResponder(command)
	argvResponder = () => ok("")

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

	service = new WorktreeService()
})

afterEach(() => {
	vi.restoreAllMocks()
})

// ===========================================================================
// isPlausibleBranchName（不変条件 1 の土台）
// ===========================================================================

describe("isPlausibleBranchName", () => {
	// 破壊につながる形。ここが true になると git がブランチ名以外として解釈する。
	it.each([
		["空文字", ""],
		["ハイフン単体", "-"],
		["短いオプション", "-f"],
		["長いオプション", "--force"],
		["ブランチを作るオプション", "--orphan"],
		["end-of-options 区切りそのもの", "--"],
		["カレントディレクトリ（pathspec になる）", "."],
		["親ディレクトリ", ".."],
		["親へ抜けるパス", "../x"],
		["途中に親要素を挟むパス", "a/../b"],
		["末尾が親要素", "a/.."],
		["途中にカレント要素を挟むパス", "a/./b"],
		["先頭がカレント要素", "./x"],
		["末尾がカレント要素", "a/."],
		["空白入り", "feature x"],
		["タブ入り", "feature\tx"],
		["改行入り", "feature\nx"],
		["チルダ", "feature~1"],
		["キャレット", "feature^1"],
		["コロン", "origin:main"],
		["クエスチョン", "feature?"],
		["アスタリスク", "feature*"],
		["角括弧開き", "feature[1"],
		["角括弧閉じ", "feature]1"],
		["バックスラッシュ", "feature\\x"],
		["NUL 文字", "feature\0x"],
	])("%s は拒否する: %j", (_label, branch) => {
		expect(isPlausibleBranchName(branch)).toBe(false)
	})

	// string ですらないもの（webview からは何でも飛んでくる）。
	it.each([
		["undefined", undefined],
		["null", null],
		["数値", 123],
		["オブジェクト", {}],
		["配列", ["main"]],
	])("%s は拒否する", (_label, branch) => {
		expect(isPlausibleBranchName(branch)).toBe(false)
	})

	// 実際に使われる形は通す。ここが false になると機能が壊れる。
	it.each([
		["単純な名前", "main"],
		["スラッシュ入り", "feature/x"],
		["深い階層", "release/2026/07"],
		["ドット入り", "v1.2.3"],
		["途中のハイフン", "fix-typo"],
		["アンダースコア", "wip_stuff"],
		["非 ASCII", "機能/日本語ブランチ"],
	])("%s は許可する: %j", (_label, branch) => {
		expect(isPlausibleBranchName(branch)).toBe(true)
	})
})

// ===========================================================================
// checkoutBranch（不変条件 1・2）
// ===========================================================================

describe("checkoutBranch", () => {
	it.each([[""], ["-f"], ["--force"], ["--orphan"], ["--"], ["."], ["../x"], ["a b"]])(
		"【不変条件】ブランチ名 %j では git が 1 度も起動されない",
		async (branch) => {
			const result = await service.checkoutBranch(CWD, branch)

			expect(result).toEqual({
				success: false,
				message: `Refusing to check out an unsafe branch name: ${JSON.stringify(branch)}`,
			})
			expectNoCommandRan(`checkoutBranch ${JSON.stringify(branch)}`)
		},
	)

	it("【不変条件】argv は `checkout <branch> --` で終わる（末尾の `--` が pathspec 解釈を封じる）", async () => {
		const result = await service.checkoutBranch(CWD, "feature/x")

		expect(result).toEqual({ success: true, message: "Checked out branch feature/x" })
		expect(argvCalls()).toEqual([{ file: "git", args: ["checkout", "feature/x", "--"], cwd: CWD }])
		// `--` の後ろには何も無い＝pathspec は 1 件も渡っていない。
		expect(argvCalls()[0]!.args.slice(argvCalls()[0]!.args.indexOf("--") + 1)).toEqual([])
	})

	it("git checkout が Error で失敗したらメッセージを載せて success:false", async () => {
		argvResponder = () => ({ error: new Error("local changes would be overwritten") })

		expect(await service.checkoutBranch(CWD, "feature/x")).toEqual({
			success: false,
			message: "Failed to checkout branch: local changes would be overwritten",
		})
	})

	it("Error 以外で失敗しても String 化して返す", async () => {
		argvResponder = () => ({ error: "checkout blew up" })

		expect((await service.checkoutBranch(CWD, "feature/x")).message).toBe(
			"Failed to checkout branch: checkout blew up",
		)
	})
})

// ===========================================================================
// deleteWorktree（不変条件 3）
// ===========================================================================

describe("deleteWorktree", () => {
	it("【不変条件】git が worktree として報告していないパスでは remove を組み立てない", async () => {
		const stranger = "/etc"

		const result = await service.deleteWorktree(CWD, stranger, true)

		expect(result).toEqual({
			success: false,
			message: `Refusing to remove a path git does not report as a worktree: ${stranger}`,
		})
		// 一覧の取得（exec）までは行くが、破壊側の argv は 1 本も出ない。
		expect(shellCommands()).toEqual(["git worktree list --porcelain"])
		expect(execFileMock).not.toHaveBeenCalled()
	})

	it("【不変条件】`..` でリポジトリ外へ抜ける文字列も remove に到達しない", async () => {
		const escaping = `${WORKTREE_A}/../../../../../etc`

		const result = await service.deleteWorktree(CWD, escaping, true)

		expect(result.success).toBe(false)
		expect(result.message).toBe(`Refusing to remove a path git does not report as a worktree: ${escaping}`)
		expect(execFileMock).not.toHaveBeenCalled()
	})

	it("【不変条件】今開いているディレクトリ（cwd と同じ worktree）は削除しない", async () => {
		const result = await service.deleteWorktree(CWD, CWD, true)

		expect(result).toEqual({
			success: false,
			message: `Refusing to remove the worktree currently open: ${CWD}`,
		})
		expect(execFileMock).not.toHaveBeenCalled()
	})

	it("【不変条件】cwd が linked worktree のときも、その worktree 自身は削除しない", async () => {
		// この機能で switch した後の通常状態。git 側の歯止めは「main working tree か」
		// しか見ないので、ここを通すと利用者が今開いているディレクトリが消える。
		const result = await service.deleteWorktree(WORKTREE_A, WORKTREE_A, true)

		expect(result).toEqual({
			success: false,
			message: `Refusing to remove the worktree currently open: ${WORKTREE_A}`,
		})
		expect(execFileMock).not.toHaveBeenCalled()
	})

	it("【不変条件】末尾スラッシュ付きで送られても cwd 一致として拒否する（正規化して比較）", async () => {
		const result = await service.deleteWorktree(CWD, `${CWD}/`, true)

		expect(result.success).toBe(false)
		expect(result.message).toBe(`Refusing to remove the worktree currently open: ${CWD}/`)
		expect(execFileMock).not.toHaveBeenCalled()
	})

	it("force 省略時は --force を付けない（未コミット変更があれば git が拒否できる）", async () => {
		const result = await service.deleteWorktree(CWD, WORKTREE_A)

		expect(result).toEqual({ success: true, message: `Worktree removed from ${WORKTREE_A}` })
		expect(argvLines()).toEqual([`git worktree remove ${WORKTREE_A}`, "git branch -d feature/x"])
		expect(argvCalls().every((call) => call.cwd === CWD)).toBe(true)
	})

	it("force=true のときだけ --force が付く", async () => {
		await service.deleteWorktree(CWD, WORKTREE_A, true)

		expect(argvLines()).toEqual([`git worktree remove --force ${WORKTREE_A}`, "git branch -d feature/x"])
	})

	it("detached HEAD の worktree ではブランチ削除に進まない", async () => {
		gitWorld.porcelain = [
			`worktree ${WORKTREE_A}`,
			"HEAD 2222222222222222222222222222222222222222",
			"detached",
			"",
		].join("\n")

		await service.deleteWorktree(CWD, WORKTREE_A, true)

		expect(argvLines()).toEqual([`git worktree remove --force ${WORKTREE_A}`])
	})

	it("ブランチ削除が失敗しても worktree 削除自体は成功として返す（best-effort）", async () => {
		argvResponder = (_file, args) => (args[0] === "branch" ? { error: new Error("not fully merged") } : ok(""))

		const result = await service.deleteWorktree(CWD, WORKTREE_A)

		expect(result).toEqual({ success: true, message: `Worktree removed from ${WORKTREE_A}` })
		expect(argvLines()).toEqual([`git worktree remove ${WORKTREE_A}`, "git branch -d feature/x"])
	})

	it("git worktree remove が Error で失敗したらブランチ削除に進まず失敗を返す", async () => {
		argvResponder = (_file, args) =>
			args[1] === "remove" ? { error: new Error("contains modified or untracked files") } : ok("")

		const result = await service.deleteWorktree(CWD, WORKTREE_A)

		expect(result).toEqual({
			success: false,
			message: "Failed to delete worktree: contains modified or untracked files",
		})
		expect(argvLines()).toEqual([`git worktree remove ${WORKTREE_A}`])
	})

	it("Error 以外で失敗しても String 化して返す", async () => {
		argvResponder = () => ({ error: "remove blew up" })

		expect((await service.deleteWorktree(CWD, WORKTREE_A)).message).toBe(
			"Failed to delete worktree: remove blew up",
		)
	})

	it("worktree 一覧が取れない（git が失敗する）ときは remove を組み立てない", async () => {
		gitWorld.porcelain = null

		const result = await service.deleteWorktree(CWD, WORKTREE_A, true)

		expect(result.success).toBe(false)
		expect(result.message).toBe(`Refusing to remove a path git does not report as a worktree: ${WORKTREE_A}`)
		expect(execFileMock).not.toHaveBeenCalled()
	})
})

// ===========================================================================
// createWorktree
// ===========================================================================

describe("createWorktree", () => {
	const createdWorktree = {
		path: WORKTREE_A,
		branch: "feature/x",
		commitHash: "2222222222222222222222222222222222222222",
		isCurrent: false,
		isBare: false,
		isDetached: false,
		isLocked: false,
	}

	it("新規ブランチ作成では `worktree add -b <branch> <path> <base>`", async () => {
		const result = await service.createWorktree(CWD, {
			path: WORKTREE_A,
			branch: "feature/x",
			baseBranch: "main",
			createNewBranch: true,
		})

		expect(argvCalls()[0]).toEqual({
			file: "git",
			args: ["worktree", "add", "-b", "feature/x", WORKTREE_A, "main"],
			cwd: CWD,
		})
		expect(result).toEqual({
			success: true,
			message: `Worktree created at ${WORKTREE_A}`,
			worktree: createdWorktree,
		})
	})

	it("baseBranch 省略時は base を付けない", async () => {
		await service.createWorktree(CWD, { path: WORKTREE_A, branch: "feature/x", createNewBranch: true })

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", "-b", "feature/x", WORKTREE_A])
	})

	it("既存ブランチのチェックアウトでは `worktree add <path> <branch>`", async () => {
		await service.createWorktree(CWD, { path: WORKTREE_A, branch: "feature/x", createNewBranch: false })

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", WORKTREE_A, "feature/x"])
	})

	it("createNewBranch=true でもブランチ未指定なら --detach", async () => {
		await service.createWorktree(CWD, { path: WORKTREE_A, createNewBranch: true })

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", "--detach", WORKTREE_A])
	})

	it("ブランチ未指定なら --detach", async () => {
		await service.createWorktree(CWD, { path: WORKTREE_A })

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", "--detach", WORKTREE_A])
	})

	it("作成した worktree が一覧に現れなければ worktree は undefined", async () => {
		gitWorld.porcelain = `worktree ${CWD}\nHEAD 1111\nbranch refs/heads/main\n`

		const result = await service.createWorktree(CWD, { path: WORKTREE_A, branch: "feature/x" })

		expect(result.success).toBe(true)
		expect(result.worktree).toBeUndefined()
	})

	it("git worktree add が Error で失敗したらメッセージを載せて success:false", async () => {
		argvResponder = () => ({ error: new Error("fatal: destination path already exists") })

		expect(await service.createWorktree(CWD, { path: WORKTREE_A, branch: "feature/x" })).toEqual({
			success: false,
			message: "Failed to create worktree: fatal: destination path already exists",
		})
	})

	it("Error 以外で失敗しても String 化して返す", async () => {
		argvResponder = () => ({ error: "add blew up" })

		expect((await service.createWorktree(CWD, { path: WORKTREE_A })).message).toBe(
			"Failed to create worktree: add blew up",
		)
	})
})

// ===========================================================================
// 読み取り系
// ===========================================================================

describe("checkGitInstalled", () => {
	it("git --version が通れば true", async () => {
		expect(await service.checkGitInstalled()).toBe(true)
		expect(shellCommands()).toEqual(["git --version"])
	})

	it("git が無ければ false", async () => {
		gitWorld.version = null

		expect(await service.checkGitInstalled()).toBe(false)
	})
})

describe("checkGitRepo", () => {
	it("rev-parse --git-dir が通れば true", async () => {
		expect(await service.checkGitRepo(CWD)).toBe(true)
		expect(shellCommands()).toEqual(["git rev-parse --git-dir"])
	})

	it("git リポジトリでなければ false", async () => {
		gitWorld.isRepo = false

		expect(await service.checkGitRepo(CWD)).toBe(false)
	})
})

describe("getGitRootPath", () => {
	it("toplevel を trim して返す", async () => {
		expect(await service.getGitRootPath(CWD)).toBe(CWD)
	})

	it("失敗したら null", async () => {
		gitWorld.topLevel = null

		expect(await service.getGitRootPath(CWD)).toBeNull()
	})
})

describe("getCurrentWorktreePath", () => {
	it("toplevel を trim して返す", async () => {
		expect(await service.getCurrentWorktreePath(CWD)).toBe(CWD)
	})

	it("失敗したら null", async () => {
		gitWorld.topLevel = null

		expect(await service.getCurrentWorktreePath(CWD)).toBeNull()
	})
})

describe("getCurrentBranch", () => {
	it("ブランチ名を返す", async () => {
		expect(await service.getCurrentBranch(CWD)).toBe("main")
	})

	it("detached HEAD（出力が HEAD）なら null", async () => {
		gitWorld.currentBranch = "HEAD"

		expect(await service.getCurrentBranch(CWD)).toBeNull()
	})

	it("失敗したら null", async () => {
		gitWorld.currentBranch = null

		expect(await service.getCurrentBranch(CWD)).toBeNull()
	})
})

describe("listWorktrees", () => {
	it("porcelain 出力を Worktree[] にして返す", async () => {
		const result = await service.listWorktrees(CWD)

		expect(result).toEqual([
			{
				path: CWD,
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

	it("git が失敗したら空配列", async () => {
		gitWorld.porcelain = null

		expect(await service.listWorktrees(CWD)).toEqual([])
	})
})

describe("getAvailableBranches", () => {
	it("既定では worktree に載っているブランチを除外する", async () => {
		const result = await service.getAvailableBranches(CWD)

		// main と feature/x はどちらも worktree に載っているので消える。
		expect(result).toEqual({ localBranches: [], remoteBranches: [], currentBranch: "main" })
	})

	it("includeWorktreeBranches=true なら worktree のブランチも残す", async () => {
		const result = await service.getAvailableBranches(CWD, true)

		expect(result).toEqual({
			localBranches: ["main", "feature/x"],
			// `origin/HEAD -> origin/main` は HEAD を含むので落ちる。
			remoteBranches: ["origin/main"],
			currentBranch: "main",
		})
		expect(shellCommands()).toEqual([
			"git worktree list --porcelain",
			'git branch --format="%(refname:short)"',
			'git branch -r --format="%(refname:short)"',
			"git rev-parse --abbrev-ref HEAD",
		])
	})

	it("worktree に載っていないブランチだけが残る（除外の対象判定）", async () => {
		gitWorld.localBranches = "main\nfeature/x\nsolo\n"
		gitWorld.remoteBranches = "origin/main\norigin/solo\n"

		expect(await service.getAvailableBranches(CWD)).toEqual({
			localBranches: ["solo"],
			remoteBranches: ["origin/solo"],
			currentBranch: "main",
		})
	})

	it("detached HEAD の worktree（branch が空）は除外集合に入らない", async () => {
		gitWorld.porcelain = [`worktree ${WORKTREE_A}`, "HEAD 2222", "detached", ""].join("\n")

		expect(await service.getAvailableBranches(CWD)).toEqual({
			localBranches: ["main", "feature/x"],
			remoteBranches: ["origin/main"],
			currentBranch: "main",
		})
	})

	it("現在ブランチが取れなければ空文字にする", async () => {
		gitWorld.currentBranch = "HEAD"

		expect((await service.getAvailableBranches(CWD, true)).currentBranch).toBe("")
	})

	it("git が失敗したら空の一覧を返す", async () => {
		gitWorld.localBranches = null

		expect(await service.getAvailableBranches(CWD)).toEqual({
			localBranches: [],
			remoteBranches: [],
			currentBranch: "",
		})
	})
})

// ===========================================================================
// private ヘルパ
// ===========================================================================

describe("parseWorktreeOutput", () => {
	// Access private method for testing
	const callParseWorktreeOutput = (output: string, currentCwd: string) => {
		// @ts-expect-error - accessing private method for testing
		return service.parseWorktreeOutput(output, currentCwd) as Array<Record<string, unknown>>
	}

	it("should parse porcelain output correctly", () => {
		const output = `worktree /home/user/repo
HEAD abc123def456
branch refs/heads/main

worktree /home/user/repo-feature
HEAD def456abc123
branch refs/heads/feature/test
`
		const result = callParseWorktreeOutput(output, "/home/user/repo")

		expect(result).toHaveLength(2)
		expect(result[0]).toMatchObject({
			path: "/home/user/repo",
			branch: "main",
			commitHash: "abc123def456",
			isCurrent: true,
		})
		expect(result[1]).toMatchObject({
			path: "/home/user/repo-feature",
			branch: "feature/test",
			commitHash: "def456abc123",
			isCurrent: false,
		})
	})

	it("should handle detached HEAD worktrees", () => {
		const output = `worktree /home/user/repo-detached
HEAD abc123def456
detached
`
		const result = callParseWorktreeOutput(output, "/home/user/other")

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			path: "/home/user/repo-detached",
			isDetached: true,
			branch: "",
		})
	})

	it("should handle locked worktrees", () => {
		const output = `worktree /home/user/repo-locked
HEAD abc123def456
branch refs/heads/locked-branch
locked some reason here
`
		const result = callParseWorktreeOutput(output, "/home/user/other")

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			isLocked: true,
			lockReason: "some reason here",
		})
	})

	it("理由なしの locked 行でも isLocked になる（lockReason は付かない）", () => {
		const output = `worktree /home/user/repo-locked
HEAD abc123def456
branch refs/heads/locked-branch
locked
`
		const result = callParseWorktreeOutput(output, "/home/user/other")

		expect(result[0]).toMatchObject({ isLocked: true })
		expect(result[0]!.lockReason).toBeUndefined()
	})

	it("should handle bare worktrees", () => {
		const output = `worktree /home/user/repo.git
bare
`
		const result = callParseWorktreeOutput(output, "/home/user/other")

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			path: "/home/user/repo.git",
			isBare: true,
		})
	})

	it("空白だけのエントリは読み飛ばす", () => {
		// 区切りの空行が余分にあると split で空白だけのエントリができる。
		const output = [
			"worktree /home/user/repo",
			"HEAD abc123def456",
			"branch refs/heads/main",
			"",
			" ",
			"",
			"worktree /home/user/repo-feature",
			"HEAD def456abc123",
			"branch refs/heads/feature/test",
			"",
		].join("\n")

		const result = callParseWorktreeOutput(output, "/home/user/repo")

		expect(result).toHaveLength(2)
		expect(result.map((worktree) => worktree.path)).toEqual(["/home/user/repo", "/home/user/repo-feature"])
	})

	it("worktree 行を欠くエントリは読み飛ばす", () => {
		const output = [
			"worktree /home/user/repo",
			"HEAD abc123def456",
			"branch refs/heads/main",
			"",
			"HEAD deadbeefdeadbeef",
			"branch refs/heads/orphan",
			"",
		].join("\n")

		const result = callParseWorktreeOutput(output, "/home/user/repo")

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ path: "/home/user/repo" })
	})

	it("知らない行は無視する", () => {
		const output = `worktree /home/user/repo
HEAD abc123def456
branch refs/heads/main
prunable gitdir file points to non-existent location
`
		const result = callParseWorktreeOutput(output, "/home/user/repo")

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({ path: "/home/user/repo", branch: "main" })
	})
})

describe("normalizePath", () => {
	// Access private method for testing
	const callNormalizePath = (p: string): string => {
		// @ts-expect-error - accessing private method for testing
		return service.normalizePath(p)
	}

	it("should normalize paths with trailing slashes", () => {
		expect(callNormalizePath("/home/user/project/")).toBe(path.normalize("/home/user/project"))
	})

	it("should normalize paths with multiple trailing slashes", () => {
		// path.normalize already handles multiple slashes
		expect(callNormalizePath("/home/user/project///")).toBe(path.normalize("/home/user/project"))
	})

	it("should preserve root path /", () => {
		// This is a critical test - the old regex would turn "/" into ""
		// On Windows, path.normalize("/") returns "\", on Unix it returns "/"
		expect(callNormalizePath("/")).toBe(path.sep)
	})

	it("should handle paths without trailing slashes", () => {
		expect(callNormalizePath("/home/user/project")).toBe(path.normalize("/home/user/project"))
	})

	it("should handle relative paths", () => {
		expect(callNormalizePath("./some/path/")).toBe(path.normalize("./some/path"))
	})

	it("should handle empty string", () => {
		expect(callNormalizePath("")).toBe(".")
	})

	it("should handle Windows-style paths on non-Windows", () => {
		// path.normalize will convert separators appropriately
		expect(callNormalizePath("C:\\Users\\test\\project")).toBeTruthy()
	})
})
