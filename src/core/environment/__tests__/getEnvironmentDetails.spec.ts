// npx vitest core/environment/__tests__/getEnvironmentDetails.spec.ts

import pWaitFor from "p-wait-for"
import delay from "delay"
import type { Mock } from "vitest"
import * as vscode from "vscode"

import { getEnvironmentDetails } from "../getEnvironmentDetails"
import { getFullModeDetails } from "../../../shared/modes"
import { isToolAllowedForMode } from "../../tools/validateToolUse"
import { getApiMetrics } from "../../../shared/getApiMetrics"
import { listFiles } from "../../../services/glob/list-files"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { Terminal } from "../../../integrations/terminal/Terminal"
import { arePathsEqual } from "../../../utils/path"
import { FileContextTracker } from "../../context-tracking/FileContextTracker"
import { ApiHandler } from "../../../api/index"
import { ClineProvider } from "../../webview/ClineProvider"
import { AgentIgnoreController } from "../../ignore/AgentIgnoreController"
import { formatResponse } from "../../prompts/responses"
import { getGitStatus } from "../../../utils/git"
import { Task } from "../../task/Task"

vi.mock("vscode", () => {
	// オープンタブ判定は `tab.input instanceof vscode.TabInputText` で行われるため、
	// 同一クラス参照でインスタンスを生成できるようモックにも定義しておく。
	class TabInputText {
		constructor(public uri: { fsPath: string }) {}
	}
	return {
		window: {
			tabGroups: { all: [] as any[], onDidChangeTabs: vi.fn() },
			visibleTextEditors: [] as any[],
		},
		env: {
			language: "en-US",
		},
		TabInputText,
	}
})

vi.mock("p-wait-for", () => ({
	default: vi.fn(),
}))

vi.mock("delay", () => ({
	default: vi.fn(),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("../../../shared/modes")
vi.mock("../../../shared/getApiMetrics")
vi.mock("../../../services/glob/list-files")
vi.mock("../../../integrations/terminal/TerminalRegistry")
vi.mock("../../../integrations/terminal/Terminal")
vi.mock("../../../utils/path")
vi.mock("../../../utils/git")
vi.mock("../../prompts/responses")
vi.mock("../../tools/validateToolUse")

describe("getEnvironmentDetails", () => {
	const mockCwd = "/test/path"
	const mockTaskId = "test-task-id"

	type MockTerminal = {
		id: string
		getLastCommand: Mock
		getProcessesWithOutput: Mock
		cleanCompletedProcessQueue?: Mock
		getCurrentWorkingDirectory: Mock
	}

	let mockCline: Partial<Task>
	let mockProvider: any
	let mockState: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockState = {
			terminalOutputLineLimit: 100,
			maxWorkspaceFiles: 50,
			maxOpenTabsContext: 10,
			mode: "code",
			customModes: [],
			experiments: {},
			customInstructions: "test instructions",
			language: "en",
			showAgentIgnoredFiles: false,
		}

		mockProvider = {
			getState: vi.fn().mockResolvedValue(mockState),
		}

		mockCline = {
			cwd: mockCwd,
			taskId: mockTaskId,
			didEditFile: false,
			fileContextTracker: {
				getAndClearRecentlyModifiedFiles: vi.fn().mockReturnValue([]),
			} as unknown as FileContextTracker,
			rooIgnoreController: {
				filterPaths: vi.fn((paths: string[]) => paths.join("\n")),
				cwd: mockCwd,
				ignoreInstance: {},
				disposables: [],
				rooIgnoreContent: "",
				isPathIgnored: vi.fn(),
				getIgnoreContent: vi.fn(),
				updateIgnoreContent: vi.fn(),
				addToIgnore: vi.fn(),
				removeFromIgnore: vi.fn(),
				dispose: vi.fn(),
			} as unknown as AgentIgnoreController,
			messageStore: { clineMessages: [] } as unknown as Task["messageStore"],
			api: {
				getModel: vi.fn().mockReturnValue({ id: "test-model", info: { contextWindow: 100000 } }),
				createMessage: vi.fn(),
				countTokens: vi.fn(),
			} as unknown as ApiHandler,
			providerRef: {
				deref: vi.fn().mockReturnValue(mockProvider),
				[Symbol.toStringTag]: "WeakRef",
			} as unknown as WeakRef<ClineProvider>,
		}

		// Mock other dependencies.
		;(getApiMetrics as Mock).mockReturnValue({ contextTokens: 50000, totalCost: 0.25 })
		;(getFullModeDetails as Mock).mockResolvedValue({
			name: "💻 Code",
			roleDefinition: "You are a code assistant",
			customInstructions: "Custom instructions",
		})
		;(isToolAllowedForMode as Mock).mockReturnValue(true)
		;(listFiles as Mock).mockResolvedValue([["file1.ts", "file2.ts"], false])
		;(formatResponse.formatFilesList as Mock).mockReturnValue("file1.ts\nfile2.ts")
		;(arePathsEqual as Mock).mockReturnValue(false)
		;(Terminal.compressTerminalOutput as Mock).mockImplementation((output: string) => output)
		;(TerminalRegistry.getTerminals as Mock).mockReturnValue([])
		;(TerminalRegistry.getBackgroundTerminals as Mock).mockReturnValue([])
		;(TerminalRegistry.isProcessHot as Mock).mockReturnValue(false)
		;(TerminalRegistry.getUnretrievedOutput as Mock).mockReturnValue("")
		;(getGitStatus as Mock).mockResolvedValue("## main")
		vi.mocked(pWaitFor).mockResolvedValue(undefined)
		vi.mocked(delay).mockResolvedValue(undefined)
	})

	afterEach(() => {
		// モジュールレベルの vscode モックを書き換えるテストがあるため、毎回空へ戻す
		;(vscode.window as any).visibleTextEditors = []
		;(vscode.window.tabGroups as any).all = []
	})

	it("should return basic environment details", async () => {
		const result = await getEnvironmentDetails(mockCline as Task)

		expect(result).toContain("<environment_details>")
		expect(result).toContain("</environment_details>")
		// Visible Files and Open Tabs headers only appear when there's content
		expect(result).toContain("# Current Time")
		expect(result).not.toContain("# Git Status") // Git status is disabled by default (maxGitStatusFiles = 0)
		expect(result).toContain("# Current Cost")
		expect(result).toContain("# Current Mode")
		expect(result).toContain("<model>test-model</model>")

		expect(mockProvider.getState).toHaveBeenCalled()

		expect(getFullModeDetails).toHaveBeenCalledWith("code", undefined, {
			cwd: mockCwd,
			globalCustomInstructions: "test instructions",
			language: "en",
		})

		expect(getApiMetrics).toHaveBeenCalledWith(mockCline.messageStore!.clineMessages)
	})

	it("should include file details when includeFileDetails is true", async () => {
		const result = await getEnvironmentDetails(mockCline as Task, true)
		expect(result).toContain("# Current Workspace Directory")
		expect(result).toContain("Files")

		expect(listFiles).toHaveBeenCalledWith(mockCwd, true, 50)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			mockCwd,
			["file1.ts", "file2.ts"],
			false,
			mockCline.rooIgnoreController,
			false,
		)
	})

	it("listFiles が失敗（ripgrep 不在等）してもリクエストは止めず空一覧で続行する", async () => {
		// 以前はここで throw が伝播し、getEnvironmentDetails → prepareRequestCycle が死んで
		// attemptApiRequest に到達できず、UI が「APIリクエスト…」のまま無音で固まっていた。
		;(listFiles as Mock).mockRejectedValue(new Error("Could not find ripgrep binary"))

		// throw せず結果を返すこと。
		const result = await getEnvironmentDetails(mockCline as Task, true)
		expect(result).toContain("# Current Workspace Directory")
		// 空一覧で formatFilesList が呼ばれる。
		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			mockCwd,
			[],
			false,
			mockCline.rooIgnoreController,
			false,
		)
	})

	it("listFiles が応答を返さない(hang)場合はタイムアウトで空一覧にして続行する", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			;(listFiles as Mock).mockReturnValue(new Promise(() => {})) // never resolves = hang
			const promise = getEnvironmentDetails(mockCline as Task, true)
			await vi.advanceTimersByTimeAsync(15_000) // タイムアウト発火
			const result = await promise
			expect(result).toContain("# Current Workspace Directory")
			expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
				mockCwd,
				[],
				false,
				mockCline.rooIgnoreController,
				false,
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("should not include file details when includeFileDetails is false", async () => {
		await getEnvironmentDetails(mockCline as Task, false)
		expect(listFiles).not.toHaveBeenCalled()
		expect(formatResponse.formatFilesList).not.toHaveBeenCalled()
	})

	it("should handle desktop directory specially", async () => {
		;(arePathsEqual as Mock).mockReturnValue(true)
		const result = await getEnvironmentDetails(mockCline as Task, true)
		expect(result).toContain("Desktop files not shown automatically")
		expect(listFiles).not.toHaveBeenCalled()
	})

	it("should skip file listing when maxWorkspaceFiles is 0", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxWorkspaceFiles: 0,
		})

		const result = await getEnvironmentDetails(mockCline as Task, true)

		expect(listFiles).not.toHaveBeenCalled()
		expect(result).toContain("Workspace files context disabled")
		expect(formatResponse.formatFilesList).not.toHaveBeenCalled()
	})

	it("should include recently modified files if any", async () => {
		;(mockCline.fileContextTracker!.getAndClearRecentlyModifiedFiles as Mock).mockReturnValue([
			"modified1.ts",
			"modified2.ts",
		])

		const result = await getEnvironmentDetails(mockCline as Task)

		expect(result).toContain("# Recently Modified Files")
		expect(result).toContain("modified1.ts")
		expect(result).toContain("modified2.ts")
	})

	it("should include active terminal information", async () => {
		const mockActiveTerminal = {
			id: "terminal-1",
			getLastCommand: vi.fn().mockReturnValue("npm test"),
			getProcessesWithOutput: vi.fn().mockReturnValue([]),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/test/path/src"),
		} as MockTerminal

		;(TerminalRegistry.getTerminals as Mock).mockReturnValue([mockActiveTerminal])
		;(TerminalRegistry.getUnretrievedOutput as Mock).mockReturnValue("Test output")

		const result = await getEnvironmentDetails(mockCline as Task)

		expect(result).toContain("# Actively Running Terminals")
		expect(result).toContain("## Terminal terminal-1 (Active)")
		expect(result).toContain("### Working Directory: `/test/path/src`")
		expect(result).toContain("### Original command: `npm test`")
		expect(result).toContain("Test output")

		mockCline.didEditFile = true
		await getEnvironmentDetails(mockCline as Task)
		expect(vi.mocked(delay)).toHaveBeenCalledWith(300)

		expect(vi.mocked(pWaitFor)).toHaveBeenCalled()
	})

	it("should include inactive terminals with output", async () => {
		const mockProcess = {
			command: "npm build",
			getUnretrievedOutput: vi.fn().mockReturnValue("Build output"),
		}

		const mockInactiveTerminal = {
			id: "terminal-2",
			getLastCommand: vi.fn().mockReturnValue("npm build"),
			getProcessesWithOutput: vi.fn().mockReturnValue([mockProcess]),
			cleanCompletedProcessQueue: vi.fn(),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/test/path/build"),
		} as MockTerminal

		;(TerminalRegistry.getTerminals as Mock).mockImplementation((active: boolean) =>
			active ? [] : [mockInactiveTerminal],
		)

		const result = await getEnvironmentDetails(mockCline as Task)

		expect(result).toContain("# Inactive Terminals with Completed Process Output")
		expect(result).toContain("## Terminal terminal-2 (Inactive)")
		expect(result).toContain("### Working Directory: `/test/path/build`")
		expect(result).toContain("Command: `npm build`")
		expect(result).toContain("Build output")

		expect(mockInactiveTerminal.cleanCompletedProcessQueue).toHaveBeenCalled()
	})

	it("should include working directory for terminals", async () => {
		const mockActiveTerminal = {
			id: "terminal-1",
			getLastCommand: vi.fn().mockReturnValue("cd /some/path && npm start"),
			getProcessesWithOutput: vi.fn().mockReturnValue([]),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/some/path"),
		} as MockTerminal

		const mockProcess = {
			command: "npm test",
			getUnretrievedOutput: vi.fn().mockReturnValue("Test completed"),
		}

		const mockInactiveTerminal = {
			id: "terminal-2",
			getLastCommand: vi.fn().mockReturnValue("npm test"),
			getProcessesWithOutput: vi.fn().mockReturnValue([mockProcess]),
			cleanCompletedProcessQueue: vi.fn(),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/another/path"),
		} as MockTerminal

		;(TerminalRegistry.getTerminals as Mock).mockImplementation((active: boolean) =>
			active ? [mockActiveTerminal] : [mockInactiveTerminal],
		)
		;(TerminalRegistry.getUnretrievedOutput as Mock).mockReturnValue("Server started")

		const result = await getEnvironmentDetails(mockCline as Task)

		// Check active terminal working directory
		expect(result).toContain("## Terminal terminal-1 (Active)")
		expect(result).toContain("### Working Directory: `/some/path`")
		expect(result).toContain("### Original command: `cd /some/path && npm start`")

		// Check inactive terminal working directory
		expect(result).toContain("## Terminal terminal-2 (Inactive)")
		expect(result).toContain("### Working Directory: `/another/path`")

		// Verify the methods were called
		expect(mockActiveTerminal.getCurrentWorkingDirectory).toHaveBeenCalled()
		expect(mockInactiveTerminal.getCurrentWorkingDirectory).toHaveBeenCalled()
	})

	it("should handle missing provider or state", async () => {
		// Mock provider to return null.
		mockCline.providerRef!.deref = vi.fn().mockReturnValue(null)

		const result = await getEnvironmentDetails(mockCline as Task)

		// Verify the function still returns a result.
		expect(result).toContain("<environment_details>")
		expect(result).toContain("</environment_details>")

		// Mock provider to return null state.
		mockCline.providerRef!.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue(null),
		})

		const result2 = await getEnvironmentDetails(mockCline as Task)

		// Verify the function still returns a result.
		expect(result2).toContain("<environment_details>")
		expect(result2).toContain("</environment_details>")
	})

	it("should handle errors gracefully", async () => {
		vi.mocked(pWaitFor).mockRejectedValue(new Error("Test error"))

		const mockErrorTerminal = {
			id: "terminal-1",
			getLastCommand: vi.fn().mockReturnValue("npm test"),
			getProcessesWithOutput: vi.fn().mockReturnValue([]),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/test/path"),
		} as MockTerminal

		;(TerminalRegistry.getTerminals as Mock).mockReturnValue([mockErrorTerminal])
		;(TerminalRegistry.getBackgroundTerminals as Mock).mockReturnValue([])
		;(mockCline.fileContextTracker!.getAndClearRecentlyModifiedFiles as Mock).mockReturnValue([])

		await expect(getEnvironmentDetails(mockCline as Task)).resolves.not.toThrow()
	})
	it("should include REMINDERS section when todoListEnabled is true", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			apiConfiguration: { todoListEnabled: true },
		})
		const cline = { ...mockCline, todoList: [{ content: "test", status: "pending" }] }
		const result = await getEnvironmentDetails(cline as Task)
		expect(result).toContain("REMINDERS")
	})

	it("should NOT include REMINDERS section when todoListEnabled is false", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			apiConfiguration: { todoListEnabled: false },
		})
		const cline = { ...mockCline, todoList: [{ content: "test", status: "pending" }] }
		const result = await getEnvironmentDetails(cline as Task)
		expect(result).not.toContain("REMINDERS")
	})

	it("should include REMINDERS section when todoListEnabled is undefined", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			apiConfiguration: {},
		})
		const cline = { ...mockCline, todoList: [{ content: "test", status: "pending" }] }
		const result = await getEnvironmentDetails(cline as Task)
		expect(result).toContain("REMINDERS")
	})
	it("should include git status when maxGitStatusFiles > 0", async () => {
		;(getGitStatus as Mock).mockResolvedValue("## main\nM  file1.ts")
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: 10,
		})

		const result = await getEnvironmentDetails(mockCline as Task)

		expect(result).toContain("# Git Status")
		expect(result).toContain("## main")
		expect(getGitStatus).toHaveBeenCalledWith(mockCwd, 10)
	})

	it("should NOT include git status when maxGitStatusFiles is 0", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: 0,
		})

		const result = await getEnvironmentDetails(mockCline as Task)

		expect(result).not.toContain("# Git Status")
		expect(getGitStatus).not.toHaveBeenCalled()
	})

	it("should NOT include git status when maxGitStatusFiles is undefined (defaults to 0)", async () => {
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: undefined,
		})

		const result = await getEnvironmentDetails(mockCline as Task)

		expect(result).not.toContain("# Git Status")
		expect(getGitStatus).not.toHaveBeenCalled()
	})

	it("should handle git status returning null gracefully when enabled", async () => {
		;(getGitStatus as Mock).mockResolvedValue(null)
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: 10,
		})

		const result = await getEnvironmentDetails(mockCline as Task)

		expect(result).not.toContain("# Git Status")
		expect(getGitStatus).toHaveBeenCalledWith(mockCwd, 10)
	})

	it("should pass maxFiles parameter to getGitStatus", async () => {
		;(getGitStatus as Mock).mockResolvedValue("## main")
		mockProvider.getState.mockResolvedValue({
			...mockState,
			maxGitStatusFiles: 5,
		})

		await getEnvironmentDetails(mockCline as Task)

		expect(getGitStatus).toHaveBeenCalledWith(mockCwd, 5)
	})

	describe("visible files and open tabs", () => {
		it("should include the VSCode Visible Files section filtered through rooIgnoreController", async () => {
			;(vscode.window as any).visibleTextEditors = [
				{ document: { uri: { fsPath: `${mockCwd}/visible.ts` } } },
				// fsPath 無しのエディタは除外される（filter(Boolean)）
				{ document: { uri: {} } },
			]

			const result = await getEnvironmentDetails(mockCline as Task)

			expect(result).toContain("# VSCode Visible Files")
			expect(result).toContain("visible.ts")
			expect(mockCline.rooIgnoreController!.filterPaths).toHaveBeenCalledWith(["visible.ts"])
		})

		it("should include the VSCode Open Tabs section filtered through rooIgnoreController", async () => {
			;(vscode.window.tabGroups as any).all = [
				{
					tabs: [
						{ input: new (vscode as any).TabInputText({ fsPath: `${mockCwd}/tab.ts` }) },
						// TabInputText 以外の入力（差分ビュー等）は除外される
						{ input: { some: "other" } },
					],
				},
			]

			const result = await getEnvironmentDetails(mockCline as Task)

			expect(result).toContain("# VSCode Open Tabs")
			expect(result).toContain("tab.ts")
			expect(mockCline.rooIgnoreController!.filterPaths).toHaveBeenCalledWith(["tab.ts"])
		})

		it("should fall back to raw joined paths when rooIgnoreController is absent", async () => {
			// コントローラが無い場合は filterPaths を通さず、相対パスをそのまま列挙する（実装 71,91 行）
			;(vscode.window as any).visibleTextEditors = [{ document: { uri: { fsPath: `${mockCwd}/visible.ts` } } }]
			;(vscode.window.tabGroups as any).all = [
				{ tabs: [{ input: new (vscode as any).TabInputText({ fsPath: `${mockCwd}/tab.ts` }) }] },
			]
			const clineNoIgnore = { ...mockCline, rooIgnoreController: undefined }

			const result = await getEnvironmentDetails(clineNoIgnore as Task)

			expect(result).toContain("# VSCode Visible Files")
			expect(result).toContain("visible.ts")
			expect(result).toContain("# VSCode Open Tabs")
			expect(result).toContain("tab.ts")
		})
	})

	describe("time zone offset formatting", () => {
		it("uses a '+' sign for zones east of UTC (non-negative offset)", async () => {
			// getTimezoneOffset()=-540 → offset=+9 → "+" 側の分岐（実装 216 行）
			const spy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-540)

			const result = await getEnvironmentDetails(mockCline as Task)

			expect(result).toContain("UTC+9:00")
			spy.mockRestore()
		})

		it("uses a '-' sign for zones west of UTC (negative offset)", async () => {
			// getTimezoneOffset()=300 → offset=-5 → "-" 側の分岐（実装 216 行）
			const spy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(300)

			const result = await getEnvironmentDetails(mockCline as Task)

			expect(result).toContain("UTC-5:00")
			spy.mockRestore()
		})
	})

	it("should show '(Not available)' when total cost is null", async () => {
		// getApiMetrics が totalCost=null を返した場合の分岐（実装 231 行）
		;(getApiMetrics as Mock).mockReturnValue({ contextTokens: 0, totalCost: null })

		const result = await getEnvironmentDetails(mockCline as Task)

		expect(result).toContain("# Current Cost\n(Not available)")
	})

	it("should fall back to defaults when state is null while listing files", async () => {
		// state が null でもファイル一覧経路（実装 269 行 `state ?? {}`）が既定へフォールバックする
		mockCline.providerRef!.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue(null),
		})

		const result = await getEnvironmentDetails(mockCline as Task, true)

		expect(result).toContain("# Current Workspace Directory")
		expect(listFiles).toHaveBeenCalledWith(mockCwd, true, 200) // maxWorkspaceFiles 既定 200
		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			mockCwd,
			["file1.ts", "file2.ts"],
			false,
			mockCline.rooIgnoreController,
			false, // showAgentIgnoredFiles 既定
		)
	})

	it("should default showAgentIgnoredFiles to false when absent from state", async () => {
		// state に showAgentIgnoredFiles が無い場合、既定 false が使われる（実装 268 行）
		const { showAgentIgnoredFiles: _omit, ...stateWithout } = mockState
		mockProvider.getState.mockResolvedValue(stateWithout)

		await getEnvironmentDetails(mockCline as Task, true)

		expect(formatResponse.formatFilesList).toHaveBeenCalledWith(
			mockCwd,
			["file1.ts", "file2.ts"],
			false,
			mockCline.rooIgnoreController,
			false, // 既定値
		)
	})

	it("should evaluate the busy-terminal cool-down predicate passed to pWaitFor", async () => {
		// pWaitFor に渡す判定関数（実装 115 行）を実際に呼ばせて評価する
		const busyTerminal = {
			id: "busy-1",
			getLastCommand: vi.fn().mockReturnValue("npm run dev"),
			getProcessesWithOutput: vi.fn().mockReturnValue([]),
			getCurrentWorkingDirectory: vi.fn().mockReturnValue("/test/path"),
		} as MockTerminal
		;(TerminalRegistry.getTerminals as Mock).mockReturnValue([busyTerminal])
		;(TerminalRegistry.isProcessHot as Mock).mockReturnValue(false)
		vi.mocked(pWaitFor).mockImplementation(async (condition: any) => {
			condition() // 判定関数を実行させる
		})

		await getEnvironmentDetails(mockCline as Task)

		expect(TerminalRegistry.isProcessHot).toHaveBeenCalledWith("busy-1")
	})
})
