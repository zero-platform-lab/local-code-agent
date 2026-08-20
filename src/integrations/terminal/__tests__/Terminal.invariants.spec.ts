// npx vitest run integrations/terminal/__tests__/Terminal.invariants.spec.ts
//
// Terminal（VSCode ターミナル）層の不変条件を固定する。ここでは実プロセスも実 VSCode も
// 起動しない: vscode / TerminalProcess / p-wait-for / ShellIntegrationManager は全てモック。
//   - runCommand は shell integration を待ってから **入力そのままの command** を run に渡す
//   - shell integration が来なければ no_shell_integration を通知して中断（放置しない）
//   - コールバックは run 前に配線され、各イベントが確実に届く
//   - getEnv が Agent 用の環境変数（ROO_ACTIVE / PAGER / VTE 無効化ほか）を組み立てる
//   - getTerminalContents はクリップボードを必ず元に戻す（例外時も）

import { EventEmitter } from "events"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"

// --- vscode モック -----------------------------------------------------------

vi.mock("vscode", () => {
	const clipboard = {
		readText: vi.fn(async () => ""),
		writeText: vi.fn(async () => undefined),
	}
	return {
		window: {
			createTerminal: vi.fn(() => ({
				exitStatus: undefined,
				shellIntegration: undefined,
				sendText: vi.fn(),
				show: vi.fn(),
			})),
		},
		commands: { executeCommand: vi.fn(async () => undefined) },
		workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn() })) },
		env: { clipboard },
		ThemeIcon: class {
			id: string
			constructor(id: string) {
				this.id = id
			}
		},
	}
})

// --- TerminalProcess モック（実 run はしない、イベントは本物の EventEmitter で流す） ----

class FakeTerminalProcess extends EventEmitter {
	public command = ""
	public isHot = false
	public run = vi.fn()
	public continue = vi.fn()
	public abort = vi.fn()
	constructor(public owner: unknown) {
		super()
	}
}

vi.mock("../TerminalProcess", () => ({
	TerminalProcess: vi.fn((owner: unknown) => new FakeTerminalProcess(owner)),
}))

// --- p-wait-for モック（shell integration 待ちの成否をテストごとに切り替え） ----------

const pWaitState = vi.hoisted(() => ({ resolve: true }))
vi.mock("p-wait-for", () => ({
	default: vi.fn(async () => {
		if (!pWaitState.resolve) {
			throw new Error("shell integration timeout")
		}
	}),
}))

// --- ShellIntegrationManager モック -----------------------------------------

const shellIntegrationMock = vi.hoisted(() => ({
	terminalTmpDirs: new Map<number, string>(),
	zshInitTmpDir: vi.fn(() => "/tmp/zdotdir"),
	zshCleanupTmpDir: vi.fn(),
}))
vi.mock("../ShellIntegrationManager", () => ({
	ShellIntegrationManager: shellIntegrationMock,
}))

import { Terminal } from "../Terminal"
import { BaseTerminal } from "../BaseTerminal"
import type { AgentTerminalCallbacks } from "../types"

function makeVscodeTerminal(overrides: Record<string, unknown> = {}) {
	return {
		exitStatus: undefined,
		shellIntegration: { executeCommand: vi.fn() },
		sendText: vi.fn(),
		show: vi.fn(),
		...overrides,
	} as unknown as vscode.Terminal
}

function makeCallbacks() {
	return {
		onLine: vi.fn(),
		onCompleted: vi.fn(),
		onShellExecutionStarted: vi.fn(),
		onShellExecutionComplete: vi.fn(),
		onNoShellIntegration: vi.fn(),
	} satisfies AgentTerminalCallbacks
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
	pWaitState.resolve = true
	shellIntegrationMock.terminalTmpDirs.clear()
	BaseTerminal.setTerminalZdotdir(false)
	BaseTerminal.setCommandDelay(0)
	BaseTerminal.setShellIntegrationTimeout(5000)
	vi.clearAllMocks()
})

afterEach(() => {
	BaseTerminal.setTerminalZdotdir(false)
	BaseTerminal.setCommandDelay(0)
})

// --- constructor -------------------------------------------------------------

describe("Terminal - constructor", () => {
	it("terminal を渡せばそれを使い、createTerminal は呼ばない", () => {
		const provided = makeVscodeTerminal()
		const term = new Terminal(1, provided, "/repo")
		expect(term.terminal).toBe(provided)
		expect(vscode.window.createTerminal).not.toHaveBeenCalled()
	})

	it("terminal 未指定なら Agent 用の設定で createTerminal する", () => {
		new Terminal(2, undefined, "/repo")
		expect(vscode.window.createTerminal).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/repo", name: "Agent" }),
		)
	})

	it("zdotdir 有効なら terminalTmpDirs に ZDOTDIR を登録する", () => {
		BaseTerminal.setTerminalZdotdir(true)
		new Terminal(9, makeVscodeTerminal(), "/repo")
		expect(shellIntegrationMock.terminalTmpDirs.get(9)).toBe("/tmp/zdotdir")
	})
})

// --- getCurrentWorkingDirectory / isClosed ----------------------------------

describe("Terminal - getCurrentWorkingDirectory / isClosed", () => {
	it("shellIntegration.cwd があればその fsPath を返す", () => {
		const term = new Terminal(
			1,
			makeVscodeTerminal({ shellIntegration: { cwd: { fsPath: "/actual/dir" } } }),
			"/init",
		)
		expect(term.getCurrentWorkingDirectory()).toBe("/actual/dir")
	})

	it("shellIntegration.cwd が無ければ初期 cwd を返す", () => {
		const term = new Terminal(1, makeVscodeTerminal({ shellIntegration: {} }), "/init")
		expect(term.getCurrentWorkingDirectory()).toBe("/init")
	})

	it("shellIntegration 自体が無ければ初期 cwd を返す", () => {
		const term = new Terminal(1, makeVscodeTerminal({ shellIntegration: undefined }), "/init")
		expect(term.getCurrentWorkingDirectory()).toBe("/init")
	})

	it("isClosed は exitStatus の有無で判定する", () => {
		const open = new Terminal(1, makeVscodeTerminal({ exitStatus: undefined }), "/repo")
		expect(open.isClosed()).toBe(false)

		const closed = new Terminal(2, makeVscodeTerminal({ exitStatus: { code: 0 } }), "/repo")
		expect(closed.isClosed()).toBe(true)
	})
})

// --- runCommand --------------------------------------------------------------

describe("Terminal - runCommand", () => {
	it("busy を即座に立て、shell integration 到達後に **入力そのままの command** を run へ渡す", async () => {
		const term = new Terminal(1, makeVscodeTerminal(), "/repo")
		const cb = makeCallbacks()

		const merged = term.runCommand("echo hi && ls -al", cb)
		expect(term.busy).toBe(true)

		await flush()
		const proc = term.process as unknown as FakeTerminalProcess
		expect(shellIntegrationMock.zshCleanupTmpDir).toHaveBeenCalledWith(1)
		expect(proc.run).toHaveBeenCalledWith("echo hi && ls -al")

		proc.emit("continue")
		await merged
	})

	it("コールバックが run 前に配線され、各イベントが届く", async () => {
		const term = new Terminal(3, makeVscodeTerminal(), "/repo")
		const cb = makeCallbacks()

		const merged = term.runCommand("pwd", cb)
		await flush()
		const proc = term.process as unknown as FakeTerminalProcess

		proc.emit("line", "hello")
		proc.emit("shell_execution_started", 4242)
		proc.emit("shell_execution_complete", { exitCode: 0 })
		proc.emit("completed", "hello")

		expect(cb.onLine).toHaveBeenCalledWith("hello", proc)
		expect(cb.onShellExecutionStarted).toHaveBeenCalledWith(4242, proc)
		expect(cb.onShellExecutionComplete).toHaveBeenCalledWith({ exitCode: 0 }, proc)
		expect(cb.onCompleted).toHaveBeenCalledWith("hello", proc)

		proc.emit("continue")
		await merged
	})

	it("**shell integration が来なければ no_shell_integration を通知して中断する**", async () => {
		pWaitState.resolve = false
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
		const term = new Terminal(5, makeVscodeTerminal({ shellIntegration: undefined }), "/repo")
		const cb = makeCallbacks()

		term.runCommand("sleep 100", cb)
		await flush()

		const proc = term.process as unknown as FakeTerminalProcess
		// run は呼ばれない（コマンド実行は中断）
		expect(proc.run).not.toHaveBeenCalled()
		expect(shellIntegrationMock.zshCleanupTmpDir).toHaveBeenCalledWith(5)
		expect(cb.onNoShellIntegration).toHaveBeenCalledWith(
			expect.stringContaining("Shell integration initialization sequence"),
			proc,
		)
		consoleLog.mockRestore()
	})

	it("process が error を出したら reject する", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const term = new Terminal(6, makeVscodeTerminal(), "/repo")
		const cb = makeCallbacks()

		const merged = term.runCommand("boom", cb)
		await flush()
		const proc = term.process as unknown as FakeTerminalProcess

		proc.emit("error", new Error("kaboom"))

		await expect(merged).rejects.toThrow("kaboom")
		consoleError.mockRestore()
	})
})

// --- getEnv ------------------------------------------------------------------

describe("Terminal - getEnv", () => {
	const originalPlatform = process.platform

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
	})

	it("既定では ROO_ACTIVE / PAGER=cat / VTE 無効を設定する（非 win32）", () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true })
		const env = Terminal.getEnv()
		expect(env.ROO_ACTIVE).toBe("true")
		expect(env.PAGER).toBe("cat")
		expect(env.VTE_VERSION).toBe("0")
	})

	it("win32 では PAGER を空にする", () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
		expect(Terminal.getEnv().PAGER).toBe("")
	})

	it("commandDelay / zdotdir の各設定を反映する", () => {
		BaseTerminal.setCommandDelay(2000)
		BaseTerminal.setTerminalZdotdir(true)

		const env = Terminal.getEnv()
		expect(env.PROMPT_COMMAND).toBe("sleep 2")
		expect(env.ZDOTDIR).toBe("/tmp/zdotdir")
		expect(shellIntegrationMock.zshInitTmpDir).toHaveBeenCalled()
	})
})

// --- getTerminalContents -----------------------------------------------------

describe("Terminal - getTerminalContents", () => {
	const clipboard = vscode.env.clipboard as unknown as {
		readText: ReturnType<typeof vi.fn>
		writeText: ReturnType<typeof vi.fn>
	}
	const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>

	it("commands<0 なら全選択し、複数行を整形し、クリップボードを元に戻す", async () => {
		clipboard.readText.mockResolvedValueOnce("ORIGINAL").mockResolvedValueOnce("$ ls\nfile1\nfile2\n$ ls")

		const result = await Terminal.getTerminalContents(-1)

		expect(executeCommand).toHaveBeenCalledWith("workbench.action.terminal.selectAll")
		expect(executeCommand).toHaveBeenCalledWith("workbench.action.terminal.copySelection")
		expect(executeCommand).toHaveBeenCalledWith("workbench.action.terminal.clearSelection")
		// クリップボードは元の内容へ復元される
		expect(clipboard.writeText).toHaveBeenCalledWith("ORIGINAL")
		expect(result).toContain("$ ls")
	})

	it("commands>=0 なら直前コマンドまで指定回数だけ選択を広げる", async () => {
		clipboard.readText.mockResolvedValueOnce("ORIGINAL").mockResolvedValueOnce("only line")

		await Terminal.getTerminalContents(2)

		const selectToPrev = executeCommand.mock.calls.filter(
			([cmd]) => cmd === "workbench.action.terminal.selectToPreviousCommand",
		)
		expect(selectToPrev).toHaveLength(2)
	})

	it("何もコピーされなければ（元と同一なら）空文字を返す", async () => {
		clipboard.readText.mockResolvedValueOnce("SAME").mockResolvedValueOnce("SAME")
		expect(await Terminal.getTerminalContents(-1)).toBe("")
	})

	it("例外時もクリップボードを元に戻してから再スローする", async () => {
		clipboard.readText.mockResolvedValueOnce("ORIGINAL")
		executeCommand.mockRejectedValueOnce(new Error("copy failed"))

		await expect(Terminal.getTerminalContents(-1)).rejects.toThrow("copy failed")
		expect(clipboard.writeText).toHaveBeenCalledWith("ORIGINAL")
	})
})
