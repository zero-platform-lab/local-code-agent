// npx vitest run core/tools/__tests__/ExecuteCommandTool.invariants.spec.ts
//
// execute_command は **任意のシェルコマンドを実行する** ツール。C0 53.2% / C1 69.2% /
// 関数 50%（194 行が未実行）で、承認拒否・タイムアウト・中断・巨大出力といった
// 「事故が起きる側」の経路がまったく試されていなかった。
//
// ここで固定するのは次の 6 点:
//   1. 利用者が拒否したらコマンドは 1 度も起動されない（ターミナル生成も execa も呼ばれない）
//   2. 承認ゲート（askApproval）を通らない文字列は実行されない。かつ承認を求めた文字列と
//      実際に走る文字列が同一である（TOCTOU で別物にすり替わらない）
//   3. cwd の解決規則（絶対 / 相対 / 存在しない）。**ワークスペース外チェックは存在しない**
//      ので、その現状を characterization test として明示的に固定する
//   4. 非 0 終了・シグナル終了・exit code 不明が、モデルに返る結果へ必ず載る
//   5. 中断（ユーザタイムアウト / エージェントタイムアウト / 例外）でプロセスが放置されない
//   6. 巨大出力の打ち切り（UI バッファ 100KB 上限 / ディスク退避時の要約フォーマット）
//
// 本物のシェルは絶対に起動しない。ターミナル層（TerminalRegistry / Terminal /
// OutputInterceptor）はすべて vi.mock し、execa もモックして「呼ばれていないこと」を
// アサートできるようにしている。

import * as path from "path"

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import * as vscode from "vscode"

import type { CommandExecutionStatus } from "@openai-agent/types"

import type { AgentTerminalCallbacks, ExitCodeDetails } from "../../../integrations/terminal/types"
import { getCommandDecision } from "../../auto-approval/commands"

// --- モック定義 -------------------------------------------------------------

// 実プロセスを絶対に起動しないための最後の砦。ExecuteCommandTool 自身は execa を
// import しないが、ターミナル層の差し替えが甘いと ExecaTerminal 経由で到達しうる。
vi.mock("execa", () => ({ execa: vi.fn() }))

vi.mock("fs/promises", () => {
	const api = {
		access: vi.fn(async (..._a: unknown[]) => undefined),
		readFile: vi.fn(async (..._a: unknown[]) => ""),
		writeFile: vi.fn(async (..._a: unknown[]) => undefined),
		mkdir: vi.fn(async (..._a: unknown[]) => undefined),
	}
	return { ...api, default: api }
})

vi.mock("../../../i18n", () => ({
	t: (key: string, args?: Record<string, unknown>) => `${key}(${JSON.stringify(args ?? {})})`,
}))

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(async (base: string, taskId: string) => `${base}/tasks/${taskId}`),
}))

vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { getOrCreateTerminal: vi.fn() },
}))

vi.mock("../../../integrations/terminal/Terminal", () => {
	// compressTerminalOutput は BaseTerminal の static。既定では素通し（identity）に
	// しておき、「どこで打ち切られたか」をテスト側で直接観測できるようにする。
	// クラス名を import 名と衝突させない（ssr 変換が factory 内の識別子を
	// import バインディングに書き換えてしまうため）
	class MockTerminal {
		static compressTerminalOutput = vi.fn((input: string) => input)
	}
	return { Terminal: MockTerminal }
})

/** OutputInterceptor は実ファイルを書くので、生成引数と write 内容だけ記録する贋物に差し替える。 */
const interceptorState = vi.hoisted(() => ({
	created: [] as Array<Record<string, unknown>>,
	writes: [] as string[],
	finalizeResult: undefined as unknown,
}))

vi.mock("../../../integrations/terminal/OutputInterceptor", () => {
	class OutputInterceptor {
		constructor(options: Record<string, unknown>) {
			interceptorState.created.push(options)
		}
		write(chunk: string) {
			interceptorState.writes.push(chunk)
		}
		async finalize() {
			return interceptorState.finalizeResult
		}
	}
	return { OutputInterceptor }
})

import { execa } from "execa"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { Terminal } from "../../../integrations/terminal/Terminal"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { ExecuteCommandTool, executeCommandInTerminal, resolveAgentTimeoutMs } from "../ExecuteCommandTool"

const mockedExeca = vi.mocked(execa)
const mockedGetOrCreateTerminal = vi.mocked(TerminalRegistry.getOrCreateTerminal)
const mockedCompress = vi.mocked(Terminal.compressTerminalOutput)
const mockedGetTaskDirectoryPath = vi.mocked(getTaskDirectoryPath)

// --- テスト用ヘルパ ---------------------------------------------------------

/** runCommand に渡ってきたコマンド文字列の記録（＝実際に走ったコマンド）。 */
let ranCommands: string[] = []

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type FakeProcess = Promise<void> & { continue: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }

/** runCommand が返す「プロセス」の贋物。Promise と continue()/abort() を兼ねる。 */
function makeFakeProcess() {
	let resolveRun!: () => void
	let rejectRun!: (reason: unknown) => void
	const base = new Promise<void>((resolve, reject) => {
		resolveRun = resolve
		rejectRun = reject
	})
	// Promise.race に載る前に reject されても unhandledRejection にしない
	base.catch(() => {})
	const proc = Object.assign(base, { continue: vi.fn(), abort: vi.fn() }) as FakeProcess
	return { proc, resolveRun, rejectRun }
}

interface TerminalOptions {
	/** true なら VS Code 側の Terminal インスタンス（`terminal instanceof Terminal` 分岐）。 */
	vscodeTerminal?: boolean
	cwd?: string
	/** runCommand 後に走らせるシナリオ。省略時は exit 0 で即完了。 */
	script?: (cb: AgentTerminalCallbacks, proc: FakeProcess) => Promise<void> | void
	/** true なら script 終了後もプロセスを終わらせない（タイムアウト/中断系のテスト用）。 */
	hang?: boolean
}

function makeTerminal(options: TerminalOptions = {}) {
	const { proc, resolveRun, rejectRun } = makeFakeProcess()
	const cwd = options.cwd ?? "/repo"
	const script =
		options.script ??
		(async (cb: AgentTerminalCallbacks, p: FakeProcess) => {
			cb.onShellExecutionStarted(4242, p as never)
			await cb.onCompleted("done", p as never)
			cb.onShellExecutionComplete({ exitCode: 0 }, p as never)
		})

	const runCommand = vi.fn((command: string, cb: AgentTerminalCallbacks) => {
		ranCommands.push(command)
		void (async () => {
			try {
				await script(cb, proc)
				if (!options.hang) {
					resolveRun()
				}
			} catch (error) {
				rejectRun(error)
			}
		})()
		return proc
	})

	const getCurrentWorkingDirectory = vi.fn(() => cwd)

	const terminal: Record<string, unknown> = options.vscodeTerminal
		? (new (Terminal as unknown as new () => Record<string, unknown>)() as Record<string, unknown>)
		: {}

	if (options.vscodeTerminal) {
		terminal.terminal = { show: vi.fn() }
	}
	terminal.getCurrentWorkingDirectory = getCurrentWorkingDirectory
	terminal.runCommand = runCommand

	mockedGetOrCreateTerminal.mockResolvedValue(terminal as never)

	return { terminal, proc, runCommand, getCurrentWorkingDirectory, resolveRun, rejectRun }
}

interface HostOptions {
	cwd?: string
	globalStoragePath?: string
	providerState?: Record<string, unknown>
	noProvider?: boolean
	lastMessageTs?: number
	noIgnoreController?: boolean
}

function makeHost(options: HostOptions = {}) {
	const provider = {
		getState: vi.fn(async () => options.providerState ?? { terminalShellIntegrationDisabled: false }),
		postMessageToWebview: vi.fn((..._a: unknown[]) => undefined),
		context: options.globalStoragePath ? { globalStorageUri: { fsPath: options.globalStoragePath } } : undefined,
	}

	const host = {
		cwd: options.cwd ?? "/repo",
		taskId: "task-1",
		askState: { lastMessageTs: "lastMessageTs" in options ? options.lastMessageTs : 1_700_000_000_000 },
		stream: { didRejectTool: false, didToolFailInCurrentTurn: false },
		terminalProcess: undefined as unknown,
		supersedePendingAsk: vi.fn(),
		rooIgnoreController: options.noIgnoreController
			? undefined
			: { validateCommand: vi.fn((..._a: unknown[]) => undefined as string | undefined) },
		providerRef: { deref: vi.fn(() => (options.noProvider ? undefined : provider)) },
		mistakeTracker: { count: 0 },
		tokenUsageTracker: { recordToolError: vi.fn(), recordToolUsage: vi.fn() },
		say: vi.fn(async (..._a: unknown[]) => undefined),
		ask: vi.fn(async (..._a: unknown[]) => ({
			response: "yesButtonClicked",
			text: undefined as string | undefined,
			images: undefined as string[] | undefined,
		})),
		sayAndCreateMissingParamError: vi.fn(async (_tool: string, param: string) => `missing:${param}`),
	}

	return { host, provider }
}

function makeCallbacks(approve = true) {
	return {
		askApproval: vi.fn(async (..._a: unknown[]) => approve),
		handleError: vi.fn(async (..._a: unknown[]) => undefined),
		pushToolResult: vi.fn((..._a: unknown[]) => undefined),
	}
}

/**
 * **コマンドが 1 度も起動されていないこと。** ApplyPatchTool.spec の `expectNoWrite` と
 * 同じ役割で、execute_command 側の「取り返しがつかない副作用」に相当する。
 */
function expectNoCommandRan(label: string) {
	expect(mockedGetOrCreateTerminal, `${label}: getOrCreateTerminal`).not.toHaveBeenCalled()
	expect(mockedExeca, `${label}: execa`).not.toHaveBeenCalled()
	expect(ranCommands, `${label}: runCommand`).toEqual([])
}

/** webview に飛んだ commandExecutionStatus を取り出す。 */
function statusesOf(provider: ReturnType<typeof makeHost>["provider"]): CommandExecutionStatus[] {
	return provider.postMessageToWebview.mock.calls
		.map(([message]) => message as { type?: string; text?: string })
		.filter((message) => message?.type === "commandExecutionStatus")
		.map((message) => JSON.parse(message.text ?? "{}") as CommandExecutionStatus)
}

/** onLine は型上 void だが実装は Promise を返す。ask の解決を待つために拾う。 */
function emitLine(cb: AgentTerminalCallbacks, text: string, proc: FakeProcess): Promise<void> {
	return cb.onLine(text, proc as never) as unknown as Promise<void>
}

/** vscode 設定の差し替え（commandExecutionTimeout / commandTimeoutAllowlist）。 */
function stubConfig(values: Record<string, unknown> = {}) {
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		get: (key: string, defaultValue: unknown) => (key in values ? values[key] : defaultValue),
	} as never)
}

const originalCliRuntime = process.env.ROO_CLI_RUNTIME

beforeEach(() => {
	vi.clearAllMocks()
	ranCommands = []
	interceptorState.created = []
	interceptorState.writes = []
	interceptorState.finalizeResult = { preview: "", totalBytes: 0, artifactPath: null, truncated: false }

	mockedGetOrCreateTerminal.mockReset()
	mockedCompress.mockReset().mockImplementation((input: string) => input)
	mockedGetTaskDirectoryPath.mockReset().mockImplementation(async (base: string, taskId: string) => {
		return `${base}/tasks/${taskId}`
	})

	stubConfig()
	delete process.env.ROO_CLI_RUNTIME
})

afterAll(() => {
	if (originalCliRuntime === undefined) {
		delete process.env.ROO_CLI_RUNTIME
	} else {
		process.env.ROO_CLI_RUNTIME = originalCliRuntime
	}
})

// --- 1. 承認ゲート ----------------------------------------------------------

describe("ExecuteCommandTool - 承認ゲート", () => {
	it("command が空なら何も実行しない", async () => {
		const { host } = makeHost()
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "" } as never, host as never, cb as never)

		expectNoCommandRan("command 欠落")
		expect(cb.askApproval).not.toHaveBeenCalled()
		expect(cb.pushToolResult).toHaveBeenCalledWith("missing:command")
		expect(host.mistakeTracker.count).toBe(1)
		expect(host.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("execute_command")
	})

	it("**利用者が拒否したらコマンドは 1 度も起動されない**", async () => {
		// 承認チェックが抜けると任意コード実行になる。ここが本ツール最大の不変条件。
		const { host } = makeHost()
		makeTerminal()
		const cb = makeCallbacks(false)

		await new ExecuteCommandTool().execute({ command: "rm -rf /" } as never, host as never, cb as never)

		expectNoCommandRan("利用者が拒否")
		expect(cb.askApproval).toHaveBeenCalledWith("command", "rm -rf /")
		// 拒否時は結果すら積まない（呼び出し側が拒否メッセージを積む）
		expect(cb.pushToolResult).not.toHaveBeenCalled()
		expect(host.terminalProcess).toBeUndefined()
	})

	it("agentignore に引っかかったら承認を求めず実行もしない", async () => {
		const { host } = makeHost()
		makeTerminal()
		host.rooIgnoreController!.validateCommand = vi.fn(() => ".env") as never
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "cat .env" } as never, host as never, cb as never)

		expectNoCommandRan("agentignore 拒否")
		expect(cb.askApproval).not.toHaveBeenCalled()
		expect(host.say).toHaveBeenCalledWith("agentignore_error", ".env")
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("Access blocked by .agentignore")
	})

	it("agentignore コントローラが無くても承認経路は通る", async () => {
		const { host } = makeHost({ noIgnoreController: true })
		makeTerminal()
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never)

		expect(cb.askApproval).toHaveBeenCalledWith("command", "echo ok")
		expect(ranCommands).toEqual(["echo ok"])
	})

	it("**承認を求めた文字列と実際に走る文字列が一致する**", async () => {
		// HTML エンティティを解いた後の文字列で承認を取り、その同じ文字列を実行する。
		// ここがずれると「見せた内容と違うコマンドが走る」＝承認の意味が消える。
		const { host } = makeHost()
		makeTerminal()
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute(
			{ command: "echo &lt;a&gt; &amp;&amp; ls" } as never,
			host as never,
			cb as never,
		)

		expect(cb.askApproval).toHaveBeenCalledWith("command", "echo <a> && ls")
		expect(ranCommands).toEqual(["echo <a> && ls"])
	})

	it("承認されたらミスカウントを 0 に戻す", async () => {
		const { host } = makeHost()
		host.mistakeTracker.count = 3
		makeTerminal()
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never)

		expect(host.mistakeTracker.count).toBe(0)
	})
})

// --- 2. 拒否リスト / 許可リストとの連携 --------------------------------------

describe("ExecuteCommandTool - 拒否リスト / 許可リストとの連携", () => {
	// ExecuteCommandTool 自身は allowlist/denylist を読まない。判定は
	// askApproval → Task.ask("command") → checkAutoApproval → getCommandDecision
	// の順で行われ、ツールから見えるのは askApproval の真偽値だけ。
	// つまり「denylist が効く」ことは "askApproval が false を返したら実行されない"
	// ことと等価なので、実物の getCommandDecision を askApproval に配線して固定する。
	function approvalFromLists(allowed: string[], denied: string[]) {
		return vi.fn(async (..._a: unknown[]) => {
			const command = String(_a[1])
			return getCommandDecision(command, allowed, denied) === "auto_approve"
		})
	}

	it("denylist に一致するコマンドは実行されない", async () => {
		const { host } = makeHost()
		makeTerminal()
		const cb = makeCallbacks()
		cb.askApproval = approvalFromLists(["git"], ["git push"])

		await new ExecuteCommandTool().execute({ command: "git push origin main" } as never, host as never, cb as never)

		expectNoCommandRan("denylist 一致")
	})

	it("allowlist にしか一致しないコマンドは実行される", async () => {
		const { host } = makeHost()
		makeTerminal()
		const cb = makeCallbacks()
		cb.askApproval = approvalFromLists(["git"], ["git push"])

		await new ExecuteCommandTool().execute({ command: "git status" } as never, host as never, cb as never)

		expect(ranCommands).toEqual(["git status"])
	})

	it("どちらのリストにも一致しなければ（ask_user）実行されない", async () => {
		const { host } = makeHost()
		makeTerminal()
		const cb = makeCallbacks()
		cb.askApproval = approvalFromLists(["git"], ["git push"])

		await new ExecuteCommandTool().execute({ command: "curl http://evil" } as never, host as never, cb as never)

		expectNoCommandRan("リスト未一致")
	})
})

// --- 3. cwd の解決 -----------------------------------------------------------

describe("executeCommandInTerminal - cwd の解決", () => {
	it("cwd 未指定なら task.cwd を使う", async () => {
		const { host } = makeHost({ cwd: "/repo" })
		makeTerminal()

		await executeCommandInTerminal(host as never, { executionId: "e", command: "pwd" })

		expect(mockedGetOrCreateTerminal).toHaveBeenCalledWith("/repo", "task-1", "execa")
	})

	it("絶対パスの cwd はそのまま使う", async () => {
		const { host } = makeHost({ cwd: "/repo" })
		makeTerminal()
		const absolute = path.resolve(path.sep, "elsewhere")

		await executeCommandInTerminal(host as never, { executionId: "e", command: "pwd", customCwd: absolute })

		expect(mockedGetOrCreateTerminal).toHaveBeenCalledWith(absolute, "task-1", "execa")
	})

	it("相対パスの cwd は task.cwd 基準で解決する", async () => {
		const { host } = makeHost({ cwd: "/repo" })
		makeTerminal()

		await executeCommandInTerminal(host as never, { executionId: "e", command: "pwd", customCwd: "src" })

		expect(mockedGetOrCreateTerminal).toHaveBeenCalledWith(path.resolve("/repo", "src"), "task-1", "execa")
	})

	it("存在しない cwd ではターミナルを作らず、その旨を返す", async () => {
		const fs = (await import("fs/promises")).default
		vi.mocked(fs.access).mockRejectedValueOnce(new Error("ENOENT"))
		const { host } = makeHost()

		const [rejected, result] = await executeCommandInTerminal(host as never, {
			executionId: "e",
			command: "pwd",
			customCwd: "/nope",
		})

		expect(rejected).toBe(false)
		expect(result).toBe("Working directory '/nope' does not exist.")
		expectNoCommandRan("存在しない cwd")
	})

	it("【現状の挙動】ワークスペース外の cwd でも実行される（封じ込めチェックが無い）", async () => {
		// executeCommandInTerminal は fs.access で存在確認をするだけで、
		// 解決後のパスが task.cwd 配下かどうかは一切見ていない。
		// 相対パスの `..` でも脱出できる。将来チェックを入れたらこのテストは落ちる。
		const { host } = makeHost({ cwd: "/repo/sub" })
		makeTerminal()

		await executeCommandInTerminal(host as never, {
			executionId: "e",
			command: "cat /etc/passwd",
			customCwd: "../../etc",
		})

		expect(mockedGetOrCreateTerminal).toHaveBeenCalledWith(
			path.resolve("/repo/sub", "../../etc"),
			"task-1",
			"execa",
		)
		expect(ranCommands).toEqual(["cat /etc/passwd"])
	})

	it("VS Code ターミナルなら表示して cwd を実測値で上書きする", async () => {
		const { host } = makeHost()
		const { terminal, getCurrentWorkingDirectory } = makeTerminal({
			vscodeTerminal: true,
			cwd: "/repo/actual",
		})

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "pwd" })

		expect((terminal.terminal as { show: ReturnType<typeof vi.fn> }).show).toHaveBeenCalledWith(true)
		expect(getCurrentWorkingDirectory).toHaveBeenCalled()
		expect(String(result)).toContain("within working directory '/repo/actual'")
	})
})

// --- 4. 終了状態がモデルに返ること -------------------------------------------

describe("executeCommandInTerminal - 終了状態の報告", () => {
	function completeWith(exit: ExitCodeDetails | undefined, output = "out") {
		return async (cb: AgentTerminalCallbacks, proc: FakeProcess) => {
			await cb.onCompleted(output, proc as never)
			if (exit) {
				cb.onShellExecutionComplete(exit, proc as never)
			}
		}
	}

	it("exit 0 は成功として返す", async () => {
		const { host } = makeHost()
		makeTerminal({ script: completeWith({ exitCode: 0 }) })

		const [rejected, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "true" })

		expect(rejected).toBe(false)
		expect(String(result)).toContain("Exit code: 0")
		expect(String(result)).not.toContain("not successful")
	})

	it("**非 0 終了はその事実と exit code が結果に載る**", async () => {
		const { host } = makeHost()
		makeTerminal({ script: completeWith({ exitCode: 42 }) })

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "exit 42" })

		expect(String(result)).toContain(
			"Command execution was not successful, inspect the cause and adjust as needed.",
		)
		expect(String(result)).toContain("Exit code: 42")
		expect(String(result)).toContain("Output:\nout")
	})

	it("シグナル終了はシグナル名を返す", async () => {
		const { host } = makeHost()
		makeTerminal({ script: completeWith({ exitCode: undefined, signalName: "SIGINT" }) })

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "sleep 1" })

		expect(String(result)).toContain("Process terminated by signal SIGINT")
		expect(String(result)).not.toContain("core dump possible")
	})

	it("コアダンプの可能性も返す", async () => {
		const { host } = makeHost()
		makeTerminal({
			script: completeWith({ exitCode: undefined, signalName: "SIGSEGV", coreDumpPossible: true }),
		})

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "boom" })

		expect(String(result)).toContain("Process terminated by signal SIGSEGV - core dump possible")
	})

	it("exit code 不明なら不明であることを明示する", async () => {
		const { host } = makeHost()
		makeTerminal({ script: completeWith({ exitCode: undefined }) })

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "weird" })

		expect(String(result)).toContain("<VSCE exit code is undefined")
		expect(String(result)).toContain("Exit code: <undefined, notify user>")
	})

	it("出力が undefined でも空文字として扱う", async () => {
		const { host } = makeHost()
		makeTerminal({
			script: async (cb, proc) => {
				await cb.onCompleted(undefined, proc as never)
				cb.onShellExecutionComplete({ exitCode: 0 }, proc as never)
			},
		})

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "true" })

		expect(String(result)).toContain("Exit code: 0\nOutput:\n")
	})

	it("shell 実行完了通知が来なかった場合も不明として返す", async () => {
		const { host } = makeHost()
		makeTerminal({ script: completeWith(undefined) })

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "weird" })

		expect(String(result)).toContain("<VSCE exitDetails == undefined")
		expect(String(result)).toContain("Exit code: <undefined, notify user>")
	})

	it("開始 / 出力 / 終了の各ステータスを webview に流す", async () => {
		const { host, provider } = makeHost()
		makeTerminal({
			script: async (cb, proc) => {
				cb.onShellExecutionStarted(999, proc as never)
				await emitLine(cb, "hello", proc)
				await cb.onCompleted("hello", proc as never)
				cb.onShellExecutionComplete({ exitCode: 7 }, proc as never)
			},
		})

		await executeCommandInTerminal(host as never, { executionId: "exec-9", command: "echo hello" })

		const statuses = statusesOf(provider)
		expect(statuses.map((s) => s.status)).toEqual(["started", "output", "exited"])
		expect(statuses[0]).toMatchObject({ executionId: "exec-9", pid: 999, command: "echo hello" })
		expect(statuses[2]).toMatchObject({ exitCode: 7 })
	})

	it("provider が失われていてもクラッシュせず結果を返す", async () => {
		const { host } = makeHost({ noProvider: true })
		makeTerminal({ script: completeWith({ exitCode: 0 }) })

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "true" })

		expect(String(result)).toContain("Exit code: 0")
		expect(interceptorState.created).toEqual([])
	})
})

// --- 5. 中断とタイムアウト ---------------------------------------------------

describe("executeCommandInTerminal - 中断でプロセスを放置しない", () => {
	it("**ユーザタイムアウトでプロセスを abort し、参照も片付ける**", async () => {
		const { host, provider } = makeHost()
		const { proc } = makeTerminal({ hang: true, script: () => {} })

		const [rejected, result] = await executeCommandInTerminal(host as never, {
			executionId: "exec-t",
			command: "sleep 100",
			commandExecutionTimeout: 20,
		})

		expect(proc.abort).toHaveBeenCalledTimes(1)
		// 放置されるとタスク終了後もプロセスが生き残る
		expect(host.terminalProcess).toBeUndefined()
		expect(host.stream.didToolFailInCurrentTurn).toBe(true)
		expect(rejected).toBe(false)
		expect(String(result)).toContain("terminated after exceeding a user-configured 0.02s timeout")
		expect(statusesOf(provider).some((s) => s.status === "timeout")).toBe(true)
		expect(host.say).toHaveBeenCalledWith("error", expect.stringContaining("command_timeout"))
	})

	it("エージェントタイムアウトでは kill せずバックグラウンドへ回す", async () => {
		const { host } = makeHost()
		const { proc } = makeTerminal({ hang: true, script: () => {} })

		const [rejected, result] = await executeCommandInTerminal(host as never, {
			executionId: "exec-a",
			command: "npm run dev",
			agentTimeout: 20,
		})

		expect(proc.continue).toHaveBeenCalledTimes(1)
		expect(proc.abort).not.toHaveBeenCalled()
		expect(host.supersedePendingAsk).toHaveBeenCalledTimes(1)
		expect(host.terminalProcess).toBeUndefined()
		expect(rejected).toBe(false)
		expect(String(result)).toContain("Command is still running in terminal  from '/repo'")
		expect(String(result)).toContain("You will be updated on the terminal status")
	})

	it("バックグラウンド移行時に出力があればそれも返す", async () => {
		const { host } = makeHost()
		makeTerminal({
			hang: true,
			script: async (cb, proc) => {
				await cb.onCompleted("partial output", proc as never)
			},
		})

		const [, result] = await executeCommandInTerminal(host as never, {
			executionId: "exec-a",
			command: "npm run dev",
			agentTimeout: 20,
		})

		// onCompleted が来ているので completed=true → 完了扱いの分岐に入る
		expect(String(result)).toContain("partial output")
	})

	it("完了通知の配信待ちのまま背景に回されても、取得済みの出力は返す", async () => {
		// onCompleted は result を埋めてから command_output の配信完了を待つ。配信が
		// 返らないうちに agent タイムアウトで背景へ回ると completed は false のまま
		// result だけが埋まった状態になる。ここで出力を捨てるとモデルに何も届かない。
		const { host } = makeHost()
		host.say = vi.fn(async (type: unknown) => {
			if (type === "command_output") {
				// webview 側が詰まって応答が返らない状況
				return new Promise<undefined>(() => {})
			}
			return undefined
		}) as never
		makeTerminal({
			hang: true,
			script: (cb, p) => {
				void cb.onCompleted("halfway output", p as never)
			},
		})

		const [, result] = await executeCommandInTerminal(host as never, {
			executionId: "e",
			command: "npm run dev",
			agentTimeout: 20,
		})

		expect(String(result)).toContain("Here's the output so far:\nhalfway output")
		expect(String(result)).toContain("You will be updated on the terminal status")
	})

	it("cwd が空でも「まだ実行中」メッセージを組み立てられる", async () => {
		// workingDir が falsy になる稀なケース（cwd 未設定）の characterization。
		const { host } = makeHost({ cwd: "" })
		makeTerminal({ hang: true, script: () => {} })

		const [, result] = await executeCommandInTerminal(host as never, {
			executionId: "exec-a",
			command: "npm run dev",
			agentTimeout: 20,
		})

		expect(String(result)).toContain("Command is still running in terminal .")
	})

	it("プロセスが例外で落ちたら握りつぶさず投げ直し、参照は片付ける", async () => {
		const { host } = makeHost()
		makeTerminal({
			script: () => {
				throw new Error("spawn EACCES")
			},
		})

		await expect(executeCommandInTerminal(host as never, { executionId: "e", command: "nope" })).rejects.toThrow(
			"spawn EACCES",
		)
		expect(host.terminalProcess).toBeUndefined()
	})

	it("タイムアウト設定が 0 ならタイマーを張らない", async () => {
		const { host } = makeHost()
		const { proc } = makeTerminal()

		await executeCommandInTerminal(host as never, {
			executionId: "e",
			command: "true",
			commandExecutionTimeout: 0,
			agentTimeout: 0,
		})

		expect(proc.abort).not.toHaveBeenCalled()
		expect(proc.continue).not.toHaveBeenCalled()
	})
})

// --- 6. 出力の打ち切り -------------------------------------------------------

describe("executeCommandInTerminal - 巨大出力の打ち切り", () => {
	it("UI 用バッファは 100KB で頭を捨てる", async () => {
		const { host, provider } = makeHost()
		makeTerminal({
			script: async (cb, proc) => {
				await emitLine(cb, "A".repeat(60_000), proc)
				await emitLine(cb, "B".repeat(60_000), proc)
				await cb.onCompleted("done", proc as never)
				cb.onShellExecutionComplete({ exitCode: 0 }, proc as never)
			},
		})

		await executeCommandInTerminal(host as never, { executionId: "e", command: "cat big" })

		const outputs = statusesOf(provider).filter((s) => s.status === "output")
		const last = outputs[outputs.length - 1] as { output: string }
		expect(last.output.length).toBe(100_000)
		// 先頭ではなく末尾が残る
		expect(last.output.endsWith("B")).toBe(true)
		expect(last.output.startsWith("A")).toBe(true)
		expect(last.output.includes("A".repeat(40_001))).toBe(false)
	})

	it("ディスク退避された出力はプレビューと artifact ID で返す", async () => {
		interceptorState.finalizeResult = {
			preview: "先頭…末尾",
			totalBytes: 2_000_000,
			artifactPath: "/store/tasks/task-1/command-output/cmd-99.txt",
			truncated: true,
		}
		const { host } = makeHost({ globalStoragePath: "/store" })
		makeTerminal({
			script: async (cb, proc) => {
				await emitLine(cb, "chunk", proc)
				await cb.onCompleted("chunk", proc as never)
				cb.onShellExecutionComplete({ exitCode: 3 }, proc as never)
			},
		})

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "cat big" })

		const text = String(result)
		expect(text).toContain("Command executed in '/repo'.")
		expect(text).toContain("Command execution was not successful")
		expect(text).toContain("Exit code: 3")
		expect(text).toContain("Output (1.9MB) persisted. Artifact ID: cmd-99.txt")
		expect(text).toContain("先頭…末尾")
		expect(text).toContain("Use read_command_output tool to view full output if needed.")
		// interceptor には生の行がそのまま渡る
		expect(interceptorState.writes).toEqual(["chunk"])
	})

	it("artifact が無ければ ID は空で返す", async () => {
		interceptorState.finalizeResult = {
			preview: "p",
			totalBytes: 512,
			artifactPath: null,
			truncated: true,
		}
		const { host } = makeHost({ globalStoragePath: "/store" })
		makeTerminal({
			script: async (cb, proc) => {
				await cb.onCompleted("p", proc as never)
			},
		})

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "cat big" })

		expect(String(result)).toContain("Output (512B) persisted. Artifact ID: \n")
		// exitDetails 未設定は不明として返す
		expect(String(result)).toContain("Exit code: <undefined, notify user>")
	})

	const byteCases: Array<[number, string]> = [
		[512, "512B"],
		[2048, "2.0KB"],
		[5_242_880, "5.0MB"],
	]

	for (const [totalBytes, expected] of byteCases) {
		it(`サイズ表記: ${totalBytes} → ${expected}`, async () => {
			interceptorState.finalizeResult = { preview: "p", totalBytes, artifactPath: "/a/b.txt", truncated: true }
			const { host } = makeHost({ globalStoragePath: "/store" })
			makeTerminal({
				script: async (cb, proc) => {
					await cb.onCompleted("p", proc as never)
					cb.onShellExecutionComplete({ exitCode: 0 }, proc as never)
				},
			})

			const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "cat big" })

			expect(String(result)).toContain(`Output (${expected}) persisted.`)
		})
	}

	const exitCases: Array<[string, ExitCodeDetails | undefined, string]> = [
		[
			"シグナル+コアダンプ",
			{ exitCode: undefined, signalName: "SIGABRT", coreDumpPossible: true },
			"Process terminated by signal SIGABRT - core dump possible",
		],
		["シグナルのみ", { exitCode: undefined, signalName: "SIGTERM" }, "Process terminated by signal SIGTERM"],
		["exit code 不明", { exitCode: undefined }, "Exit code: <undefined, notify user>"],
		["exit 0", { exitCode: 0 }, "Exit code: 0"],
	]

	for (const [label, exit, expected] of exitCases) {
		it(`ディスク退避時の終了状態: ${label}`, async () => {
			interceptorState.finalizeResult = {
				preview: "p",
				totalBytes: 10,
				artifactPath: "/a/b.txt",
				truncated: true,
			}
			const { host } = makeHost({ globalStoragePath: "/store" })
			makeTerminal({
				script: async (cb, proc) => {
					await cb.onCompleted("p", proc as never)
					if (exit) {
						cb.onShellExecutionComplete(exit, proc as never)
					}
				},
			})

			const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "cat big" })

			expect(String(result)).toContain(expected)
		})
	}

	it("グローバルストレージがあれば interceptor を作り、プレビューサイズ設定を渡す", async () => {
		const { host } = makeHost({
			globalStoragePath: "/store",
			providerState: { terminalShellIntegrationDisabled: true, terminalOutputPreviewSize: "large" },
		})
		makeTerminal()

		await executeCommandInTerminal(host as never, { executionId: "exec-i", command: "echo hi" })

		expect(mockedGetTaskDirectoryPath).toHaveBeenCalledWith("/store", "task-1")
		expect(interceptorState.created[0]).toMatchObject({
			executionId: "exec-i",
			taskId: "task-1",
			command: "echo hi",
			storageDir: path.join("/store/tasks/task-1", "command-output"),
			previewSize: "large",
		})
	})

	it("プレビューサイズ未設定なら既定値を使う", async () => {
		const { host } = makeHost({ globalStoragePath: "/store", providerState: {} })
		makeTerminal()

		await executeCommandInTerminal(host as never, { executionId: "e", command: "echo hi" })

		expect(interceptorState.created[0]?.previewSize).toBe("medium")
	})
})

// --- 7. 実行中の出力 ask ------------------------------------------------------

describe("executeCommandInTerminal - 実行中の割り込み", () => {
	it("利用者がメッセージを返したら継続させ、拒否扱いで結果に載せる", async () => {
		const { host } = makeHost()
		host.ask = vi.fn(async () => ({
			response: "messageResponse",
			text: "そこで止めて",
			images: ["data:image/png;base64,x"],
		})) as never
		const { proc } = makeTerminal({
			script: async (cb, p) => {
				await emitLine(cb, "working...", p)
				await cb.onCompleted("working...", p as never)
				cb.onShellExecutionComplete({ exitCode: 0 }, p as never)
			},
		})

		const [rejected, result] = await executeCommandInTerminal(host as never, {
			executionId: "e",
			command: "npm run dev",
		})

		expect(rejected).toBe(true)
		expect(proc.continue).toHaveBeenCalledTimes(1)
		expect(host.say).toHaveBeenCalledWith("user_feedback", "そこで止めて", ["data:image/png;base64,x"])
		// 画像付きなのでブロック配列で返る
		expect(Array.isArray(result)).toBe(true)
		const first = (result as Array<{ type: string; text: string }>)[0]
		expect(first.text).toContain("Command is still running in terminal from '/repo'")
		expect(first.text).toContain("Here's the output so far:\nworking...")
		expect(first.text).toContain("<user_message>\nそこで止めて\n</user_message>")
	})

	it("出力がまだ無い状態で割り込まれても結果を組み立てられる", async () => {
		const { host } = makeHost()
		host.ask = vi.fn(async () => ({ response: "messageResponse", text: "やめて", images: undefined })) as never
		makeTerminal({
			script: async (cb, p) => {
				await emitLine(cb, "x", p)
			},
			hang: true,
		})

		const [rejected, result] = await executeCommandInTerminal(host as never, {
			executionId: "e",
			command: "npm run dev",
			agentTimeout: 20,
		})

		expect(rejected).toBe(true)
		// onCompleted が来ていないので result は空 → 改行だけになる
		expect(String(result)).not.toContain("Here's the output so far")
		expect(String(result)).toContain("<user_message>\nやめて\n</user_message>")
	})

	it("ask が別応答ならバックグラウンド扱いにして継続はしない", async () => {
		const { host } = makeHost()
		const { proc } = makeTerminal({
			script: async (cb, p) => {
				await emitLine(cb, "a", p)
				await emitLine(cb, "b", p)
				await cb.onCompleted("ab", p as never)
				cb.onShellExecutionComplete({ exitCode: 0 }, p as never)
			},
		})

		const [rejected] = await executeCommandInTerminal(host as never, { executionId: "e", command: "npm test" })

		expect(rejected).toBe(false)
		expect(proc.continue).not.toHaveBeenCalled()
		// 2 行目では runInBackground が立っているので再度 ask しない
		expect(host.ask).toHaveBeenCalledTimes(1)
	})

	it("ask が失敗しても握りつぶし、同じ実行で二度と聞かない", async () => {
		const { host } = makeHost()
		host.ask = vi.fn(async () => {
			throw new Error("Current ask promise was ignored")
		}) as never
		makeTerminal({
			script: async (cb, p) => {
				await emitLine(cb, "a", p)
				await emitLine(cb, "b", p)
				await cb.onCompleted("ab", p as never)
				cb.onShellExecutionComplete({ exitCode: 0 }, p as never)
			},
		})

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "npm test" })

		expect(host.ask).toHaveBeenCalledTimes(1)
		expect(String(result)).toContain("Exit code: 0")
	})
})

// --- 8. command_output の配信 -------------------------------------------------

describe("executeCommandInTerminal - command_output の配信", () => {
	it("同じ内容は再送せず、最後に確定版を 1 度だけ流す", async () => {
		const { host } = makeHost()
		makeTerminal({
			script: async (cb, p) => {
				await emitLine(cb, "x", p) // 直ちに partial 送信
				await emitLine(cb, "", p) // 内容不変 → スロットルタイマーが張られる
				await sleep(220) // タイマー発火（＝重複のため送信されない）
				await cb.onCompleted("x", p as never)
				cb.onShellExecutionComplete({ exitCode: 0 }, p as never)
			},
		})

		await executeCommandInTerminal(host as never, { executionId: "e", command: "echo x" })

		const outputSays = host.say.mock.calls.filter(([type]) => type === "command_output")
		expect(outputSays).toHaveLength(2)
		expect(outputSays[0][3]).toBe(true) // partial
		expect(outputSays[1][3]).toBe(false) // 確定版
		expect(outputSays[1][1]).toBe("x")
	})

	it("完了後に流れてきた出力ではもう partial を出さない", async () => {
		const { host } = makeHost()
		makeTerminal({
			script: async (cb, p) => {
				await cb.onCompleted("done", p as never)
				await emitLine(cb, "late", p)
				cb.onShellExecutionComplete({ exitCode: 0 }, p as never)
			},
		})

		await executeCommandInTerminal(host as never, { executionId: "e", command: "echo done" })

		const partials = host.say.mock.calls.filter(
			([type, , , partial]) => type === "command_output" && partial === true,
		)
		expect(partials).toHaveLength(0)
	})

	it("空出力ではスロットル処理に入らない", async () => {
		const { host } = makeHost()
		makeTerminal({
			script: async (cb, p) => {
				await emitLine(cb, "", p)
				await cb.onCompleted("", p as never)
				cb.onShellExecutionComplete({ exitCode: 0 }, p as never)
			},
		})

		await executeCommandInTerminal(host as never, { executionId: "e", command: "true" })

		const partials = host.say.mock.calls.filter(
			([type, , , partial]) => type === "command_output" && partial === true,
		)
		expect(partials).toHaveLength(0)
	})

	it("say が失敗してもコマンド処理は続行する", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const { host } = makeHost()
		host.say = vi.fn(async (type: unknown) => {
			if (type === "command_output") {
				throw new Error("webview closed")
			}
			return undefined
		}) as never
		makeTerminal({
			script: async (cb, p) => {
				await emitLine(cb, "x", p)
				await cb.onCompleted("x", p as never)
				cb.onShellExecutionComplete({ exitCode: 0 }, p as never)
			},
		})

		const [, result] = await executeCommandInTerminal(host as never, { executionId: "e", command: "echo x" })

		expect(String(result)).toContain("Exit code: 0")
		expect(consoleError).toHaveBeenCalledWith(
			"[ExecuteCommandTool] Failed to publish command output:",
			expect.any(Error),
		)
		consoleError.mockRestore()
	})
})

// --- 9. ExecuteCommandTool.execute の設定連携 --------------------------------

describe("ExecuteCommandTool - 設定とタイムアウトの連携", () => {
	it("commandExecutionTimeout 設定を秒→ミリ秒で適用する", async () => {
		stubConfig({ commandExecutionTimeout: 0.02 })
		const { host } = makeHost()
		const { proc } = makeTerminal({ hang: true, script: () => {} })
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "sleep 100" } as never, host as never, cb as never)

		expect(proc.abort).toHaveBeenCalledTimes(1)
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("0.02s timeout")
	})

	it("allowlist に前方一致するコマンドはタイムアウトを免除される", async () => {
		// prefix は trim して比較されるので、前後の空白付きでも一致する
		stubConfig({ commandExecutionTimeout: 0.02, commandTimeoutAllowlist: ["  sleep  "] })
		const { host } = makeHost()
		const { proc } = makeTerminal({ hang: true, script: () => {} })
		const cb = makeCallbacks()

		// agent 側タイムアウトでバックグラウンドに逃がしてテストを終わらせる
		await new ExecuteCommandTool().execute(
			{ command: "sleep 100", timeout: 0.02 } as never,
			host as never,
			cb as never,
		)

		expect(proc.abort).not.toHaveBeenCalled()
		expect(proc.continue).toHaveBeenCalledTimes(1)
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("Command is still running in terminal")
	})

	it("allowlist に一致しなければタイムアウトは効いたままになる", async () => {
		stubConfig({ commandExecutionTimeout: 0.02, commandTimeoutAllowlist: ["pnpm"] })
		const { host } = makeHost()
		const { proc } = makeTerminal({ hang: true, script: () => {} })
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "sleep 100" } as never, host as never, cb as never)

		expect(proc.abort).toHaveBeenCalledTimes(1)
	})

	it("provider の状態が取れなければシェル統合は無効として execa で走る", async () => {
		const { host } = makeHost({ noProvider: true })
		makeTerminal()
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never)

		expect(mockedGetOrCreateTerminal).toHaveBeenCalledWith("/repo", "task-1", "execa")
	})

	it("シェル統合が有効なら vscode ターミナルを使う", async () => {
		const { host } = makeHost({ providerState: { terminalShellIntegrationDisabled: false } })
		makeTerminal()
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never)

		expect(mockedGetOrCreateTerminal).toHaveBeenCalledWith("/repo", "task-1", "vscode")
	})

	it("直前の ask タイムスタンプを実行 ID に使う", async () => {
		const { host, provider } = makeHost({ lastMessageTs: 1_234_567 })
		makeTerminal()
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never)

		expect(statusesOf(provider)[0].executionId).toBe("1234567")
	})

	it("ask タイムスタンプが無ければ現在時刻を実行 ID に使う", async () => {
		const { host, provider } = makeHost({ lastMessageTs: undefined })
		makeTerminal()
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never)

		expect(Number(statusesOf(provider)[0].executionId)).toBeGreaterThan(1_700_000_000_000)
	})

	it("利用者が割り込んだら didRejectTool を立てる", async () => {
		const { host } = makeHost()
		host.ask = vi.fn(async (type: unknown) => {
			if (type === "command_output") {
				return { response: "messageResponse", text: "stop", images: undefined }
			}
			return { response: "yesButtonClicked", text: undefined, images: undefined }
		}) as never
		makeTerminal({
			script: async (cb, p) => {
				await emitLine(cb, "x", p)
				await cb.onCompleted("x", p as never)
				cb.onShellExecutionComplete({ exitCode: 0 }, p as never)
			},
		})
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "npm run dev" } as never, host as never, cb as never)

		expect(host.stream.didRejectTool).toBe(true)
	})
})

// --- 10. 失敗経路 -------------------------------------------------------------

describe("ExecuteCommandTool - 失敗経路", () => {
	it("ターミナル生成に失敗したらシェル統合の警告を出して結果を返す", async () => {
		const { host, provider } = makeHost()
		mockedGetOrCreateTerminal.mockRejectedValue(new Error("no terminal"))
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never)

		expect(statusesOf(provider).some((s) => s.status === "fallback")).toBe(true)
		expect(host.say).toHaveBeenCalledWith("shell_integration_warning")
		expect(host.supersedePendingAsk).toHaveBeenCalledTimes(1)
		expect(cb.pushToolResult).toHaveBeenCalledWith(
			"Command failed to execute in terminal due to a shell integration error.",
		)
		expect(ranCommands).toEqual([])
	})

	it("provider が無い状態で失敗しても落ちない", async () => {
		const { host } = makeHost({ noProvider: true })
		mockedGetOrCreateTerminal.mockRejectedValue(new Error("no terminal"))
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never)

		expect(cb.pushToolResult).toHaveBeenCalledWith(
			"Command failed to execute in terminal due to a shell integration error.",
		)
	})

	it("承認前の例外は handleError に渡す", async () => {
		const { host } = makeHost()
		host.rooIgnoreController!.validateCommand = vi.fn(() => {
			throw new Error("controller broken")
		}) as never
		const cb = makeCallbacks()

		await new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never)

		expect(cb.handleError).toHaveBeenCalledWith("executing command", expect.any(Error))
		expectNoCommandRan("承認前の例外")
	})
})

// --- 11. ShellIntegrationError からの復帰 ------------------------------------

describe("ExecuteCommandTool - シェル統合エラーからの復帰", () => {
	// `executeCommandInTerminal` は ShellIntegrationError を投げると
	// 「シェル統合を切って 1 回だけ再実行する」復帰経路に入る。ところが実装では
	// この例外を投げる条件（ExecuteCommandTool.ts:469 の shellIntegrationError）が
	// **どこからも代入されない**ため、通常の経路では到達しない。
	// ShellIntegrationError はモジュール private でテストから new もできないので、
	// `Error` に一時的な Symbol.hasInstance を置いて instanceof だけを偽装する。
	// 判定対象が「ShellIntegrationError という名前のコンストラクタ」かつ
	// 「印を付けた例外」のときだけ true を返し、それ以外は本来の判定に委譲する。
	const FORGED = Symbol("forged-shell-integration-error")
	const NATIVE_HAS_INSTANCE = Function.prototype[Symbol.hasInstance]

	function forgedShellIntegrationError(message: string): Error {
		const error = new Error(message)
		Object.defineProperty(error, FORGED, { value: true })
		return error
	}

	async function withForgedInstanceOf<T>(run: () => Promise<T>): Promise<T> {
		Object.defineProperty(Error, Symbol.hasInstance, {
			configurable: true,
			value: function (this: unknown, instance: unknown): boolean {
				const isShellIntegrationError =
					(this as { name?: string } | undefined)?.name === "ShellIntegrationError"
				if (isShellIntegrationError && (instance as Record<symbol, unknown> | null)?.[FORGED] === true) {
					return true
				}
				return NATIVE_HAS_INSTANCE.call(this, instance)
			},
		})
		try {
			return await run()
		} finally {
			Reflect.deleteProperty(Error, Symbol.hasInstance)
		}
	}

	it("シェル統合を切って再実行し、その結果を返す", async () => {
		const { host, provider } = makeHost({ providerState: { terminalShellIntegrationDisabled: false } })
		const cb = makeCallbacks()
		mockedGetOrCreateTerminal.mockRejectedValueOnce(forgedShellIntegrationError("no shell integration"))
		makeTerminal()

		await withForgedInstanceOf(() =>
			new ExecuteCommandTool().execute({ command: "echo ok" } as never, host as never, cb as never),
		)

		expect(mockedGetOrCreateTerminal).toHaveBeenCalledTimes(2)
		// 1 回目は vscode、リトライは execa（シェル統合を切って再実行）
		expect(mockedGetOrCreateTerminal.mock.calls[0][2]).toBe("vscode")
		expect(mockedGetOrCreateTerminal.mock.calls[1][2]).toBe("execa")
		expect(statusesOf(provider).some((s) => s.status === "fallback")).toBe(true)
		expect(host.stream.didRejectTool).toBe(false)
		expect(String(cb.pushToolResult.mock.calls[0][0])).toContain("Exit code: 0")
	})

	it("再実行中に割り込まれたら didRejectTool を立てる", async () => {
		const { host } = makeHost({ providerState: { terminalShellIntegrationDisabled: false } })
		host.ask = vi.fn(async (type: unknown) => {
			if (type === "command_output") {
				return { response: "messageResponse", text: "stop", images: undefined }
			}
			return { response: "yesButtonClicked", text: undefined, images: undefined }
		}) as never
		const cb = makeCallbacks()
		mockedGetOrCreateTerminal.mockRejectedValueOnce(forgedShellIntegrationError("no shell integration"))
		makeTerminal({
			script: async (terminalCallbacks, proc) => {
				await emitLine(terminalCallbacks, "x", proc)
				await terminalCallbacks.onCompleted("x", proc as never)
				terminalCallbacks.onShellExecutionComplete({ exitCode: 0 }, proc as never)
			},
		})

		await withForgedInstanceOf(() =>
			new ExecuteCommandTool().execute({ command: "npm run dev" } as never, host as never, cb as never),
		)

		expect(host.stream.didRejectTool).toBe(true)
	})
})

// --- 12. handlePartial / resolveAgentTimeoutMs -------------------------------

describe("ExecuteCommandTool.handlePartial", () => {
	function partial(command?: string) {
		return { type: "tool_use", name: "execute_command", params: { command }, partial: true } as never
	}

	it("ストリーミング中のコマンドをそのまま表示する", async () => {
		const { host } = makeHost()

		await new ExecuteCommandTool().handlePartial(host as never, partial("npm ru"))

		expect(host.ask).toHaveBeenCalledWith("command", "npm ru", true)
	})

	it("コマンドがまだ来ていなければ空文字で表示する", async () => {
		const { host } = makeHost()

		await new ExecuteCommandTool().handlePartial(host as never, partial(undefined))

		expect(host.ask).toHaveBeenCalledWith("command", "", true)
	})

	it("表示に失敗しても例外を伝播しない", async () => {
		const { host } = makeHost()
		host.ask = vi.fn(async () => {
			throw new Error("ask superseded")
		}) as never

		await expect(new ExecuteCommandTool().handlePartial(host as never, partial("ls"))).resolves.toBeUndefined()
	})
})

describe("resolveAgentTimeoutMs", () => {
	it("CLI ランタイムではモデル指定のタイムアウトを無視する", () => {
		process.env.ROO_CLI_RUNTIME = "1"
		expect(resolveAgentTimeoutMs(30)).toBe(0)
	})

	it("CLI 以外では秒をミリ秒に変換する", () => {
		expect(resolveAgentTimeoutMs(30)).toBe(30_000)
	})

	it("未指定・0・負値は無効として 0 を返す", () => {
		expect(resolveAgentTimeoutMs(undefined)).toBe(0)
		expect(resolveAgentTimeoutMs(null)).toBe(0)
		expect(resolveAgentTimeoutMs(0)).toBe(0)
		expect(resolveAgentTimeoutMs(-5)).toBe(0)
	})
})
