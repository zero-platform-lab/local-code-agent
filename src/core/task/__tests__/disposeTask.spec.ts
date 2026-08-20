import { describe, it, expect, vi, beforeEach } from "vitest"

import { disposeTask, type DisposeTaskStateHost } from "../disposeTask"

// disposeTask が直接呼ぶ「外部モジュールの副作用」だけを差し替える。
// host 経由の依存はテスト側で fake を注入するので mock しない。
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { releaseTerminalsForTask: vi.fn() },
}))
vi.mock("../../../integrations/terminal/OutputInterceptor", () => ({
	OutputInterceptor: { cleanup: vi.fn(() => Promise.resolve()) },
}))
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn(() => Promise.resolve("/task/dir")),
}))

import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
import { getTaskDirectoryPath } from "../../../utils/storage"

const mockedRelease = vi.mocked(TerminalRegistry.releaseTerminalsForTask)
const mockedCleanup = vi.mocked(OutputInterceptor.cleanup)
const mockedGetTaskDir = vi.mocked(getTaskDirectoryPath)

// disposeTask は同期関数だが command-output 掃除と diff revert を promise chain で投げる。
// それらを観測するため保留中の microtask/macrotask を吐き出させる。
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function makeHost() {
	return {
		taskId: "task-1",
		instanceId: "inst-9",
		globalStoragePath: "/global/storage",
		subscriptions: { disposeAll: vi.fn() },
		messageQueueService: { dispose: vi.fn() },
		rooIgnoreController: { dispose: vi.fn() } as { dispose: () => void } | undefined,
		fileContextTracker: { dispose: vi.fn() },
		stream: { isStreaming: false },
		diffViewProvider: { isEditing: false, revertChanges: vi.fn(() => Promise.resolve()) },
		cancelCurrentRequest: vi.fn(),
		removeAllListeners: vi.fn(),
	}
}

type Host = ReturnType<typeof makeHost>

function run(host: Host): void {
	disposeTask({ host } as unknown as { host: DisposeTaskStateHost })
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedGetTaskDir.mockResolvedValue("/task/dir")
	mockedCleanup.mockResolvedValue(undefined)
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("disposeTask", () => {
	it("正常系: cancel→subscriptions.disposeAll→queue.dispose→removeAllListeners→terminal release→ignore dispose→fileContext dispose を順に一度ずつ実行する", async () => {
		const order: string[] = []
		const host = makeHost()
		host.cancelCurrentRequest.mockImplementation(() => {
			order.push("cancel")
		})
		host.subscriptions.disposeAll.mockImplementation(() => {
			order.push("disposeAll")
		})
		host.messageQueueService.dispose.mockImplementation(() => {
			order.push("queue")
		})
		host.removeAllListeners.mockImplementation(() => {
			order.push("removeAllListeners")
		})
		mockedRelease.mockImplementation(() => {
			order.push("terminals")
		})
		host.rooIgnoreController!.dispose = vi.fn(() => {
			order.push("ignore")
		})
		host.fileContextTracker.dispose.mockImplementation(() => {
			order.push("fileContext")
		})

		run(host)
		await flush()

		expect(order).toEqual([
			"cancel",
			"disposeAll",
			"queue",
			"removeAllListeners",
			"terminals",
			"ignore",
			"fileContext",
		])
		expect(mockedRelease).toHaveBeenCalledWith("task-1")
	})

	it("rooIgnoreController は dispose 後に undefined へクリアされる（リーク対策）", () => {
		const host = makeHost()
		const disposeSpy = host.rooIgnoreController!.dispose

		run(host)

		expect(disposeSpy).toHaveBeenCalledTimes(1)
		expect(host.rooIgnoreController).toBeUndefined()
	})

	it("command-output は getTaskDirectoryPath(globalStoragePath, taskId)→OutputInterceptor.cleanup(<dir>/command-output) で掃除する", async () => {
		const host = makeHost()

		run(host)
		await flush()

		expect(mockedGetTaskDir).toHaveBeenCalledWith("/global/storage", "task-1")
		expect(mockedCleanup).toHaveBeenCalledWith("/task/dir/command-output")
	})

	it("cancelCurrentRequest が throw しても握り潰し後続 cleanup を続行する", () => {
		const host = makeHost()
		host.cancelCurrentRequest.mockImplementation(() => {
			throw new Error("cancel boom")
		})

		expect(() => run(host)).not.toThrow()

		expect(console.error).toHaveBeenCalledWith("Error cancelling current request:", expect.any(Error))
		expect(host.subscriptions.disposeAll).toHaveBeenCalledTimes(1)
		expect(host.messageQueueService.dispose).toHaveBeenCalledTimes(1)
		expect(host.fileContextTracker.dispose).toHaveBeenCalledTimes(1)
	})

	it("messageQueueService.dispose が throw しても removeAllListeners 以降を続行する", () => {
		const host = makeHost()
		host.messageQueueService.dispose.mockImplementation(() => {
			throw new Error("queue boom")
		})

		run(host)

		expect(console.error).toHaveBeenCalledWith("Error disposing message queue:", expect.any(Error))
		expect(host.removeAllListeners).toHaveBeenCalledTimes(1)
		expect(mockedRelease).toHaveBeenCalledTimes(1)
	})

	it("removeAllListeners が throw しても terminal release 以降を続行する", () => {
		const host = makeHost()
		host.removeAllListeners.mockImplementation(() => {
			throw new Error("listeners boom")
		})

		run(host)

		expect(console.error).toHaveBeenCalledWith("Error removing event listeners:", expect.any(Error))
		expect(mockedRelease).toHaveBeenCalledTimes(1)
		expect(host.fileContextTracker.dispose).toHaveBeenCalledTimes(1)
	})

	it("TerminalRegistry.releaseTerminalsForTask が throw しても fileContext dispose まで続行する", () => {
		const host = makeHost()
		mockedRelease.mockImplementation(() => {
			throw new Error("terminal boom")
		})

		run(host)

		expect(console.error).toHaveBeenCalledWith("Error releasing terminals:", expect.any(Error))
		expect(host.fileContextTracker.dispose).toHaveBeenCalledTimes(1)
	})

	it("rooIgnoreController が未設定なら dispose をスキップし後続へ進む", () => {
		const host = makeHost()
		host.rooIgnoreController = undefined

		expect(() => run(host)).not.toThrow()

		expect(host.fileContextTracker.dispose).toHaveBeenCalledTimes(1)
	})

	it("rooIgnoreController.dispose が throw しても握り潰し fileContext dispose は続行する", () => {
		const host = makeHost()
		host.rooIgnoreController!.dispose = vi.fn(() => {
			throw new Error("ignore boom")
		})

		run(host)

		expect(console.error).toHaveBeenCalledWith("Error disposing AgentIgnoreController:", expect.any(Error))
		expect(host.fileContextTracker.dispose).toHaveBeenCalledTimes(1)
	})

	it("fileContextTracker.dispose が throw しても diff 判定まで到達し throw しない", () => {
		const host = makeHost()
		host.fileContextTracker.dispose.mockImplementation(() => {
			throw new Error("fct boom")
		})
		host.stream.isStreaming = true
		host.diffViewProvider.isEditing = true

		expect(() => run(host)).not.toThrow()

		expect(console.error).toHaveBeenCalledWith("Error disposing file context tracker:", expect.any(Error))
		// dispose が落ちても diff revert は後続で評価される
		expect(host.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
	})

	it("streaming 中かつ diff 編集中なら revertChanges を呼ぶ", () => {
		const host = makeHost()
		host.stream.isStreaming = true
		host.diffViewProvider.isEditing = true

		run(host)

		expect(host.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
	})

	it("streaming 中でも diff 未編集なら revertChanges を呼ばない", () => {
		const host = makeHost()
		host.stream.isStreaming = true
		host.diffViewProvider.isEditing = false

		run(host)

		expect(host.diffViewProvider.revertChanges).not.toHaveBeenCalled()
	})

	it("streaming していなければ（短絡）revertChanges を呼ばない", () => {
		const host = makeHost()
		host.stream.isStreaming = false
		host.diffViewProvider.isEditing = true

		run(host)

		expect(host.diffViewProvider.revertChanges).not.toHaveBeenCalled()
	})

	it("revertChanges が同期 throw しても外側 try-catch で握り潰す", () => {
		const host = makeHost()
		host.stream.isStreaming = true
		host.diffViewProvider.isEditing = true
		host.diffViewProvider.revertChanges = vi.fn(() => {
			throw new Error("revert boom")
		})

		expect(() => run(host)).not.toThrow()

		expect(console.error).toHaveBeenCalledWith("Error reverting diff changes:", expect.any(Error))
	})

	it("revertChanges が reject しても .catch(console.error) で握り unhandled にならない", async () => {
		const host = makeHost()
		host.stream.isStreaming = true
		host.diffViewProvider.isEditing = true
		host.diffViewProvider.revertChanges = vi.fn(() => Promise.reject(new Error("revert reject")))

		run(host)
		await flush()

		expect(host.diffViewProvider.revertChanges).toHaveBeenCalledTimes(1)
	})

	it("getTaskDirectoryPath が reject しても command-output 掃除の .catch で握り throw しない", async () => {
		const host = makeHost()
		mockedGetTaskDir.mockRejectedValueOnce(new Error("no dir"))

		run(host)
		await flush()

		expect(mockedCleanup).not.toHaveBeenCalled()
		expect(console.error).toHaveBeenCalledWith("Error cleaning up command output artifacts:", expect.any(Error))
	})
})
