// npx vitest run integrations/terminal/__tests__/ExecaTerminalProcess.invariants.spec.ts
//
// ExecaTerminalProcess は execa 経由で **本物のサブプロセスを起動して制御する** 層。
// ここで固定する不変条件（事故が起きる側の経路）:
//   - abort / aborted で subprocess と PID・子プロセスが確実に kill され、放置されない
//   - kill が失敗しても（既に死んでいる等）握りつぶして先へ進む
//   - PID は「シェルの PID」から「実コマンドの PID」へ更新される
//   - ストリームが Uint8Array を返しても文字列化して壊れない
//   - 実行エラー（ExecaError / それ以外）が shell_execution_complete に必ず載る
//   - 破棄参照（WeakRef 切れ）は例外で気付ける
//
// **本物のプロセスは絶対に起動しない**: execa / ps-tree はモックし、process.kill は spy で
// 潰して実シグナルを一切飛ばさない。

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest"

// execa: タグ付きテンプレート呼び出しの結果（subprocess）をテストごとに差し替える。
// ExecaError クラスはモックとテスト側で同一参照を共有する必要があるため hoisted に置く
// （ExecaTerminalProcess.ts の `error instanceof ExecaError` を正しく踏ませるため）。
const execaState = vi.hoisted(() => {
	class ExecaError extends Error {
		exitCode?: number
		signal?: string
	}
	return {
		ExecaError,
		build: null as null | ((options: Record<string, unknown>, args: unknown[]) => unknown),
		options: [] as Array<Record<string, unknown>>,
		commands: [] as string[],
	}
})

vi.mock("execa", () => {
	const execa = vi.fn((options: Record<string, unknown>) => {
		execaState.options.push(options)
		return (_template: TemplateStringsArray, ...args: unknown[]) => {
			execaState.commands.push(String(args[0]))
			return execaState.build!(options, args)
		}
	})
	return { execa, ExecaError: execaState.ExecaError }
})

// ps-tree: 返す子プロセス一覧とエラーをテストごとに差し替える。
const psTreeState = vi.hoisted(() => ({
	children: [] as Array<{ PID: string }>,
	err: null as Error | null,
}))

vi.mock("ps-tree", () => ({
	default: vi.fn((_pid: number, cb: (err: Error | null, children: Array<{ PID: string }>) => void) =>
		cb(psTreeState.err, psTreeState.children),
	),
}))

import { ExecaTerminalProcess } from "../ExecaTerminalProcess"
import type { AgentTerminal } from "../types"

// モックが返すのと同一の ExecaError クラス（instanceof を成立させる）。
const ExecaError = execaState.ExecaError

// --- subprocess の贋物ビルダー ----------------------------------------------

type SubprocessMode = "normal" | "hang" | "reject"

interface SubprocessConfig {
	pid?: number
	chunks?: Array<string | Uint8Array>
	/** iterable がスローする値（execa 実行エラーの模擬）。Error 以外も投げられる。 */
	throwError?: unknown
	/** aborted 経路での Promise.race の挙動。 */
	mode?: SubprocessMode
	/** mode="reject" のとき reject する値（Error 以外の分岐用）。 */
	rejectValue?: unknown
	kill?: (...args: unknown[]) => void
}

function makeSubprocess(config: SubprocessConfig = {}) {
	const { pid = 1000, chunks = ["out\n"], mode = "normal", kill = vi.fn() } = config
	const hasThrow = "throwError" in config
	const sub: Record<string, unknown> = {
		pid,
		kill,
		iterable: (_opts: unknown) =>
			(async function* () {
				if (hasThrow) {
					throw config.throwError
				}
				for (const chunk of chunks) {
					yield chunk
				}
			})(),
	}
	// aborted 経路の `await Promise.race([subprocess, kill])` を制御するため、
	// hang は解決しない thenable、reject は即 reject する thenable にする。
	if (mode === "hang") {
		sub.then = () => {}
	} else if (mode === "reject") {
		const value = "rejectValue" in config ? config.rejectValue : new Error("subprocess failed")
		sub.then = (_res: unknown, rej: (e: unknown) => void) => rej(value)
	}
	return sub
}

function makeTerminal(): AgentTerminal & { setActiveStream: ReturnType<typeof vi.fn> } {
	return {
		provider: "execa",
		id: 1,
		busy: false,
		running: false,
		getCurrentWorkingDirectory: vi.fn(() => "/test/cwd"),
		isClosed: vi.fn(() => false),
		runCommand: vi.fn(),
		setActiveStream: vi.fn(),
		shellExecutionComplete: vi.fn(),
		getProcessesWithOutput: vi.fn(() => []),
		getUnretrievedOutput: vi.fn(() => ""),
		getLastCommand: vi.fn(() => ""),
		cleanCompletedProcessQueue: vi.fn(),
	} as unknown as AgentTerminal & { setActiveStream: ReturnType<typeof vi.fn> }
}

let killSpy: MockInstance<typeof process.kill>

beforeEach(() => {
	execaState.build = (_o, _a) => makeSubprocess()
	execaState.options = []
	execaState.commands = []
	psTreeState.children = []
	psTreeState.err = null
	// 実シグナルを一切飛ばさない最後の砦。
	killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)
})

afterEach(() => {
	killSpy.mockRestore()
	vi.useRealTimers()
	vi.clearAllMocks()
})

// --- terminal 参照 -----------------------------------------------------------

describe("ExecaTerminalProcess - terminal 参照", () => {
	it("WeakRef が切れていたら terminal 参照で例外を投げる", () => {
		const proc = new ExecaTerminalProcess(makeTerminal())
		;(proc as unknown as { terminalRef: { deref: () => unknown } }).terminalRef = { deref: () => undefined }

		expect(() => proc.terminal).toThrow("Unable to dereference terminal")
	})
})

// --- ストリーム処理 ----------------------------------------------------------

describe("ExecaTerminalProcess - ストリーム処理", () => {
	it("Uint8Array のチャンクも文字列化して蓄積する", async () => {
		const encoded = new TextEncoder().encode("バイナリ chunk\n")
		execaState.build = () => makeSubprocess({ chunks: [encoded] })
		const proc = new ExecaTerminalProcess(makeTerminal())
		const completed = vi.fn()
		proc.on("completed", completed)

		await proc.run("echo bin")

		expect(completed).toHaveBeenCalledWith("バイナリ chunk\n")
	})

	it("PID はシェルの PID から実コマンドの PID へ更新される", async () => {
		execaState.build = () => makeSubprocess({ pid: 5000 })
		psTreeState.children = [{ PID: "5001" }]
		const proc = new ExecaTerminalProcess(makeTerminal())

		await proc.run("sleep 1")
		// pidUpdate は 100ms の setTimeout の中で走るので待つ
		await new Promise((r) => setTimeout(r, 150))

		expect((proc as unknown as { pid: number }).pid).toBe(5001)
	})

	it("前回 emit から 500ms 以上あくと再送スロットルを通す", async () => {
		// 節流条件 `now - lastEmitTime_ms > 500 || lastEmitTime_ms === 0` の左オペランドを踏む。
		// 1 チャンク目で lastEmitTime_ms を確定させ、2 チャンク目までに擬似時刻を進める。
		vi.useFakeTimers()
		vi.setSystemTime(0)
		execaState.build = () => {
			const sub = makeSubprocess()
			sub.iterable = () =>
				(async function* () {
					yield "a\n"
					vi.setSystemTime(1000)
					yield "b\n"
				})()
			return sub
		}
		const proc = new ExecaTerminalProcess(makeTerminal())
		const line = vi.fn()
		proc.on("line", line)

		await proc.run("echo ab")

		expect(line).toHaveBeenCalled()
		vi.useRealTimers()
	})

	it("子 PID が数値にならなければシェル PID のまま", async () => {
		execaState.build = () => makeSubprocess({ pid: 5000 })
		psTreeState.children = [{ PID: "notanumber" }]
		const proc = new ExecaTerminalProcess(makeTerminal())

		await proc.run("sleep 1")
		await new Promise((r) => setTimeout(r, 150))

		expect((proc as unknown as { pid: number }).pid).toBe(5000)
	})
})

// --- 実行エラーの報告 --------------------------------------------------------

describe("ExecaTerminalProcess - 実行エラーの報告", () => {
	it("ExecaError は exitCode と signal を shell_execution_complete に載せる", async () => {
		const error = new ExecaError("boom")
		error.exitCode = 42
		error.signal = "SIGINT"
		execaState.build = () => makeSubprocess({ throwError: error })
		const proc = new ExecaTerminalProcess(makeTerminal())
		const complete = vi.fn()
		const completed = vi.fn()
		proc.on("shell_execution_complete", complete)
		proc.on("completed", completed)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await proc.run("bad-cmd")

		expect(complete).toHaveBeenCalledWith({ exitCode: 42, signalName: "SIGINT" })
		// エラーでも completed / continue は必ず出す（呼び出し側を止めない）
		expect(completed).toHaveBeenCalled()
		consoleError.mockRestore()
	})

	it("ExecaError で exitCode が無ければ 0 として扱う", async () => {
		const error = new ExecaError("boom-no-code")
		execaState.build = () => makeSubprocess({ throwError: error })
		const proc = new ExecaTerminalProcess(makeTerminal())
		const complete = vi.fn()
		proc.on("shell_execution_complete", complete)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await proc.run("bad-cmd")

		expect(complete).toHaveBeenCalledWith({ exitCode: 0, signalName: undefined })
		consoleError.mockRestore()
	})

	it("ExecaError 以外のエラーは exitCode 1 として扱う", async () => {
		execaState.build = () => makeSubprocess({ throwError: new Error("generic failure") })
		const proc = new ExecaTerminalProcess(makeTerminal())
		const complete = vi.fn()
		proc.on("shell_execution_complete", complete)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await proc.run("bad-cmd")

		expect(complete).toHaveBeenCalledWith({ exitCode: 1 })
		consoleError.mockRestore()
	})

	it("Error でない値が投げられても String 化して exitCode 1 を返す", async () => {
		// `error instanceof Error ? error.message : String(error)` の String 側を踏む
		execaState.build = () => makeSubprocess({ throwError: "just a string" })
		const proc = new ExecaTerminalProcess(makeTerminal())
		const complete = vi.fn()
		proc.on("shell_execution_complete", complete)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await proc.run("bad-cmd")

		expect(complete).toHaveBeenCalledWith({ exitCode: 1 })
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("just a string"))
		consoleError.mockRestore()
	})
})

// --- aborted 経路（ストリーム中断→kill） -------------------------------------

describe("ExecaTerminalProcess - aborted 経路", () => {
	it("aborted 済みならストリームを打ち切り、race で片付けて完了する", async () => {
		execaState.build = () => makeSubprocess({ chunks: ["a\n", "b\n"] })
		const proc = new ExecaTerminalProcess(makeTerminal())
		;(proc as unknown as { aborted: boolean }).aborted = true
		const complete = vi.fn()
		proc.on("shell_execution_complete", complete)
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})

		await proc.run("sleep 100")

		// 打ち切ったので出力は溜まらない
		expect((proc as unknown as { fullOutput: string }).fullOutput).toBe("")
		expect(complete).toHaveBeenCalledWith({ exitCode: 0 })
		consoleLog.mockRestore()
	})

	it("**subprocess が終わらなければ 5 秒後に SIGKILL を送る**", async () => {
		vi.useFakeTimers()
		const kill = vi.fn()
		execaState.build = () => makeSubprocess({ chunks: ["a\n"], mode: "hang", kill })
		const proc = new ExecaTerminalProcess(makeTerminal())
		;(proc as unknown as { aborted: boolean }).aborted = true
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})

		const runPromise = proc.run("sleep 100")
		await vi.advanceTimersByTimeAsync(5_000)
		await runPromise

		expect(kill).toHaveBeenCalledWith("SIGKILL")
		consoleLog.mockRestore()
	})

	it("5 秒後の SIGKILL が失敗しても握りつぶす", async () => {
		vi.useFakeTimers()
		const kill = vi.fn(() => {
			throw new Error("already dead")
		})
		execaState.build = () => makeSubprocess({ chunks: ["a\n"], mode: "hang", kill })
		const proc = new ExecaTerminalProcess(makeTerminal())
		;(proc as unknown as { aborted: boolean }).aborted = true
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
		const complete = vi.fn()
		proc.on("shell_execution_complete", complete)

		const runPromise = proc.run("sleep 100")
		await vi.advanceTimersByTimeAsync(5_000)
		await runPromise

		expect(kill).toHaveBeenCalled()
		expect(complete).toHaveBeenCalledWith({ exitCode: 0 })
		consoleLog.mockRestore()
	})

	it("race が reject しても完了処理は続ける", async () => {
		execaState.build = () => makeSubprocess({ chunks: ["a\n"], mode: "reject" })
		const proc = new ExecaTerminalProcess(makeTerminal())
		;(proc as unknown as { aborted: boolean }).aborted = true
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
		const complete = vi.fn()
		proc.on("shell_execution_complete", complete)

		await proc.run("sleep 100")

		expect(complete).toHaveBeenCalledWith({ exitCode: 0 })
		consoleLog.mockRestore()
	})

	it("race の reject 値が Error でなくても String 化して続ける", async () => {
		// 終了ログの `error instanceof Error ? ... : String(error)` の String 側を踏む
		execaState.build = () => makeSubprocess({ chunks: ["a\n"], mode: "reject", rejectValue: "boom-string" })
		const proc = new ExecaTerminalProcess(makeTerminal())
		;(proc as unknown as { aborted: boolean }).aborted = true
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
		const complete = vi.fn()
		proc.on("shell_execution_complete", complete)

		await proc.run("sleep 100")

		expect(complete).toHaveBeenCalledWith({ exitCode: 0 })
		expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("boom-string"))
		consoleLog.mockRestore()
	})
})

// --- abort() -----------------------------------------------------------------

describe("ExecaTerminalProcess - abort()", () => {
	function primed(config?: SubprocessConfig) {
		const proc = new ExecaTerminalProcess(makeTerminal())
		const sub = makeSubprocess(config)
		;(proc as unknown as { subprocess: unknown }).subprocess = sub
		;(proc as unknown as { pid: number }).pid = 900
		return { proc, sub }
	}

	it("**subprocess・保存 PID・子 PID すべてに SIGKILL を送る**", () => {
		const kill = vi.fn()
		const { proc } = primed({ kill })
		psTreeState.children = [{ PID: "901" }, { PID: "902" }]

		proc.abort()

		// subprocess へ
		expect(kill).toHaveBeenCalledWith("SIGKILL")
		// 保存 PID へ（実シグナルは spy で握り潰し）
		expect(killSpy).toHaveBeenCalledWith(900, "SIGKILL")
		// 子プロセスへ
		expect(killSpy).toHaveBeenCalledWith(901, "SIGKILL")
		expect(killSpy).toHaveBeenCalledWith(902, "SIGKILL")
	})

	it("PID 更新中（pidUpdatePromise あり）でも解決後に kill する", async () => {
		const kill = vi.fn()
		const { proc } = primed({ kill })
		;(proc as unknown as { pidUpdatePromise: Promise<void> }).pidUpdatePromise = Promise.resolve()

		proc.abort()
		// pidUpdatePromise.then(performKill) はマイクロタスク後
		await Promise.resolve()
		await Promise.resolve()

		expect(kill).toHaveBeenCalledWith("SIGKILL")
		expect(killSpy).toHaveBeenCalledWith(900, "SIGKILL")
	})

	it("subprocess.kill・保存 PID・子 PID の kill がどれも投げても警告して続行する", () => {
		const kill = vi.fn(() => {
			throw new Error("subprocess already dead")
		})
		const { proc } = primed({ kill })
		// 子プロセスも居る状態で process.kill が常に失敗する → 子 PID の kill 失敗も握り潰す
		psTreeState.children = [{ PID: "901" }]
		killSpy.mockImplementation(() => {
			throw new Error("no such process")
		})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		expect(() => proc.abort()).not.toThrow()
		// subprocess・保存 PID・子 PID の 3 系統すべてで警告が出る
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to kill subprocess"))
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to kill process 900"))
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to send SIGKILL to child PID 901"))
		warn.mockRestore()
	})

	it("kill が Error でない値を投げても String 化して握り潰す", () => {
		// subprocess.kill / process.kill / 子 PID kill の catch にある
		// `e instanceof Error ? e.message : String(e)` の String 側をまとめて踏む
		const kill = vi.fn(() => {
			throw "subprocess-string-error"
		})
		const { proc } = primed({ kill })
		psTreeState.children = [{ PID: "901" }]
		killSpy.mockImplementation(() => {
			throw "process-string-error"
		})
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		expect(() => proc.abort()).not.toThrow()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("subprocess-string-error"))
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("process-string-error"))
		warn.mockRestore()
	})

	it("プロセスツリー取得に失敗したらエラーを記録するが落ちない", () => {
		const { proc } = primed()
		psTreeState.err = new Error("ps-tree broke")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		expect(() => proc.abort()).not.toThrow()
		expect(consoleError).toHaveBeenCalled()
		consoleError.mockRestore()
	})
})

// --- continue / hasUnretrievedOutput / emit ---------------------------------

describe("ExecaTerminalProcess - その他の制御", () => {
	it("continue はリスニングを止め line リスナを外して continue を出す", () => {
		const proc = new ExecaTerminalProcess(makeTerminal())
		const lineListener = vi.fn()
		const continueListener = vi.fn()
		proc.on("line", lineListener)
		proc.on("continue", continueListener)

		proc.continue()

		expect(continueListener).toHaveBeenCalled()
		expect((proc as unknown as { isListening: boolean }).isListening).toBe(false)
		// line リスナは除去されている
		proc.emit("line", "should-be-ignored")
		expect(lineListener).not.toHaveBeenCalled()
	})

	it("hasUnretrievedOutput は未取得インデックスと出力長を比較する", () => {
		const proc = new ExecaTerminalProcess(makeTerminal())
		;(proc as unknown as { fullOutput: string }).fullOutput = "abc"
		;(proc as unknown as { lastRetrievedIndex: number }).lastRetrievedIndex = 0
		expect(proc.hasUnretrievedOutput()).toBe(true)
		;(proc as unknown as { lastRetrievedIndex: number }).lastRetrievedIndex = 3
		expect(proc.hasUnretrievedOutput()).toBe(false)
	})

	it("リスニングしていなければ残バッファは何も流さない", () => {
		const proc = new ExecaTerminalProcess(makeTerminal())
		;(proc as unknown as { isListening: boolean }).isListening = false
		const line = vi.fn()
		proc.on("line", line)
		;(proc as unknown as { emitRemainingBufferIfListening(): void }).emitRemainingBufferIfListening()

		expect(line).not.toHaveBeenCalled()
	})
})
