// npx vitest run integrations/terminal/__tests__/TerminalRegistry.invariants.spec.ts
//
// TerminalRegistry は「拡張が生きている間ずっと残るターミナル台帳」。C0 41.8%
// （未実行 117 行）で、VS Code のシェル実行イベント配線・再利用判定・破棄まわりが
// まったく試されていなかった。
//
// ここで固定する最重要の不変条件:
//
//   **破棄（isClosed）されたターミナルは二度と再利用されない。**
//   そして **二重解放しても壊れない**（同じ id を 2 回消しても例外にならず、
//   一時ディレクトリの後片付けが多重に走らない）。
//
// 破棄済みターミナルを掴むと、実行したコマンドがどこにも届かないまま
// 「成功した」ことになる。台帳から落ちることを取得系の全経路で見る。
//
// Terminal / ExecaTerminal / ShellIntegrationManager / TerminalProcess はすべて
// モックし、VS Code のターミナルも実プロセスも一切作らない。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { ExitCodeDetails } from "../types"

// --- モック ------------------------------------------------------------------

/** vi.mock のファクトリから触れるようにした共有状態。 */
const state = vi.hoisted(() => ({
	/** 生成された贋ターミナル（Terminal / ExecaTerminal 両方）。 */
	created: [] as FakeTerminal[],
	/** vscode.window.on* に渡されたハンドラ。 */
	handlers: {
		close: undefined as ((t: unknown) => void) | undefined,
		start: undefined as ((e: unknown) => Promise<void>) | undefined,
		end: undefined as ((e: unknown) => Promise<void>) | undefined,
	},
	/** on* を「存在しない API」として扱うか（古い VS Code の再現）。 */
	shellExecutionApiMissing: false,
	/** onDidStartTerminalShellExecution が例外を投げるか。 */
	shellExecutionApiThrows: false,
}))

interface FakeTerminal {
	provider: string
	id: number
	busy: boolean
	running: boolean
	taskId?: string
	process?: { isHot?: boolean; hasUnretrievedOutput?: () => boolean }
	terminal?: unknown
	closed: boolean
	cwd: string
	getCurrentWorkingDirectory: () => string
	isClosed: () => boolean
	setActiveStream: ReturnType<typeof vi.fn>
	shellExecutionComplete: ReturnType<typeof vi.fn>
	getProcessesWithOutput: ReturnType<typeof vi.fn>
	getUnretrievedOutput: ReturnType<typeof vi.fn>
}

vi.mock("vscode", () => {
	const disposable = () => ({ dispose: vi.fn() })
	return {
		window: {
			onDidCloseTerminal: vi.fn((cb: (t: unknown) => void) => {
				state.handlers.close = cb
				return disposable()
			}),
			get onDidStartTerminalShellExecution() {
				if (state.shellExecutionApiMissing) {
					return undefined
				}
				return (cb: (e: unknown) => Promise<void>) => {
					if (state.shellExecutionApiThrows) {
						throw new Error("proposed API not enabled")
					}
					state.handlers.start = cb
					return disposable()
				}
			},
			get onDidEndTerminalShellExecution() {
				if (state.shellExecutionApiMissing) {
					return undefined
				}
				return (cb: (e: unknown) => Promise<void>) => {
					state.handlers.end = cb
					return disposable()
				}
			},
		},
		Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }) },
	}
})

// Terminal / ExecaTerminal は「台帳に載る箱」でしかないので、必要な形だけの贋物に置く。
// クラス名を import 名と衝突させない（ssr 変換が factory 内の識別子を書き換えるため）。
vi.mock("../Terminal", () => {
	class MockVsceTerminal {
		provider = "vscode"
		id: number
		busy = false
		running = false
		taskId?: string
		process?: unknown
		terminal: unknown
		closed = false
		cwd: string
		setActiveStream = vi.fn()
		shellExecutionComplete = vi.fn()
		getProcessesWithOutput = vi.fn(() => [] as unknown[])
		getUnretrievedOutput = vi.fn(() => "")
		constructor(id: number, terminal: unknown, cwd: string) {
			this.id = id
			this.cwd = cwd
			this.terminal = terminal ?? { name: `vsce-${id}` }
			state.created.push(this as unknown as FakeTerminal)
		}
		getCurrentWorkingDirectory() {
			return this.cwd
		}
		isClosed() {
			return this.closed
		}
	}
	return { Terminal: MockVsceTerminal }
})

vi.mock("../ExecaTerminal", () => {
	class MockExecaTerminal {
		provider = "execa"
		id: number
		busy = false
		running = false
		taskId?: string
		process?: unknown
		closed = false
		cwd: string
		setActiveStream = vi.fn()
		shellExecutionComplete = vi.fn()
		getProcessesWithOutput = vi.fn(() => [] as unknown[])
		getUnretrievedOutput = vi.fn(() => "")
		constructor(id: number, cwd: string) {
			this.id = id
			this.cwd = cwd
			state.created.push(this as unknown as FakeTerminal)
		}
		getCurrentWorkingDirectory() {
			return this.cwd
		}
		isClosed() {
			return this.closed
		}
	}
	return { ExecaTerminal: MockExecaTerminal }
})

const shellIntegrationMock = vi.hoisted(() => ({
	zshCleanupTmpDir: vi.fn((..._a: unknown[]) => true),
	clear: vi.fn(() => undefined),
}))

vi.mock("../ShellIntegrationManager", () => ({ ShellIntegrationManager: shellIntegrationMock }))

const interpretExitCode = vi.hoisted(() =>
	vi.fn((exitCode: number | undefined) => ({ exitCode }) as { exitCode: number | undefined }),
)

vi.mock("../TerminalProcess", () => ({ TerminalProcess: { interpretExitCode } }))

import * as vscode from "vscode"
import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"

// --- ヘルパ ------------------------------------------------------------------

type RegistryInternals = {
	terminals: FakeTerminal[]
	nextTerminalId: number
	disposables: { dispose: ReturnType<typeof vi.fn> }[]
	isInitialized: boolean
}

/** static フィールドは private だが TS のみの制約なので、実行時に直接戻す。 */
const internals = TerminalRegistry as unknown as RegistryInternals

function resetRegistry(): void {
	internals.terminals = []
	internals.nextTerminalId = 1
	internals.disposables = []
	internals.isInitialized = false
}

/** 台帳に載っているターミナルを、破棄済みかどうかを問わず全件返す。 */
const registered = (): FakeTerminal[] => internals.terminals

function makeVsce(cwd = "/repo", options: Partial<FakeTerminal> = {}): FakeTerminal {
	const terminal = TerminalRegistry.createTerminal(cwd, "vscode") as unknown as FakeTerminal
	Object.assign(terminal, options)
	return terminal
}

function makeExeca(cwd = "/repo", options: Partial<FakeTerminal> = {}): FakeTerminal {
	const terminal = TerminalRegistry.createTerminal(cwd, "execa") as unknown as FakeTerminal
	Object.assign(terminal, options)
	return terminal
}

let infoSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.clearAllMocks()
	state.created = []
	state.handlers = { close: undefined, start: undefined, end: undefined }
	state.shellExecutionApiMissing = false
	state.shellExecutionApiThrows = false
	shellIntegrationMock.zshCleanupTmpDir.mockImplementation(() => true)
	interpretExitCode.mockImplementation((exitCode) => ({ exitCode }))
	resetRegistry()
	infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	infoSpy.mockRestore()
	errorSpy.mockRestore()
})

// --- 1. initialize ------------------------------------------------------------

describe("TerminalRegistry.initialize", () => {
	it("2 回呼ぶと例外になる（イベントハンドラの多重登録を防ぐ）", () => {
		TerminalRegistry.initialize()

		expect(() => TerminalRegistry.initialize()).toThrow("TerminalRegistry.initialize() should only be called once")
	})

	it("close / start / end の 3 つを購読し、dispose 対象として保持する", () => {
		TerminalRegistry.initialize()

		expect(vscode.window.onDidCloseTerminal).toHaveBeenCalledTimes(1)
		expect(state.handlers.start).toBeTypeOf("function")
		expect(state.handlers.end).toBeTypeOf("function")
		expect(internals.disposables).toHaveLength(3)
	})

	it("シェル実行イベント API が無い VS Code でも初期化できる（close だけ購読）", () => {
		state.shellExecutionApiMissing = true

		TerminalRegistry.initialize()

		expect(state.handlers.start).toBeUndefined()
		expect(state.handlers.end).toBeUndefined()
		expect(internals.disposables).toHaveLength(1)
	})

	it("購読の登録が例外を投げても初期化ごと失敗させない", () => {
		state.shellExecutionApiThrows = true

		expect(() => TerminalRegistry.initialize()).not.toThrow()

		expect(errorSpy).toHaveBeenCalledWith(
			"[TerminalRegistry] Error setting up shell execution handlers:",
			expect.any(Error),
		)
		// close の購読だけが残る。
		expect(internals.disposables).toHaveLength(1)
	})
})

// --- 2. ターミナルが閉じられたとき --------------------------------------------

describe("TerminalRegistry - onDidCloseTerminal", () => {
	it("台帳のターミナルが閉じられたら一時 ZDOTDIR を片付ける", () => {
		TerminalRegistry.initialize()
		const terminal = makeVsce("/repo")

		state.handlers.close!(terminal.terminal)

		expect(shellIntegrationMock.zshCleanupTmpDir).toHaveBeenCalledExactlyOnceWith(terminal.id)
	})

	it("台帳に無いターミナルが閉じられても何もしない", () => {
		TerminalRegistry.initialize()
		makeVsce("/repo")

		state.handlers.close!({ name: "someone-elses-terminal" })

		expect(shellIntegrationMock.zshCleanupTmpDir).not.toHaveBeenCalled()
	})

	it("**破棄済みターミナルの close では台帳から外し、片付けは 1 回だけ**", () => {
		TerminalRegistry.initialize()
		const terminal = makeVsce("/repo")
		terminal.closed = true

		state.handlers.close!(terminal.terminal)

		// getTerminalByVSCETerminal が closed を見て removeTerminal 経由で片付ける。
		expect(shellIntegrationMock.zshCleanupTmpDir).toHaveBeenCalledExactlyOnceWith(terminal.id)
		expect(registered()).toEqual([])

		// 二重解放：同じ close をもう一度受けても例外にならず、追加の片付けも走らない。
		expect(() => state.handlers.close!(terminal.terminal)).not.toThrow()
		expect(shellIntegrationMock.zshCleanupTmpDir).toHaveBeenCalledTimes(1)
	})
})

// --- 3. シェル実行の開始 / 終了 ------------------------------------------------

describe("TerminalRegistry - シェル実行イベント", () => {
	function startEvent(terminal: unknown, command = "ls") {
		const stream = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }
		return {
			terminal,
			execution: { commandLine: { value: command }, read: vi.fn(() => stream) },
			stream,
		}
	}

	it("開始イベントでストリームを掴み、busy を立てる", async () => {
		TerminalRegistry.initialize()
		const terminal = makeVsce("/repo")
		const event = startEvent(terminal.terminal)

		await state.handlers.start!(event)

		expect(event.execution.read).toHaveBeenCalledTimes(1)
		expect(terminal.setActiveStream).toHaveBeenCalledExactlyOnceWith(event.stream)
		expect(terminal.busy).toBe(true)
	})

	it("台帳に無いターミナルの開始イベントは記録だけして無視する", async () => {
		TerminalRegistry.initialize()
		const terminal = makeVsce("/repo")
		const event = startEvent({ name: "stranger" })

		await state.handlers.start!(event)

		expect(terminal.setActiveStream).not.toHaveBeenCalled()
		expect(errorSpy).toHaveBeenCalledWith(
			"[onDidStartTerminalShellExecution] Shell execution started, but not from a Agent-registered terminal:",
			event,
		)
	})

	function endEvent(terminal: unknown, exitCode: number | undefined = 0) {
		return { terminal, exitCode, execution: { commandLine: { value: "ls" } } }
	}

	it("終了イベントで exitDetails を通知し、busy を落とす", async () => {
		TerminalRegistry.initialize()
		const terminal = makeVsce("/repo")
		terminal.running = true
		terminal.busy = true
		terminal.process = { isHot: false }

		await state.handlers.end!(endEvent(terminal.terminal, 3))

		expect(interpretExitCode).toHaveBeenCalledWith(3)
		expect(terminal.shellExecutionComplete).toHaveBeenCalledExactlyOnceWith({ exitCode: 3 } as ExitCodeDetails)
		expect(terminal.busy).toBe(false)
	})

	it("台帳に無いターミナルの終了イベントは記録だけして戻る", async () => {
		TerminalRegistry.initialize()
		const event = endEvent({ name: "stranger" })

		await state.handlers.end!(event)

		expect(errorSpy).toHaveBeenCalledWith(
			"[onDidEndTerminalShellExecution] Shell execution ended, but not from a Agent-registered terminal:",
			event,
		)
	})

	it("走っていないターミナルの終了イベントでは busy を落とすだけ", async () => {
		TerminalRegistry.initialize()
		const terminal = makeVsce("/repo")
		terminal.running = false
		terminal.busy = true
		terminal.process = { command: "npm test" } as never

		await state.handlers.end!(endEvent(terminal.terminal, 0))

		expect(terminal.busy).toBe(false)
		expect(terminal.shellExecutionComplete).not.toHaveBeenCalled()
		expect(errorSpy).toHaveBeenCalledWith(
			"[TerminalRegistry] Shell execution end event received, but process is not running for terminal:",
			{ terminalId: terminal.id, command: "npm test", exitCode: 0 },
		)
	})

	it("走っていない上にプロセスも無い場合はコマンド名 undefined で記録する", async () => {
		TerminalRegistry.initialize()
		const terminal = makeVsce("/repo")
		terminal.running = false
		terminal.busy = true
		terminal.process = undefined

		await state.handlers.end!(endEvent(terminal.terminal, 0))

		expect(terminal.busy).toBe(false)
		expect(errorSpy).toHaveBeenCalledWith(
			"[TerminalRegistry] Shell execution end event received, but process is not running for terminal:",
			{ terminalId: terminal.id, command: undefined, exitCode: 0 },
		)
	})

	it("running なのに process が無ければ busy を触らずに戻る", async () => {
		TerminalRegistry.initialize()
		const terminal = makeVsce("/repo")
		terminal.running = true
		terminal.busy = true
		terminal.process = undefined

		await state.handlers.end!(endEvent(terminal.terminal, undefined))

		expect(terminal.busy).toBe(true)
		expect(terminal.shellExecutionComplete).not.toHaveBeenCalled()
		expect(errorSpy).toHaveBeenCalledWith(
			"[TerminalRegistry] Shell execution end event received on running terminal, but process is undefined:",
			expect.objectContaining({ terminalId: terminal.id }),
		)
	})
})

// --- 4. createTerminal --------------------------------------------------------

describe("TerminalRegistry.createTerminal", () => {
	it("provider に応じたクラスを作り、id を 1 から採番する", () => {
		const a = makeVsce("/a")
		const b = makeExeca("/b")

		expect(a).toBeInstanceOf(Terminal)
		expect(b).not.toBeInstanceOf(Terminal)
		expect(a.id).toBe(1)
		expect(b.id).toBe(2)
		expect(registered()).toEqual([a, b])
	})

	it("id は破棄後も再利用されない（別ターミナルと取り違えない）", () => {
		const a = makeVsce("/a")
		a.closed = true
		// 取得系を通すと台帳から外れる。
		TerminalRegistry.getUnretrievedOutput(a.id)

		const b = makeVsce("/a")

		expect(b.id).toBe(2)
	})
})

// --- 5. getOrCreateTerminal ---------------------------------------------------

describe("TerminalRegistry.getOrCreateTerminal", () => {
	it("同じ task / 同じ cwd の空きターミナルを再利用する", async () => {
		const existing = makeVsce("/repo", { taskId: "task-1" })

		const got = await TerminalRegistry.getOrCreateTerminal("/repo", "task-1", "vscode")

		expect(got).toBe(existing as never)
		expect(state.created).toHaveLength(1)
	})

	it("busy なターミナルは再利用しない", async () => {
		makeVsce("/repo", { taskId: "task-1", busy: true })

		const got = await TerminalRegistry.getOrCreateTerminal("/repo", "task-1", "vscode")

		expect(state.created).toHaveLength(2)
		expect((got as unknown as FakeTerminal).id).toBe(2)
	})

	it("provider が違うターミナルは再利用しない", async () => {
		makeExeca("/repo", { taskId: "task-1" })

		const got = await TerminalRegistry.getOrCreateTerminal("/repo", "task-1", "vscode")

		expect((got as unknown as FakeTerminal).provider).toBe("vscode")
		expect(state.created).toHaveLength(2)
	})

	it("taskId が違うターミナルは第一優先では拾わない（cwd 一致なら第二優先で拾う）", async () => {
		const other = makeVsce("/repo", { taskId: "task-other" })

		const got = await TerminalRegistry.getOrCreateTerminal("/repo", "task-1", "vscode")

		// 第一優先（task 一致）で外れ、第二優先（cwd 一致）で拾われる。
		expect(got).toBe(other as never)
		expect((got as unknown as FakeTerminal).taskId).toBe("task-1")
	})

	it("cwd が取れないターミナルは再利用しない", async () => {
		const broken = makeVsce("/repo", { taskId: "task-1" })
		broken.getCurrentWorkingDirectory = () => ""

		const got = await TerminalRegistry.getOrCreateTerminal("/repo", "task-1", "vscode")

		expect(got).not.toBe(broken as never)
		expect(state.created).toHaveLength(2)
	})

	it("cwd が取れないターミナルは第二優先でも再利用しない", async () => {
		const broken = makeVsce("/repo")
		broken.getCurrentWorkingDirectory = () => ""

		const got = await TerminalRegistry.getOrCreateTerminal("/repo", undefined, "vscode")

		expect(got).not.toBe(broken as never)
	})

	it("busy / provider 違いは第二優先でも弾く", async () => {
		makeVsce("/repo", { busy: true })
		makeExeca("/repo")

		const got = await TerminalRegistry.getOrCreateTerminal("/repo", undefined, "vscode")

		expect((got as unknown as FakeTerminal).id).toBe(3)
	})

	it("cwd が違えば新規作成する", async () => {
		makeVsce("/repo")

		const got = await TerminalRegistry.getOrCreateTerminal("/other", "task-1", "vscode")

		expect((got as unknown as FakeTerminal).cwd).toBe("/other")
		expect(state.created).toHaveLength(2)
	})

	it("既定の provider は vscode", async () => {
		const got = await TerminalRegistry.getOrCreateTerminal("/repo")

		expect((got as unknown as FakeTerminal).provider).toBe("vscode")
		expect((got as unknown as FakeTerminal).taskId).toBeUndefined()
	})

	it("**破棄済みのターミナルは再利用されない（新しいものが作られる）**", async () => {
		// 破棄済みを掴むと、以降のコマンド出力がどこにも届かないまま成功扱いになる。
		const dead = makeVsce("/repo", { taskId: "task-1" })
		dead.closed = true

		const got = await TerminalRegistry.getOrCreateTerminal("/repo", "task-1", "vscode")

		expect(got).not.toBe(dead as never)
		expect((got as unknown as FakeTerminal).id).toBe(2)
		// 破棄済みは台帳からも消えている。
		expect(registered().map((t) => t.id)).toEqual([2])
	})

	it("**破棄済みが混ざった台帳でも生きているものだけを再利用する**", async () => {
		const dead = makeVsce("/repo", { taskId: "task-1" })
		dead.closed = true
		const alive = makeVsce("/repo", { taskId: "task-1" })

		const got = await TerminalRegistry.getOrCreateTerminal("/repo", "task-1", "vscode")

		expect(got).toBe(alive as never)
		expect(registered().map((t) => t.id)).toEqual([alive.id])
	})
})

// --- 6. 取得系 ----------------------------------------------------------------

describe("TerminalRegistry - 取得系", () => {
	it("getUnretrievedOutput は台帳に無ければ空文字", () => {
		expect(TerminalRegistry.getUnretrievedOutput(42)).toBe("")
	})

	it("getUnretrievedOutput はターミナルの出力をそのまま返す", () => {
		const terminal = makeVsce("/repo")
		terminal.getUnretrievedOutput.mockReturnValue("hello")

		expect(TerminalRegistry.getUnretrievedOutput(terminal.id)).toBe("hello")
	})

	it("**破棄済みターミナルの出力は取れず、台帳から外れる（二重に呼んでも壊れない）**", () => {
		const terminal = makeVsce("/repo")
		terminal.closed = true
		terminal.getUnretrievedOutput.mockReturnValue("stale output")

		expect(TerminalRegistry.getUnretrievedOutput(terminal.id)).toBe("")
		expect(terminal.getUnretrievedOutput).not.toHaveBeenCalled()
		expect(registered()).toEqual([])
		expect(shellIntegrationMock.zshCleanupTmpDir).toHaveBeenCalledExactlyOnceWith(terminal.id)

		// 二重解放。2 回目は台帳に居ないので片付けも走らない。
		expect(TerminalRegistry.getUnretrievedOutput(terminal.id)).toBe("")
		expect(shellIntegrationMock.zshCleanupTmpDir).toHaveBeenCalledTimes(1)
	})

	it("isProcessHot は台帳に無ければ false", () => {
		expect(TerminalRegistry.isProcessHot(42)).toBe(false)
	})

	it("isProcessHot は process が無ければ false", () => {
		const terminal = makeVsce("/repo")

		expect(TerminalRegistry.isProcessHot(terminal.id)).toBe(false)
	})

	it("isProcessHot は process.isHot を返す", () => {
		const hot = makeVsce("/a", { process: { isHot: true } })
		const cold = makeVsce("/b", { process: { isHot: false } })

		expect(TerminalRegistry.isProcessHot(hot.id)).toBe(true)
		expect(TerminalRegistry.isProcessHot(cold.id)).toBe(false)
	})

	it("getTerminals は busy 状態で絞る", () => {
		const busy = makeVsce("/a", { busy: true })
		const idle = makeVsce("/b", { busy: false })

		expect(TerminalRegistry.getTerminals(true)).toEqual([busy])
		expect(TerminalRegistry.getTerminals(false)).toEqual([idle])
	})

	it("getTerminals は taskId でも絞る", () => {
		const mine = makeVsce("/a", { taskId: "task-1" })
		makeVsce("/b", { taskId: "task-2" })
		makeVsce("/c")

		expect(TerminalRegistry.getTerminals(false, "task-1")).toEqual([mine])
	})

	it("getTerminals は破棄済みを返さない", () => {
		const dead = makeVsce("/a")
		dead.closed = true
		const alive = makeVsce("/b")

		expect(TerminalRegistry.getTerminals(false)).toEqual([alive])
	})

	it("getBackgroundTerminals は busy 指定があれば busy で絞る", () => {
		const bg = makeVsce("/a", { busy: true })
		makeVsce("/b", { busy: true, taskId: "task-1" })
		makeVsce("/c", { busy: false })

		expect(TerminalRegistry.getBackgroundTerminals(true)).toEqual([bg])
	})

	it("getBackgroundTerminals は busy 未指定なら出力の有無で絞る", () => {
		const withQueued = makeVsce("/a")
		withQueued.getProcessesWithOutput.mockReturnValue([{}])

		const withUnretrieved = makeVsce("/b", { process: { hasUnretrievedOutput: () => true } })

		const empty = makeVsce("/c", { process: { hasUnretrievedOutput: () => false } })
		const noProcess = makeVsce("/d")

		const result = TerminalRegistry.getBackgroundTerminals()

		expect(result).toEqual([withQueued, withUnretrieved])
		expect(result).not.toContain(empty)
		expect(result).not.toContain(noProcess)
	})
})

// --- 7. 解放と後片付け ---------------------------------------------------------

describe("TerminalRegistry - 解放", () => {
	it("releaseTerminalsForTask は該当 task のものだけ手放す", () => {
		const mine = makeVsce("/a", { taskId: "task-1" })
		const other = makeVsce("/b", { taskId: "task-2" })

		TerminalRegistry.releaseTerminalsForTask("task-1")

		expect(mine.taskId).toBeUndefined()
		expect(other.taskId).toBe("task-2")
		// 手放すだけで台帳からは消さない。
		expect(registered()).toEqual([mine, other])
	})

	it("cleanup は一時ディレクトリを一掃し、購読を全部 dispose する", () => {
		TerminalRegistry.initialize()
		const disposables = internals.disposables.slice()

		TerminalRegistry.cleanup()

		expect(shellIntegrationMock.clear).toHaveBeenCalledTimes(1)
		expect(disposables).toHaveLength(3)
		for (const disposable of disposables) {
			expect(disposable.dispose).toHaveBeenCalledTimes(1)
		}
		expect(internals.disposables).toEqual([])
	})

	it("cleanup を 2 回呼んでも同じ購読を二重 dispose しない", () => {
		TerminalRegistry.initialize()
		const disposables = internals.disposables.slice()

		TerminalRegistry.cleanup()
		TerminalRegistry.cleanup()

		for (const disposable of disposables) {
			expect(disposable.dispose).toHaveBeenCalledTimes(1)
		}
		expect(shellIntegrationMock.clear).toHaveBeenCalledTimes(2)
	})
})
