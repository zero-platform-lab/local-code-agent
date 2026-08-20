// npx vitest run integrations/terminal/__tests__/TerminalProcess.invariants.spec.ts
//
// TerminalProcess（VSCode shell integration 経由）の事故りやすい経路を固定する:
//   - shell integration ストリームが来なければタイムアウトして中断（放置しない）
//   - PowerShell では回避策コマンドを **明示的に組み立ててから** executeCommand に渡す
//     （組み立てた文字列を全件アサート）
//   - C マーカーが来ないまま終わったら「マーカー無し」を通知して完了する
//   - abort は listening 中のみ CTRL+C(\x03) を送る
//   - 出力抽出（633/133 マーカー処理・未確定行の扱い・マーカー検索の端）の分岐
//
// 実 VSCode / 実プロセスは起動しない。vscode はモックし、shell integration の
// executeCommand も vi.fn。ストリームはテスト側の async generator で供給する。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// vscode.workspace.getConfiguration("...").get("windows") をテストごとに切り替える。
const configState = vi.hoisted(() => ({ windows: undefined as unknown }))
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: (key: string) => (key === "windows" ? configState.windows : undefined),
		})),
	},
	window: { createTerminal: vi.fn() },
	ThemeIcon: class {},
}))

import { TerminalProcess } from "../TerminalProcess"
import { BaseTerminal } from "../BaseTerminal"

interface OwnerOverrides {
	shellIntegration?: unknown
	isStreamClosed?: boolean
	sendText?: ReturnType<typeof vi.fn>
	executeCommand?: ReturnType<typeof vi.fn>
	cmdCounter?: number
}

function makeOwner(overrides: OwnerOverrides = {}) {
	const executeCommand = overrides.executeCommand ?? vi.fn()
	const sendText = overrides.sendText ?? vi.fn()
	const shellIntegration = "shellIntegration" in overrides ? overrides.shellIntegration : { executeCommand }
	return {
		busy: false,
		isStreamClosed: overrides.isStreamClosed ?? false,
		setActiveStream: vi.fn(),
		cmdCounter: overrides.cmdCounter ?? 0,
		terminal: {
			shellIntegration,
			sendText,
		},
	}
}

function makeProcess(overrides: OwnerOverrides = {}) {
	const owner = makeOwner(overrides)
	const proc = new TerminalProcess(owner as never)
	return { proc, owner }
}

async function* streamOf(chunks: string[]) {
	for (const chunk of chunks) {
		yield chunk
	}
}

const originalPlatform = process.platform
function setPlatform(value: string) {
	Object.defineProperty(process, "platform", { value, configurable: true })
}

beforeEach(() => {
	configState.windows = undefined
	BaseTerminal.setShellIntegrationTimeout(5000)
	BaseTerminal.setCommandDelay(0)
	vi.clearAllMocks()
})

afterEach(() => {
	setPlatform(originalPlatform)
	BaseTerminal.setShellIntegrationTimeout(5000)
	BaseTerminal.setCommandDelay(0)
})

// --- terminal 参照 -----------------------------------------------------------

describe("TerminalProcess - terminal 参照", () => {
	it("WeakRef が切れていたら terminal 参照で例外を投げる", () => {
		const { proc } = makeProcess()
		;(proc as unknown as { terminalRef: { deref: () => unknown } }).terminalRef = { deref: () => undefined }
		expect(() => proc.terminal).toThrow("Unable to dereference terminal")
	})
})

// --- shell integration ストリームのタイムアウト -----------------------------

describe("TerminalProcess - ストリーム未着のタイムアウト", () => {
	it("**規定時間内にストリームが来なければ中断し、no_shell_integration を通知する**", async () => {
		BaseTerminal.setShellIntegrationTimeout(20)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const { proc } = makeProcess()

		const noShell = vi.fn()
		proc.on("no_shell_integration", noShell)
		const completed = vi.fn()
		proc.on("completed", completed)

		// stream_available を一切 emit しない → タイムアウト経路に入る
		await proc.run("sleep 100")

		expect(noShell).toHaveBeenCalled()
		expect(completed).toHaveBeenCalledWith(expect.stringContaining("VSCE shell integration stream did not start"))
		expect(consoleError).toHaveBeenCalledWith("[Terminal Process] Stream error:", expect.any(String))
		consoleError.mockRestore()
	})
})

// --- PowerShell の回避策コマンド組み立て --------------------------------------

describe("TerminalProcess - PowerShell の回避策コマンド", () => {
	it("**遅延を付与した文字列を組み立てて executeCommand に渡す**", async () => {
		setPlatform("win32")
		configState.windows = "PowerShell Integrated Console"
		BaseTerminal.setCommandDelay(120)
		const executeCommand = vi.fn()
		const { proc } = makeProcess({ executeCommand })

		const p = proc.run("Get-ChildItem")
		proc.emit("stream_available", streamOf(["\x1b]633;C\x07", "out\n", "\x1b]633;D\x07"]))
		proc.emit("shell_execution_complete", { exitCode: 0 })
		await p

		expect(executeCommand).toHaveBeenCalledTimes(1)
		const composed = executeCommand.mock.calls[0][0] as string
		expect(composed).toContain("Get-ChildItem")
		expect(composed).toContain("start-sleep -milliseconds 120")
	})

	it("プロファイルが null でも PowerShell と判定し、遅延無しならコマンドは素のまま", async () => {
		setPlatform("win32")
		configState.windows = null
		BaseTerminal.setCommandDelay(0)
		const executeCommand = vi.fn()
		const { proc } = makeProcess({ executeCommand })

		const p = proc.run("echo hi")
		proc.emit("stream_available", streamOf(["\x1b]633;C\x07", "hi\n", "\x1b]633;D\x07"]))
		proc.emit("shell_execution_complete", { exitCode: 0 })
		await p

		expect(executeCommand).toHaveBeenCalledWith("echo hi")
	})
})

// --- C マーカー未着で終了 ----------------------------------------------------

describe("TerminalProcess - 出力開始マーカーが来ないまま終了", () => {
	it("C マーカーが無いまま終わったら『マーカー無し』を通知して完了する", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const { proc } = makeProcess()

		const outputs: (string | undefined)[] = []
		proc.on("completed", (o) => outputs.push(o))
		const noShell = vi.fn()
		proc.on("no_shell_integration", noShell)

		const p = proc.run("echo hi")
		// C マーカーを含まないストリーム
		proc.emit("stream_available", streamOf(["plain output\n", "no markers here\n"]))
		proc.emit("shell_execution_complete", { exitCode: 0 })
		await p

		expect(noShell).toHaveBeenCalled()
		expect(outputs.some((o) => (o ?? "").includes("VSCE shell integration markers not found"))).toBe(true)
		consoleError.mockRestore()
	})
})

// --- abort -------------------------------------------------------------------

describe("TerminalProcess - abort", () => {
	it("listening 中は CTRL+C (\\x03) を送る", () => {
		const sendText = vi.fn()
		const { proc } = makeProcess({ sendText })
		// 既定で isListening=true
		proc.abort()
		expect(sendText).toHaveBeenCalledWith("\x03")
	})

	it("listening していなければ何も送らない", () => {
		const sendText = vi.fn()
		const { proc } = makeProcess({ sendText })
		;(proc as unknown as { isListening: boolean }).isListening = false
		proc.abort()
		expect(sendText).not.toHaveBeenCalled()
	})
})

// --- getUnretrievedOutput: マーカー処理と未確定行 ----------------------------

describe("TerminalProcess - getUnretrievedOutput のマーカー処理", () => {
	function withOutput(fullOutput: string, opts: OwnerOverrides = {}) {
		const { proc } = makeProcess(opts)
		;(proc as unknown as { fullOutput: string }).fullOutput = fullOutput
		;(proc as unknown as { lastRetrievedIndex: number }).lastRetrievedIndex = 0
		return proc
	}

	it("633;D と 133;D の両方があれば早い方の手前まで返す", () => {
		const proc = withOutput("out\x1b]133;Dfoo\x1b]633;Dbar")
		expect(proc.getUnretrievedOutput()).toBe("out")
	})

	it("133;D だけでも手前まで返す", () => {
		const proc = withOutput("out\x1b]133;Dfoo")
		expect(proc.getUnretrievedOutput()).toBe("out")
	})

	it("マーカーも改行も無くストリーム継続中なら空文字（未確定行は出さない）", () => {
		const proc = withOutput("partial-no-newline", { isStreamClosed: false })
		expect(proc.getUnretrievedOutput()).toBe("")
	})

	it("マーカー無し・ストリーム継続中は最後の改行までを返す", () => {
		const proc = withOutput("line1\nline2", { isStreamClosed: false })
		expect(proc.getUnretrievedOutput()).toBe("line1\n")
	})

	it("マーカー無し・ストリーム終了後は残り全部を返す", () => {
		const proc = withOutput("all remaining", { isStreamClosed: true })
		expect(proc.getUnretrievedOutput()).toBe("all remaining")
	})
})

// --- stringIndexMatch / matchVsceMarkers の端の分岐 --------------------------

describe("TerminalProcess - マーカー検索ヘルパの端の分岐", () => {
	it("stringIndexMatch: prefix はあるが bell が無ければ undefined", () => {
		const { proc } = makeProcess()
		const result = (
			proc as unknown as {
				stringIndexMatch(d: string, p?: string, s?: string, b?: string): string | undefined
			}
		).stringIndexMatch("\x1b]633;Cno-bell-here", "\x1b]633;C", undefined)
		expect(result).toBeUndefined()
	})

	it("stringIndexMatch: bell 長 0 なら prefix 長ぶんだけ進めて中身を返す", () => {
		const { proc } = makeProcess()
		const result = (
			proc as unknown as {
				stringIndexMatch(d: string, p?: string, s?: string, b?: string): string | undefined
			}
		).stringIndexMatch("PREFIXcontent", "PREFIX", undefined, "")
		expect(result).toBe("content")
	})

	it("stringIndexMatch: suffix が見つからなければ undefined", () => {
		const { proc } = makeProcess()
		const result = (
			proc as unknown as {
				stringIndexMatch(d: string, p?: string, s?: string, b?: string): string | undefined
			}
		).stringIndexMatch("abc", undefined, "Z")
		expect(result).toBeUndefined()
	})

	it("matchAfterVsceStartMarkers: 633 が無く 133 だけあれば 133 側の中身を返す", () => {
		const { proc } = makeProcess()
		const result = (
			proc as unknown as { matchAfterVsceStartMarkers(d: string): string | undefined }
		).matchAfterVsceStartMarkers("\x1b]133;C\x07only-133")
		expect(result).toBe("only-133")
	})

	it("matchAfterVsceStartMarkers: 633 だけあれば 633 側の中身を返す", () => {
		const { proc } = makeProcess()
		const result = (
			proc as unknown as { matchAfterVsceStartMarkers(d: string): string | undefined }
		).matchAfterVsceStartMarkers("\x1b]633;C\x07only-633")
		expect(result).toBe("only-633")
	})
})
