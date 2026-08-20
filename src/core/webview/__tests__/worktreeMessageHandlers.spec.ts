// npx vitest run core/webview/__tests__/worktreeMessageHandlers.spec.ts
//
// src/core/webview/worktreeMessageHandlers.ts は webview メッセージを worktree
// ハンドラへ橋渡しするグルー層。C0 8.1%（194 行未実行）で、失敗経路も
// 「webview に必ず結果を返す」という設計上の約束も一度も検証されていなかった。
//
// ここで固定するのは次の 5 点:
//   1. **本体のワークスペースディレクトリを壊す操作が飛ばないこと。**
//      webview の文字列が git argv になる手前で拡張ホストが弾き、
//      弾かれた入力では git が 1 度も起動されない
//   2. 未コミットの変更を持つ worktree を消すときの `--force` の扱い
//      （webview が worktreeForce を立てたときだけ `--force` が付く）
//   3. git に渡る argv を全件アサートする（webview メッセージ → git argv の端から端まで）
//   4. どの経路でも webview へ必ず 1 通の結果メッセージが返ること
//      （返さないと webview が応答待ちのまま固まる、とファイル冒頭のコメントが宣言している）
//   5. 省略可能フィールド（worktreeForce / worktreeNewWindow / worktreeIncludeContent）の既定値
//
// **本物の git は絶対に起動しない。** child_process（exec / execFile / spawn）と
// fs/promises と vscode を vi.mock している。一方 worktree ハンドラと
// @openai-agent/core の worktreeService は本物を通すので、記録される argv は実物と同じ。

import * as os from "os"
import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { worktreeService, worktreeIncludeService } from "@openai-agent/core"
import type { ExtensionMessage, WebviewMessage } from "@openai-agent/types"

import type { ContextProxy } from "../../config/ContextProxy"
import type { WebviewMessageHost } from "../webviewMessageHost"
import { worktreeMessageHandlers } from "../worktreeMessageHandlers"

// ---------------------------------------------------------------------------
// モック: 実プロセスと実ファイルへの経路を全部塞ぐ
// ---------------------------------------------------------------------------

const { execMock, execFileMock, spawnMock } = vi.hoisted(() => ({
	execMock: vi.fn(),
	execFileMock: vi.fn(),
	spawnMock: vi.fn(),
}))

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

const { executeCommandMock, openTextDocumentMock, showTextDocumentMock, showOpenDialogMock, joinPathMock } = vi.hoisted(
	() => ({
		executeCommandMock: vi.fn(),
		openTextDocumentMock: vi.fn(),
		showTextDocumentMock: vi.fn(),
		showOpenDialogMock: vi.fn(),
		joinPathMock: vi.fn(),
	}),
)

vi.mock("vscode", () => {
	const workspace = {
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
		window: {
			showTextDocument: showTextDocumentMock,
			showOpenDialog: showOpenDialogMock,
		},
		commands: { executeCommand: executeCommandMock },
		Uri: {
			file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
			joinPath: joinPathMock,
		},
	}
	return { ...api, default: api }
})

// t() はキーをそのまま返す。showOpenDialog に渡る値を厳密に比較したいため。
vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

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

const gitWorld = {
	isRepo: true,
	topLevel: WORKSPACE as string | null,
	currentBranch: "main" as string | null,
	porcelain: DEFAULT_PORCELAIN,
	localBranches: "main\nfeature/x\n",
	remoteBranches: "origin/main\norigin/HEAD -> origin/main\n",
}

let shellResponder: (command: string, options: ExecOptions) => CommandOutcome
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

/** argv を 1 行に潰す（比較用）。 */
function argvLines(): string[] {
	return argvCalls().map(({ file, args }) => [file, ...args].join(" "))
}

/** **外部プロセスが 1 度も起動されていないこと。** */
function expectNoCommandRan(label: string): void {
	expect(execMock, `${label}: exec`).not.toHaveBeenCalled()
	expect(execFileMock, `${label}: execFile`).not.toHaveBeenCalled()
	expect(spawnMock, `${label}: spawn`).not.toHaveBeenCalled()
}

/** ファイル削除 API はこの層からは決して呼ばれない。 */
function expectNoFileRemoval(label: string): void {
	expect(fsMock.rm, `${label}: fs.rm`).not.toHaveBeenCalled()
	expect(fsMock.rmdir, `${label}: fs.rmdir`).not.toHaveBeenCalled()
	expect(fsMock.unlink, `${label}: fs.unlink`).not.toHaveBeenCalled()
}

/**
 * **不変条件 1**: `dir`（＝本体のワークスペース）を壊す操作が 1 件も飛んでいないこと。
 * 判定基準は worktreeHandlers.spec.ts と同じ。
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
			// `--` は end-of-options 区切り。その後ろは全部 pathspec なので 1 件でもあれば
			// 「ブランチ切り替え」ではなく「作業ツリーの巻き戻し」になる。
			const separator = rest.indexOf("--")
			const revisions = separator === -1 ? rest : rest.slice(0, separator)
			const pathspecs = separator === -1 ? [] : rest.slice(separator + 1)

			expect(pathspecs, `${where}: pathspec が付いている`).toEqual([])

			for (const operand of revisions) {
				expect(operand === "." || operand === "..", where).toBe(false)
				expect(operand.startsWith("-"), where).toBe(false)
				expect(path.isAbsolute(operand) && path.resolve(operand).startsWith(resolvedDir), where).toBe(false)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// ホスト / メッセージの贋物
// ---------------------------------------------------------------------------

/** ハンドラが実際に触る WebviewMessageHost の面。ここが痩せていれば型ドリフトは拾える。 */
type WorktreeHostSurface = Pick<WebviewMessageHost, "cwd" | "log" | "postMessageToWebview" | "contextProxy">

function makeProvider(options: { cwd?: string } = {}) {
	const postMessageToWebview = vi.fn(async (_message: ExtensionMessage): Promise<unknown> => undefined)
	const log = vi.fn()
	const setValue = vi.fn(async () => {})

	const surface: WorktreeHostSurface = {
		cwd: options.cwd ?? WORKSPACE,
		log,
		postMessageToWebview,
		contextProxy: { setValue } as unknown as ContextProxy,
	}

	return {
		provider: surface as unknown as WebviewMessageHost,
		postMessageToWebview,
		log,
		setValue,
		/** webview へ流れたメッセージを全件返す。 */
		posted: () => postMessageToWebview.mock.calls.map(([message]) => message),
	}
}

/**
 * 指定の type のハンドラを呼ぶ。未登録なら（＝リファクタで取りこぼしたなら）ここで落ちる。
 */
async function dispatch(provider: WebviewMessageHost, message: WebviewMessage): Promise<void> {
	const handler = worktreeMessageHandlers[message.type]
	expect(handler, `${message.type} のハンドラが登録されていない`).toBeTypeOf("function")
	await handler!(provider, message)
}

/** 指定フィールドの読み出しで例外を投げるメッセージ。ハンドラ内の catch へ届かせる用。 */
function messageWithThrowingField(type: WebviewMessage["type"], field: string, error: unknown): WebviewMessage {
	const message = { type } as WebviewMessage
	Object.defineProperty(message, field, {
		get: () => {
			throw error
		},
	})
	return message
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

	// promisify(exec) は util.promisify.custom を持たないモックに対しては
	// 「コールバックの第 2 引数」をそのまま解決値にする。実物に合わせて
	// { stdout, stderr } を返す。
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
	showOpenDialogMock.mockResolvedValue(undefined)
	joinPathMock.mockImplementation((uri: { fsPath: string }, ...segments: string[]) => {
		const joined = path.join(uri.fsPath, ...segments)
		return { fsPath: joined, path: joined, scheme: "file" }
	})

	vscodeState.workspaceFolders = [{ name: "project", uri: { fsPath: WORKSPACE } }]
	vscodeState.workspaceFoldersThrows = false
})

afterEach(() => {
	vi.restoreAllMocks()
})

// ===========================================================================
// 不変条件 1 / 2 / 3: webview の文字列 → git argv
// ===========================================================================

describe("worktreeMessageHandlers - 本体ワークスペースの保護（不変条件 1・2・3）", () => {
	it("【不変条件】webview が本体ワークスペースのパスを送っても `git worktree remove` に到達しない", async () => {
		// UI 側（DeleteWorktreeModal / WorktreesView）が isCurrent を disabled に
		// しているだけでは足りない。ワークスペース自身が worktree のとき、素通しすると
		// **利用者が今開いているディレクトリが未コミット変更ごと消える**。
		const h = makeProvider()

		await dispatch(h.provider, { type: "deleteWorktree", worktreePath: WORKSPACE, worktreeForce: true })

		expect(argvLines()).toEqual([])
		expect(execFileMock).not.toHaveBeenCalled()
		expect(h.posted()).toEqual([
			{
				type: "worktreeResult",
				success: false,
				text: `Refusing to remove the worktree currently open: ${WORKSPACE}`,
			},
		])
	})

	it("【不変条件】今開いている linked worktree のパスを送っても削除されない", async () => {
		// switch 後は cwd が linked worktree になる。ここが最も壊れやすい配置。
		const h = makeProvider({ cwd: WORKTREE_A })

		await dispatch(h.provider, { type: "deleteWorktree", worktreePath: WORKTREE_A, worktreeForce: true })

		expect(execFileMock).not.toHaveBeenCalled()
		expect(h.posted()).toEqual([
			{
				type: "worktreeResult",
				success: false,
				text: `Refusing to remove the worktree currently open: ${WORKTREE_A}`,
			},
		])
	})

	it("worktreeForce=true のときだけ --force になる（未コミット変更・未追跡ファイルが消える経路）", async () => {
		// webview（DeleteWorktreeModal）はチェックボックスを入れたときだけ true を送る。
		// 既定経路は下の「--force なし」で、未コミット変更があれば git が拒否する。
		const h = makeProvider()

		await dispatch(h.provider, { type: "deleteWorktree", worktreePath: WORKTREE_A, worktreeForce: true })

		expect(argvLines()).toEqual([`git worktree remove --force ${WORKTREE_A}`, "git branch -d feature/x"])
	})

	it("worktreeForce 省略時は --force を付けない（git が未コミット変更を理由に拒否できる）", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "deleteWorktree", worktreePath: WORKTREE_A })

		expect(argvLines()).toEqual([`git worktree remove ${WORKTREE_A}`, "git branch -d feature/x"])
		expectNoDestructionOf(WORKSPACE, "force 省略")
	})

	it("【不変条件】worktreeBranch=`.` では git が 1 度も起動されない（未コミット変更が消えない）", async () => {
		// `git checkout .` は `.` が pathspec として解釈され、
		// cwd（＝provider.cwd＝本体のワークスペース）の未コミット変更を全部捨てる。
		// ブランチ名として妥当でない文字列は git を起動する前に弾く。
		const h = makeProvider()

		await dispatch(h.provider, { type: "checkoutBranch", worktreeBranch: "." })

		expectNoCommandRan("worktreeBranch=.")
		expect(h.posted()).toEqual([
			{ type: "worktreeResult", success: false, text: 'Refusing to check out an unsafe branch name: "."' },
		])
	})

	it.each([["-f"], ["--force"], ["--orphan"], ["--"], ["../x"], [""]])(
		"【不変条件】worktreeBranch=%j でも git が 1 度も起動されない",
		async (branch) => {
			const h = makeProvider()

			await dispatch(h.provider, { type: "checkoutBranch", worktreeBranch: branch })

			expectNoCommandRan(`worktreeBranch=${JSON.stringify(branch)}`)
			expect(h.posted()).toEqual([
				{
					type: "worktreeResult",
					success: false,
					text: `Refusing to check out an unsafe branch name: ${JSON.stringify(branch)}`,
				},
			])
		},
	)

	it("【不変条件】git が worktree として報告していない `..` 入りのパスは削除に到達しない", async () => {
		const escaping = `${WORKTREE_A}/../../../../../etc`
		const h = makeProvider()

		await dispatch(h.provider, { type: "deleteWorktree", worktreePath: escaping, worktreeForce: true })

		expect(argvLines()).toEqual([])
		expect(execFileMock).not.toHaveBeenCalled()
		expect(h.posted()).toEqual([
			{
				type: "worktreeResult",
				success: false,
				text: `Refusing to remove a path git does not report as a worktree: ${escaping}`,
			},
		])
		// 解決すると worktree 置き場の外を指す文字列だった、という前提の確認。
		expect(path.resolve(escaping)).toBe("/etc")
	})

	it("【不変条件】読み取り系メッセージを一巡しても本体ワークスペースを壊す argv は 1 本も出ない", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "listWorktrees" })
		await dispatch(h.provider, { type: "getAvailableBranches" })
		await dispatch(h.provider, { type: "getWorktreeIncludeStatus" })
		await dispatch(h.provider, { type: "checkBranchWorktreeInclude", worktreeBranch: "feature/x" })
		await dispatch(h.provider, { type: "getWorktreeDefaults" })
		await dispatch(h.provider, { type: "browseForWorktreePath" })

		expectNoDestructionOf(WORKSPACE, "読み取り系")
		expect(argvLines()).toEqual(["git cat-file -e -- feature/x:.worktreeinclude"])
		expect(shellCommands()).toEqual([
			"git rev-parse --git-dir",
			"git rev-parse --show-toplevel",
			"git rev-parse --show-toplevel",
			"git worktree list --porcelain",
			"git worktree list --porcelain",
			'git branch --format="%(refname:short)"',
			'git branch -r --format="%(refname:short)"',
			"git rev-parse --abbrev-ref HEAD",
		])
	})

	it("【不変条件】非 git リポジトリでは createWorktree が git を 1 度も起動しない", async () => {
		gitWorld.isRepo = false
		const h = makeProvider()

		await dispatch(h.provider, {
			type: "createWorktree",
			worktreePath: "/tmp/wt",
			worktreeBranch: "x",
			worktreeCreateNewBranch: true,
		})

		expect(shellCommands()).toEqual(["git rev-parse --git-dir"])
		expect(execFileMock).not.toHaveBeenCalled()
		expect(h.posted()).toEqual([{ type: "worktreeResult", success: false, text: "Not a git repository" }])
	})
})

// ===========================================================================
// 不変条件 4: webview へ必ず結果を返す
// ===========================================================================

describe("worktreeMessageHandlers - 例外時も webview へ必ず 1 通返す（不変条件 4）", () => {
	// ファイル冒頭のコメントが「返さないと webview 側が応答待ちのまま固まる」と
	// 明言している。各ハンドラの catch がその約束を守っているかを型ごとに固定する。

	it("listWorktrees: git 判定が投げても worktreeList を返す", async () => {
		vi.spyOn(worktreeService, "checkGitRepo").mockRejectedValue(new Error("git binary missing"))
		const h = makeProvider()

		await dispatch(h.provider, { type: "listWorktrees" })

		expect(h.posted()).toEqual([
			{
				type: "worktreeList",
				worktrees: [],
				isGitRepo: false,
				isMultiRoot: false,
				isSubfolder: false,
				gitRootPath: "",
				error: "git binary missing",
			},
		])
	})

	it("listWorktrees: Error 以外が投げられても String 化して返す", async () => {
		vi.spyOn(worktreeService, "checkGitRepo").mockRejectedValue("exec-failure")
		const h = makeProvider()

		await dispatch(h.provider, { type: "listWorktrees" })

		expect((h.posted()[0] as ExtensionMessage).error).toBe("exec-failure")
	})

	it("createWorktree: 例外は worktreeResult(success:false) になる", async () => {
		vi.spyOn(worktreeService, "createWorktree").mockRejectedValue(new Error("ENOSPC"))
		const h = makeProvider()

		await dispatch(h.provider, { type: "createWorktree", worktreePath: WORKTREE_A })

		expect(h.posted()).toEqual([{ type: "worktreeResult", success: false, text: "ENOSPC" }])
	})

	it("deleteWorktree: 例外は worktreeResult(success:false) になる", async () => {
		vi.spyOn(worktreeService, "deleteWorktree").mockRejectedValue(new Error("EBUSY"))
		const h = makeProvider()

		await dispatch(h.provider, { type: "deleteWorktree", worktreePath: WORKTREE_A })

		expect(h.posted()).toEqual([{ type: "worktreeResult", success: false, text: "EBUSY" }])
	})

	it("switchWorktree: 例外は worktreeResult(success:false) になる", async () => {
		// handleSwitchWorktree 自身は全経路を try/catch で包んでいて決して throw しない。
		// この catch に届くのはメッセージの読み出しが壊れているときだけ。
		const h = makeProvider()
		const message = messageWithThrowingField("switchWorktree", "worktreePath", new Error("broken message"))

		await dispatch(h.provider, message)

		expect(h.posted()).toEqual([{ type: "worktreeResult", success: false, text: "broken message" }])
		expectNoCommandRan("switchWorktree の例外")
	})

	it("getAvailableBranches: 例外でも空の branchList を返す", async () => {
		vi.spyOn(worktreeService, "getAvailableBranches").mockRejectedValue(new Error("git gone"))
		const h = makeProvider()

		await dispatch(h.provider, { type: "getAvailableBranches" })

		expect(h.posted()).toEqual([
			{
				type: "branchList",
				localBranches: [],
				remoteBranches: [],
				currentBranch: "",
				error: "git gone",
			},
		])
	})

	it("getWorktreeDefaults: 例外でも空の worktreeDefaults を返す", async () => {
		vscodeState.workspaceFoldersThrows = true
		const h = makeProvider()

		await dispatch(h.provider, { type: "getWorktreeDefaults" })

		expect(h.posted()).toEqual([
			{
				type: "worktreeDefaults",
				suggestedBranch: "",
				suggestedPath: "",
				error: "workspaceFolders unavailable",
			},
		])
	})

	it("getWorktreeIncludeStatus: 例外でも空の状態を返す", async () => {
		vi.spyOn(worktreeIncludeService, "getStatus").mockRejectedValue(new Error("EPERM"))
		const h = makeProvider()

		await dispatch(h.provider, { type: "getWorktreeIncludeStatus" })

		expect(h.posted()).toEqual([
			{
				type: "worktreeIncludeStatus",
				worktreeIncludeStatus: { exists: false, hasGitignore: false, gitignoreContent: undefined },
				error: "EPERM",
			},
		])
	})

	it("checkBranchWorktreeInclude: 例外でも hasWorktreeInclude:false を返す", async () => {
		vi.spyOn(worktreeIncludeService, "branchHasWorktreeInclude").mockRejectedValue(new Error("bad ref"))
		const h = makeProvider()

		await dispatch(h.provider, { type: "checkBranchWorktreeInclude", worktreeBranch: "feature/x" })

		expect(h.posted()).toEqual([
			{ type: "branchWorktreeIncludeResult", hasWorktreeInclude: false, error: "bad ref" },
		])
	})

	it("createWorktreeInclude: 例外は log に残したうえで worktreeResult を返す", async () => {
		// handleCreateWorktreeInclude 自身も全経路を try/catch で包んでいるため、
		// ここに届くのはメッセージの読み出しが壊れているときだけ。
		const h = makeProvider()
		const message = messageWithThrowingField(
			"createWorktreeInclude",
			"worktreeIncludeContent",
			new Error("broken message"),
		)

		await dispatch(h.provider, message)

		expect(h.log).toHaveBeenCalledExactlyOnceWith("Error creating worktree include: broken message")
		expect(h.posted()).toEqual([{ type: "worktreeResult", success: false, text: "broken message" }])
		expect(fsMock.writeFile).not.toHaveBeenCalled()
	})

	it("checkoutBranch: 例外は worktreeResult(success:false) になる", async () => {
		vi.spyOn(worktreeService, "checkoutBranch").mockRejectedValue("checkout blew up")
		const h = makeProvider()

		await dispatch(h.provider, { type: "checkoutBranch", worktreeBranch: "feature/x" })

		expect(h.posted()).toEqual([{ type: "worktreeResult", success: false, text: "checkout blew up" }])
	})

	it("【現状の挙動】browseForWorktreePath だけは例外時に webview へ何も返さない（log のみ）", async () => {
		// フォルダ選択は webview 側が応答を待ち続ける作りではないため、
		// このハンドラだけ「必ず返す」規約から外れている。現状を固定しておく。
		showOpenDialogMock.mockRejectedValue(new Error("dialog crashed"))
		const h = makeProvider()

		await dispatch(h.provider, { type: "browseForWorktreePath" })

		expect(h.posted()).toEqual([])
		expect(h.log).toHaveBeenCalledExactlyOnceWith("Error opening folder picker: dialog crashed")
	})
})

// ===========================================================================
// 正常系（メッセージ → git argv → webview への返信）
// ===========================================================================

describe("listWorktrees", () => {
	it("worktree 一覧とリポジトリ状態をそのまま webview へ返す", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "listWorktrees" })

		expect(h.posted()).toEqual([
			{
				type: "worktreeList",
				worktrees: [
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
				],
				isGitRepo: true,
				isMultiRoot: false,
				isSubfolder: false,
				gitRootPath: WORKSPACE,
				error: undefined,
			},
		])
	})

	it("非対応状態（multi-root）でも error 付きで 1 通返す", async () => {
		vscodeState.workspaceFolders = [
			{ name: "a", uri: { fsPath: "/a" } },
			{ name: "b", uri: { fsPath: "/b" } },
		]
		const h = makeProvider()

		await dispatch(h.provider, { type: "listWorktrees" })

		expect(h.posted()).toEqual([
			{
				type: "worktreeList",
				worktrees: [],
				isGitRepo: false,
				isMultiRoot: true,
				isSubfolder: false,
				gitRootPath: "",
				error: "Worktrees are not supported in multi-root workspaces",
			},
		])
		expectNoCommandRan("multi-root")
	})
})

describe("createWorktree", () => {
	it("メッセージの各フィールドが `git worktree add` の argv になる", async () => {
		const h = makeProvider()

		await dispatch(h.provider, {
			type: "createWorktree",
			worktreePath: WORKTREE_A,
			worktreeBranch: "feature/x",
			worktreeBaseBranch: "main",
			worktreeCreateNewBranch: true,
		})

		expect(argvCalls()).toEqual([
			{ file: "git", args: ["worktree", "add", "-b", "feature/x", WORKTREE_A, "main"], cwd: WORKSPACE },
		])
		expect(h.posted()).toEqual([
			{ type: "worktreeResult", success: true, text: `Worktree created at ${WORKTREE_A}` },
		])
		expectNoDestructionOf(WORKSPACE, "createWorktree")
	})

	it("createNewBranch なしなら既存ブランチのチェックアウト形になる", async () => {
		const h = makeProvider()

		await dispatch(h.provider, {
			type: "createWorktree",
			worktreePath: WORKTREE_A,
			worktreeBranch: "feature/x",
		})

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", WORKTREE_A, "feature/x"])
	})

	it("ブランチ未指定なら --detach", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "createWorktree", worktreePath: WORKTREE_A })

		expect(argvCalls()[0]!.args).toEqual(["worktree", "add", "--detach", WORKTREE_A])
	})

	it("コピー進捗は worktreeCopyProgress として逐次 webview へ流れる", async () => {
		vi.spyOn(worktreeIncludeService, "copyWorktreeIncludeFiles").mockImplementation(
			async (_source, _target, onProgress) => {
				onProgress?.({ bytesCopied: 0, itemName: "node_modules" })
				onProgress?.({ bytesCopied: 4096, itemName: "node_modules" })
				return ["node_modules"]
			},
		)
		const h = makeProvider()

		await dispatch(h.provider, { type: "createWorktree", worktreePath: WORKTREE_A, worktreeBranch: "feature/x" })

		expect(h.posted()).toEqual([
			{ type: "worktreeCopyProgress", copyProgressBytesCopied: 0, copyProgressItemName: "node_modules" },
			{ type: "worktreeCopyProgress", copyProgressBytesCopied: 4096, copyProgressItemName: "node_modules" },
			{
				type: "worktreeResult",
				success: true,
				text: `Worktree created at ${WORKTREE_A} (copied 1 item(s) from .worktreeinclude)`,
			},
		])
	})

	it("git worktree add が失敗したら success:false のまま返す", async () => {
		argvResponder = () => ({ error: new Error("fatal: destination path already exists") })
		const h = makeProvider()

		await dispatch(h.provider, { type: "createWorktree", worktreePath: WORKTREE_A, worktreeBranch: "feature/x" })

		const posted = h.posted()[0] as ExtensionMessage
		expect(posted.type).toBe("worktreeResult")
		expect(posted.success).toBe(false)
		expect(posted.text).toContain("Failed to create worktree: fatal: destination path already exists")
	})
})

describe("switchWorktree", () => {
	it("worktreeNewWindow 省略時は新しいウィンドウで開く（既定 true）", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "switchWorktree", worktreePath: WORKTREE_A })

		expect(h.setValue).toHaveBeenCalledExactlyOnceWith("worktreeAutoOpenPath", WORKTREE_A)
		expect(executeCommandMock).toHaveBeenCalledExactlyOnceWith(
			"vscode.openFolder",
			{ fsPath: WORKTREE_A, path: WORKTREE_A, scheme: "file" },
			{ forceNewWindow: true },
		)
		expect(h.posted()).toEqual([
			{ type: "worktreeResult", success: true, text: `Opened worktree at ${WORKTREE_A}` },
		])
		expectNoCommandRan("switchWorktree")
	})

	it("worktreeNewWindow=false なら現在のウィンドウで開く", async () => {
		const h = makeProvider()

		await dispatch(h.provider, {
			type: "switchWorktree",
			worktreePath: WORKTREE_A,
			worktreeNewWindow: false,
		})

		expect(executeCommandMock.mock.calls[0]![2]).toEqual({ forceNewWindow: false })
	})

	it("openFolder が失敗したら success:false を返す（例外にはしない）", async () => {
		executeCommandMock.mockRejectedValue(new Error("window is closing"))
		const h = makeProvider()

		await dispatch(h.provider, { type: "switchWorktree", worktreePath: WORKTREE_A })

		expect(h.posted()).toEqual([
			{ type: "worktreeResult", success: false, text: "Failed to switch worktree: window is closing" },
		])
	})
})

describe("getAvailableBranches", () => {
	it("ローカル / リモート / 現在ブランチを branchList として返す", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "getAvailableBranches" })

		expect(h.posted()).toEqual([
			{
				type: "branchList",
				localBranches: ["main", "feature/x"],
				remoteBranches: ["origin/main"],
				currentBranch: "main",
			},
		])
	})
})

describe("getWorktreeDefaults", () => {
	it("候補ブランチ名と候補パスを返す", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		const h = makeProvider()

		await dispatch(h.provider, { type: "getWorktreeDefaults" })

		expect(h.posted()).toEqual([
			{
				type: "worktreeDefaults",
				suggestedBranch: "worktree/roo-aaaaa",
				suggestedPath: path.join(os.homedir(), ".agent", "worktrees", "project-aaaaa"),
			},
		])
		expectNoCommandRan("getWorktreeDefaults")
	})
})

describe("getWorktreeIncludeStatus", () => {
	it(".worktreeinclude と .gitignore の有無を返す", async () => {
		fsMock.access.mockResolvedValue(undefined)
		fsMock.readFile.mockResolvedValue("node_modules\n")
		const h = makeProvider()

		await dispatch(h.provider, { type: "getWorktreeIncludeStatus" })

		expect(h.posted()).toEqual([
			{
				type: "worktreeIncludeStatus",
				worktreeIncludeStatus: { exists: true, hasGitignore: true, gitignoreContent: "node_modules\n" },
			},
		])
	})
})

describe("checkBranchWorktreeInclude", () => {
	it("ブランチが空なら git を起動せずエラーを返す", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "checkBranchWorktreeInclude" })

		expect(h.posted()).toEqual([
			{ type: "branchWorktreeIncludeResult", hasWorktreeInclude: false, error: "No branch specified" },
		])
		expectNoCommandRan("ブランチ未指定")
	})

	it("空文字のブランチも「未指定」として扱う", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "checkBranchWorktreeInclude", worktreeBranch: "" })

		expect((h.posted()[0] as ExtensionMessage).error).toBe("No branch specified")
		expectNoCommandRan("空文字ブランチ")
	})

	it("ブランチ上に .worktreeinclude があれば true をブランチ名付きで返す", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "checkBranchWorktreeInclude", worktreeBranch: "feature/x" })

		expect(argvCalls()).toEqual([
			{ file: "git", args: ["cat-file", "-e", "--", "feature/x:.worktreeinclude"], cwd: WORKSPACE },
		])
		expect(h.posted()).toEqual([
			{ type: "branchWorktreeIncludeResult", branch: "feature/x", hasWorktreeInclude: true },
		])
	})

	it("ブランチ上に無ければ false", async () => {
		argvResponder = () => ({ error: new Error("Not a valid object name") })
		const h = makeProvider()

		await dispatch(h.provider, { type: "checkBranchWorktreeInclude", worktreeBranch: "feature/x" })

		expect(h.posted()).toEqual([
			{ type: "branchWorktreeIncludeResult", branch: "feature/x", hasWorktreeInclude: false },
		])
	})
})

describe("createWorktreeInclude", () => {
	it("内容をワークスペース直下の .worktreeinclude へ書く", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "createWorktreeInclude", worktreeIncludeContent: "node_modules\n" })

		expect(fsMock.writeFile).toHaveBeenCalledExactlyOnceWith(
			path.join(WORKSPACE, ".worktreeinclude"),
			"node_modules\n",
			"utf-8",
		)
		expect(h.posted()).toEqual([{ type: "worktreeResult", success: true, text: ".worktreeinclude file created" }])
		// 書くのは 1 ファイルだけ。削除も git 実行もしない。
		expectNoFileRemoval("createWorktreeInclude")
		expectNoCommandRan("createWorktreeInclude")
	})

	it("内容が未指定なら空文字を書き込む", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "createWorktreeInclude" })

		expect(fsMock.writeFile).toHaveBeenCalledExactlyOnceWith(path.join(WORKSPACE, ".worktreeinclude"), "", "utf-8")
	})

	it("書き込みが失敗したら success:false で返し、log は出さない", async () => {
		// 失敗は handleCreateWorktreeInclude 側で結果に変換されるので、
		// このハンドラの catch（＝log を出す経路）には入らない。
		fsMock.writeFile.mockRejectedValue(new Error("EROFS"))
		const h = makeProvider()

		await dispatch(h.provider, { type: "createWorktreeInclude", worktreeIncludeContent: "x" })

		expect(h.posted()).toEqual([
			{ type: "worktreeResult", success: false, text: "Failed to create .worktreeinclude: EROFS" },
		])
		expect(h.log).not.toHaveBeenCalled()
	})
})

describe("checkoutBranch", () => {
	it("【不変条件】ブランチ名は `git checkout <branch> --` になり、結果を webview へ返す", async () => {
		const h = makeProvider()

		await dispatch(h.provider, { type: "checkoutBranch", worktreeBranch: "feature/x" })

		expect(argvCalls()).toEqual([{ file: "git", args: ["checkout", "feature/x", "--"], cwd: WORKSPACE }])
		expect(h.posted()).toEqual([{ type: "worktreeResult", success: true, text: "Checked out branch feature/x" }])
		expectNoDestructionOf(WORKSPACE, "通常の checkout")
	})

	it("git checkout が失敗したら success:false で返す", async () => {
		argvResponder = () => ({ error: new Error("local changes would be overwritten") })
		const h = makeProvider()

		await dispatch(h.provider, { type: "checkoutBranch", worktreeBranch: "feature/x" })

		const posted = h.posted()[0] as ExtensionMessage
		expect(posted.success).toBe(false)
		expect(posted.text).toContain("Failed to checkout branch: local changes would be overwritten")
	})
})

describe("browseForWorktreePath", () => {
	it("フォルダ選択ダイアログをワークスペースの 1 つ上を既定位置にして開く", async () => {
		showOpenDialogMock.mockResolvedValue([{ fsPath: "/picked/dir" }])
		const h = makeProvider()

		await dispatch(h.provider, { type: "browseForWorktreePath" })

		expect(showOpenDialogMock).toHaveBeenCalledExactlyOnceWith({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: "worktrees:selectWorktreeLocation",
			title: "worktrees:selectFolderForWorktree",
			defaultUri: { fsPath: "/workspace", path: "/workspace", scheme: "file" },
		})
		expect(joinPathMock).toHaveBeenCalledExactlyOnceWith({ fsPath: WORKSPACE }, "..")
		expect(h.posted()).toEqual([{ type: "folderSelected", path: "/picked/dir" }])
		expectNoCommandRan("browseForWorktreePath")
	})

	it("ワークスペースが開かれていなければ既定位置なしで開く", async () => {
		vscodeState.workspaceFolders = undefined
		showOpenDialogMock.mockResolvedValue([{ fsPath: "/picked/dir" }])
		const h = makeProvider()

		await dispatch(h.provider, { type: "browseForWorktreePath" })

		expect(showOpenDialogMock.mock.calls[0]![0].defaultUri).toBeUndefined()
		expect(joinPathMock).not.toHaveBeenCalled()
	})

	it("キャンセル（undefined）なら webview へ何も返さない", async () => {
		showOpenDialogMock.mockResolvedValue(undefined)
		const h = makeProvider()

		await dispatch(h.provider, { type: "browseForWorktreePath" })

		expect(h.posted()).toEqual([])
	})

	it("空配列が返っても webview へ何も返さない", async () => {
		showOpenDialogMock.mockResolvedValue([])
		const h = makeProvider()

		await dispatch(h.provider, { type: "browseForWorktreePath" })

		expect(h.posted()).toEqual([])
	})
})
