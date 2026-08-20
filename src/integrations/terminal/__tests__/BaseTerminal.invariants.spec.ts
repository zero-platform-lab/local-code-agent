// npx vitest run integrations/terminal/__tests__/BaseTerminal.invariants.spec.ts
//
// BaseTerminal は「プロセスを起動して制御する」層の土台。ここで固定する不変条件:
//   - 破棄したプロセス（process=undefined）が再利用されない／二重解放で壊れない
//   - process が無いのに stream を渡されても running を落として黙って戻る
//     （利用者起動の非 Agent コマンドを Agent のものと取り違えない）
//   - 未取得出力を持つプロセスだけが完了キューに積まれ、取得済みは掃除される
//   - 出力の巨大化は RLE + 打ち切りで抑える
//   - static な設定値はセッタ経由でのみ変わり、取得は一貫している
//
// BaseTerminal は abstract なので最小の具象サブクラスで検証する。vscode も execa も
// 触らない純粋なクラスなのでモックは不要（プロセスは全て贋物のイベントエミッタ）。

import { describe, it, expect, beforeEach, vi } from "vitest"

import { BaseTerminal } from "../BaseTerminal"
import type { AgentTerminalCallbacks, AgentTerminalProcess, AgentTerminalProcessResultPromise } from "../types"

// --- テスト用の最小具象ターミナル -------------------------------------------

class TestTerminal extends BaseTerminal {
	public override isClosed(): boolean {
		return false
	}
	public override runCommand(
		_command: string,
		_callbacks: AgentTerminalCallbacks,
	): AgentTerminalProcessResultPromise {
		// 本テストでは runCommand は呼ばない（サブクラス側で検証する）。
		throw new Error("not used")
	}
}

/** 未取得出力の有無と command 文字列だけ持つ贋プロセス。emit は記録する。 */
function makeProcess(options: { command?: string; hasOutput?: boolean; output?: string } = {}) {
	const emit = vi.fn()
	const trimRetrievedOutput = vi.fn()
	let hasOutput = options.hasOutput ?? false
	const proc = {
		command: options.command ?? "",
		isHot: false,
		emit,
		trimRetrievedOutput,
		hasUnretrievedOutput: vi.fn(() => hasOutput),
		getUnretrievedOutput: vi.fn(() => options.output ?? ""),
		// hasOutput をテスト側から後で書き換えられるように公開
		_setHasOutput: (value: boolean) => {
			hasOutput = value
		},
	}
	return proc as unknown as AgentTerminalProcess & {
		emit: typeof emit
		trimRetrievedOutput: typeof trimRetrievedOutput
		_setHasOutput: (value: boolean) => void
	}
}

describe("BaseTerminal - setActiveStream", () => {
	let terminal: TestTerminal

	beforeEach(() => {
		terminal = new TestTerminal("execa", 1, "/repo")
	})

	it("stream と process が揃えば running を立ててイベントを流す", () => {
		const proc = makeProcess()
		terminal.process = proc
		const stream = (async function* () {})()

		terminal.setActiveStream(stream, 4242)

		expect(terminal.running).toBe(true)
		expect(terminal.isStreamClosed).toBe(false)
		expect(proc.emit).toHaveBeenCalledWith("shell_execution_started", 4242)
		expect(proc.emit).toHaveBeenCalledWith("stream_available", stream)
	})

	it("**process が無いのに stream を渡されたら running を落として黙って戻る**", () => {
		// 利用者が手打ちした非 Agent コマンドのストリームを Agent の出力と取り違えない。
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		terminal.process = undefined
		terminal.running = true
		const stream = (async function* () {})()

		terminal.setActiveStream(stream)

		expect(terminal.running).toBe(false)
		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
	})

	it("undefined を渡すと streamClosed になる", () => {
		terminal.setActiveStream(undefined)
		expect(terminal.isStreamClosed).toBe(true)
	})
})

describe("BaseTerminal - shellExecutionComplete", () => {
	let terminal: TestTerminal

	beforeEach(() => {
		terminal = new TestTerminal("execa", 1, "/repo")
		terminal.busy = true
		terminal.running = true
	})

	it("未取得出力があれば完了キューの先頭に積む", () => {
		const proc = makeProcess({ hasOutput: true })
		terminal.process = proc

		terminal.shellExecutionComplete({ exitCode: 0 })

		expect(terminal.busy).toBe(false)
		expect(terminal.running).toBe(false)
		expect(terminal.completedProcesses[0]).toBe(proc)
		expect(proc.emit).toHaveBeenCalledWith("shell_execution_complete", { exitCode: 0 })
		// 完了後は process を手放す（＝以後このプロセスは再利用されない）
		expect(terminal.process).toBeUndefined()
	})

	it("未取得出力が無ければキューに積まない", () => {
		const proc = makeProcess({ hasOutput: false })
		terminal.process = proc

		terminal.shellExecutionComplete({ exitCode: 0 })

		expect(terminal.completedProcesses).toEqual([])
		expect(terminal.process).toBeUndefined()
	})

	it("最も新しい完了プロセスが先頭に来る（unshift）", () => {
		const first = makeProcess({ hasOutput: true, command: "first" })
		terminal.process = first
		terminal.shellExecutionComplete({ exitCode: 0 })

		const second = makeProcess({ hasOutput: true, command: "second" })
		terminal.process = second
		terminal.shellExecutionComplete({ exitCode: 0 })

		expect(terminal.completedProcesses[0]).toBe(second)
		expect(terminal.completedProcesses[1]).toBe(first)
	})

	it("**process が無い状態での二重完了でも壊れない**", () => {
		const proc = makeProcess({ hasOutput: true })
		terminal.process = proc
		terminal.shellExecutionComplete({ exitCode: 0 })

		// 2 回目は process が undefined。落ちずに何もしない（二重解放耐性）。
		expect(() => terminal.shellExecutionComplete({ exitCode: 0 })).not.toThrow()
		expect(terminal.process).toBeUndefined()
	})
})

describe("BaseTerminal - 完了プロセスキューの掃除と出力取得", () => {
	let terminal: TestTerminal

	beforeEach(() => {
		terminal = new TestTerminal("execa", 1, "/repo")
	})

	it("getLastCommand: アクティブ → 完了キュー → 空 の順で解決する", () => {
		expect(terminal.getLastCommand()).toBe("")

		const completed = makeProcess({ command: "old", hasOutput: true })
		terminal.completedProcesses = [completed]
		expect(terminal.getLastCommand()).toBe("old")

		const active = makeProcess({ command: "current" })
		terminal.process = active
		expect(terminal.getLastCommand()).toBe("current")
	})

	it("getLastCommand: command が falsy なら空文字を返す", () => {
		terminal.process = makeProcess({ command: "" })
		expect(terminal.getLastCommand()).toBe("")

		terminal.process = undefined
		terminal.completedProcesses = [makeProcess({ command: "" })]
		expect(terminal.getLastCommand()).toBe("")
	})

	it("cleanCompletedProcessQueue は出力の無いプロセスだけ捨て、残りは trim する", () => {
		const keep = makeProcess({ hasOutput: true })
		const drop = makeProcess({ hasOutput: false })
		terminal.completedProcesses = [keep, drop]

		terminal.cleanCompletedProcessQueue()

		expect(terminal.completedProcesses).toEqual([keep])
		expect(keep.trimRetrievedOutput).toHaveBeenCalledTimes(1)
		expect(drop.trimRetrievedOutput).toHaveBeenCalledTimes(1)
	})

	it("getProcessesWithOutput は掃除後のコピーを返す", () => {
		const keep = makeProcess({ hasOutput: true })
		const drop = makeProcess({ hasOutput: false })
		terminal.completedProcesses = [keep, drop]

		const result = terminal.getProcessesWithOutput()

		expect(result).toEqual([keep])
		// コピーであること（内部配列とは別参照）
		expect(result).not.toBe(terminal.completedProcesses)
	})

	it("getUnretrievedOutput は完了キュー→アクティブの順で連結し、最後に掃除する", () => {
		const completed = makeProcess({ hasOutput: true, output: "done-out\n" })
		const active = makeProcess({ hasOutput: true, output: "active-out\n" })
		terminal.completedProcesses = [completed]
		terminal.process = active

		const output = terminal.getUnretrievedOutput()

		expect(output).toBe("done-out\nactive-out\n")
	})

	it("getUnretrievedOutput: アクティブ出力が空でも完了分だけ返す", () => {
		const completed = makeProcess({ hasOutput: true, output: "only-done\n" })
		terminal.completedProcesses = [completed]
		// アクティブ出力が空文字 → 連結されない分岐
		terminal.process = makeProcess({ hasOutput: true, output: "" })

		expect(terminal.getUnretrievedOutput()).toBe("only-done\n")
	})

	it("getUnretrievedOutput: process が無くても完了キューだけで動く", () => {
		// 完了プロセスの出力が空文字 → `if (processOutput)` の false 分岐
		terminal.completedProcesses = [makeProcess({ hasOutput: true, output: "" })]
		terminal.process = undefined

		expect(terminal.getUnretrievedOutput()).toBe("")
	})
})

describe("BaseTerminal - compressTerminalOutput", () => {
	it("巨大出力を RLE + 行/文字数上限で打ち切る", () => {
		const huge = "line\n".repeat(2000)
		const compressed = BaseTerminal.compressTerminalOutput(huge)

		expect(compressed.length).toBeLessThan(huge.length)
	})

	it("短い出力はそのまま通す", () => {
		expect(BaseTerminal.compressTerminalOutput("hello\n")).toBe("hello\n")
	})
})

describe("BaseTerminal - static 設定値のセッタ/ゲッタ", () => {
	it("shell integration timeout は既定に戻せる", () => {
		const original = BaseTerminal.getShellIntegrationTimeout()
		BaseTerminal.setShellIntegrationTimeout(1234)
		expect(BaseTerminal.getShellIntegrationTimeout()).toBe(1234)
		BaseTerminal.setShellIntegrationTimeout(original)
	})

	it("shell integration disabled フラグ", () => {
		BaseTerminal.setShellIntegrationDisabled(true)
		expect(BaseTerminal.getShellIntegrationDisabled()).toBe(true)
		BaseTerminal.setShellIntegrationDisabled(false)
		expect(BaseTerminal.getShellIntegrationDisabled()).toBe(false)
	})

	it("command delay", () => {
		BaseTerminal.setCommandDelay(50)
		expect(BaseTerminal.getCommandDelay()).toBe(50)
		BaseTerminal.setCommandDelay(0)
	})

	it("zdotdir", () => {
		BaseTerminal.setTerminalZdotdir(true)
		expect(BaseTerminal.getTerminalZdotdir()).toBe(true)
		BaseTerminal.setTerminalZdotdir(false)
	})

	it("execa shell path", () => {
		BaseTerminal.setExecaShellPath("/bin/zsh")
		expect(BaseTerminal.getExecaShellPath()).toBe("/bin/zsh")
		BaseTerminal.setExecaShellPath(undefined)
		expect(BaseTerminal.getExecaShellPath()).toBeUndefined()
	})
})
