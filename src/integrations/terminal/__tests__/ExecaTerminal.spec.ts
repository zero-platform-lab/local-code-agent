// npx vitest run integrations/terminal/__tests__/ExecaTerminal.spec.ts
//
// ExecaTerminal は execa で **本物のプロセスを起動する** 層。旧テストは実際に `ls -al`
// を走らせていたが、この層のテストは「絶対に本物のシェル/プロセスを起動しない」を
// 不変条件とする。したがって execa / ps-tree は完全にモックし、
//   - runCommand に渡した文字列がそのまま execa のタグ付きテンプレートに届くこと
//   - シェル引数（shell / cwd / stdin / env）が全件期待通りであること
//   - busy を即座に立てること・各コールバックが確実に呼ばれること
//   - VSCode ターミナルと違い ExecaTerminal は決して閉じないこと
// をアサートする。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// execa の呼び出し引数と、タグ付きテンプレートに渡ったコマンドを記録する。
const execaState = vi.hoisted(() => ({
	options: [] as Array<Record<string, unknown>>,
	commands: [] as string[],
	chunks: ["hello\n"] as Array<string | Uint8Array>,
	pid: 4321 as number | undefined,
	kill: undefined as unknown,
}))

vi.mock("execa", () => {
	const execa = vi.fn((options: Record<string, unknown>) => {
		execaState.options.push(options)
		return (_template: TemplateStringsArray, ...args: unknown[]) => {
			execaState.commands.push(String(args[0]))
			return {
				pid: execaState.pid,
				iterable: (_opts: unknown) =>
					(async function* () {
						for (const chunk of execaState.chunks) {
							yield chunk
						}
					})(),
				kill: execaState.kill,
			}
		}
	})
	return { execa, ExecaError: class ExecaError extends Error {} }
})

vi.mock("ps-tree", () => ({
	default: vi.fn((_pid: number, cb: (err: Error | null, children: unknown[]) => void) => cb(null, [])),
}))

import { execa } from "execa"
import { ExecaTerminal } from "../ExecaTerminal"
import { BaseTerminal } from "../BaseTerminal"
import type { AgentTerminalCallbacks } from "../types"

function makeCallbacks(): AgentTerminalCallbacks & {
	onLine: ReturnType<typeof vi.fn>
	onCompleted: ReturnType<typeof vi.fn>
	onShellExecutionStarted: ReturnType<typeof vi.fn>
	onShellExecutionComplete: ReturnType<typeof vi.fn>
} {
	return {
		onLine: vi.fn(),
		onCompleted: vi.fn(),
		onShellExecutionStarted: vi.fn(),
		onShellExecutionComplete: vi.fn(),
	}
}

beforeEach(() => {
	execaState.options = []
	execaState.commands = []
	execaState.chunks = ["hello\n"]
	execaState.pid = 4321
	execaState.kill = vi.fn()
	BaseTerminal.setExecaShellPath(undefined)
	vi.clearAllMocks()
})

afterEach(() => {
	BaseTerminal.setExecaShellPath(undefined)
})

describe("ExecaTerminal - isClosed", () => {
	it("**VSCode ターミナルと違い決して閉じない**", () => {
		const terminal = new ExecaTerminal(1, "/tmp")
		expect(terminal.isClosed()).toBe(false)
	})
})

describe("ExecaTerminal - runCommand", () => {
	it("busy を即座に立て、渡した文字列がそのまま execa に届く", async () => {
		const terminal = new ExecaTerminal(7, "/work/dir")
		const cb = makeCallbacks()

		const promise = terminal.runCommand("echo hi && ls", cb)
		// runCommand は同期的に busy を立てる（別インスタンスに横取りされないため）
		expect(terminal.busy).toBe(true)
		await promise

		// **実際に走ったコマンド文字列**が入力と一致すること
		expect(execaState.commands).toEqual(["echo hi && ls"])
	})

	it("シェル引数（shell/cwd/stdin/all/env）が全件期待通り", async () => {
		const terminal = new ExecaTerminal(1, "/repo/here")
		const cb = makeCallbacks()

		await terminal.runCommand("pwd", cb)

		expect(vi.mocked(execa)).toHaveBeenCalledWith(
			expect.objectContaining({
				shell: true,
				cwd: "/repo/here",
				all: true,
				stdin: "ignore",
				env: expect.objectContaining({
					LANG: "en_US.UTF-8",
					LC_ALL: "en_US.UTF-8",
				}),
			}),
		)
	})

	it("execaShellPath が設定されていればそれをシェルに使う", async () => {
		BaseTerminal.setExecaShellPath("/bin/bash")
		const terminal = new ExecaTerminal(1, "/repo")
		const cb = makeCallbacks()

		await terminal.runCommand("true", cb)

		expect((execaState.options[0] as { shell: unknown }).shell).toBe("/bin/bash")
	})

	it("各コールバックが配線され、完了時に出力とイベントが届く", async () => {
		const terminal = new ExecaTerminal(1, "/repo")
		const cb = makeCallbacks()

		await terminal.runCommand("echo hello", cb)

		expect(cb.onShellExecutionStarted).toHaveBeenCalledWith(4321, expect.anything())
		expect(cb.onLine).toHaveBeenCalledWith("hello\n", expect.anything())
		expect(cb.onShellExecutionComplete).toHaveBeenCalledWith({ exitCode: 0 }, expect.anything())
		expect(cb.onCompleted).toHaveBeenCalledWith("hello\n", expect.anything())
		// 完了したら busy は落ちている
		expect(terminal.busy).toBe(false)
	})

	it("runCommand の戻り値は Promise 兼プロセス（mergePromise）", async () => {
		const terminal = new ExecaTerminal(1, "/repo")
		const cb = makeCallbacks()

		const result = terminal.runCommand("true", cb)
		expect(typeof result.then).toBe("function")
		expect(typeof result.abort).toBe("function")
		await result
	})
})
