import { describe, it, expect, vi, beforeEach } from "vitest"

// Task 本体の「重い orchestrator ラッパー」メソッドが、正しい引数で委譲先 run*/checkpoint*
// 関数を呼ぶことだけを検証する。実 orchestrator は走らせず全て vi.mock。
// 重い Task 構築を避けるため、`Object.create(Task.prototype)` の最小インスタンスに
// 必要な field だけ載せてメソッドを直接呼ぶ（getter/prototype メソッドも this 経由で解決される）。
vi.mock("../runRecursiveClineLoop", () => ({ runRecursiveClineLoop: vi.fn().mockResolvedValue(true) }))
vi.mock("../resumeTaskFromHistory", () => ({ resumeTaskFromHistory: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../startSubtask", () => ({ startSubtask: vi.fn().mockResolvedValue("child") }))
vi.mock("../resumeAfterDelegation", () => ({ resumeAfterDelegation: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../buildSystemPrompt", () => ({ buildSystemPrompt: vi.fn().mockResolvedValue("SYS") }))
vi.mock("../buildApiRequestDeps", () => ({ buildApiRequestDeps: vi.fn(() => "DEPS") }))
vi.mock("../apiRequestOrchestrator", () => ({
	attemptApiRequest: vi.fn(),
	condenseContext: vi.fn(),
	handleContextWindowExceededError: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../checkpoints", () => ({
	getCheckpointService: vi.fn(),
	checkpointSave: vi.fn(),
	checkpointRestore: vi.fn().mockResolvedValue("restored"),
	checkpointDiff: vi.fn().mockResolvedValue("diff"),
}))
vi.mock("../../assistant-message/presentAssistantMessage", () => ({ presentAssistantMessage: vi.fn() }))

import { Task } from "../Task"
import { runRecursiveClineLoop } from "../runRecursiveClineLoop"
import { resumeTaskFromHistory } from "../resumeTaskFromHistory"
import { startSubtask } from "../startSubtask"
import { resumeAfterDelegation } from "../resumeAfterDelegation"
import { buildSystemPrompt } from "../buildSystemPrompt"
import { buildApiRequestDeps } from "../buildApiRequestDeps"
import { handleContextWindowExceededError } from "../apiRequestOrchestrator"
import { checkpointRestore, checkpointDiff } from "../../checkpoints"

/** constructor を通さず prototype だけ持つ Task 相当インスタンスを作る（getter/method は this 経由で解決）。 */
function fakeTask(fields: Record<string, unknown> = {}): any {
	return Object.assign(Object.create(Task.prototype), fields)
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("Task orchestrator ラッパーの委譲", () => {
	it("recursivelyMakeClineRequests は host/provider 付きで runRecursiveClineLoop へ委譲する", async () => {
		const provider = { name: "p" }
		const self = fakeTask({ providerRef: { deref: () => provider } })
		const userContent = [{ type: "text", text: "hi" }]
		// deps に載る 2 クロージャ（stamp / presentAssistantMessage）も実行して被覆する
		vi.mocked(runRecursiveClineLoop).mockImplementationOnce(async (deps: any) => {
			deps.stampLastGlobalApiRequestTime()
			deps.presentAssistantMessage()
			return true
		})

		const result = await self.recursivelyMakeClineRequests(userContent, false)

		expect(result).toBe(true)
		const [deps, content, includeFileDetails] = vi.mocked(runRecursiveClineLoop).mock.calls[0]
		expect((deps as any).host).toBe(self)
		expect((deps as any).provider).toBe(provider)
		expect(content).toBe(userContent)
		expect(includeFileDetails).toBe(false)
		// stamp クロージャが static を更新したことを確認
		expect(typeof (Task as any).lastGlobalApiRequestTime).toBe("number")
	})

	it("resumeTaskFromHistory は { host: this } で委譲する", async () => {
		const self = fakeTask()
		await self.resumeTaskFromHistory()
		expect(resumeTaskFromHistory).toHaveBeenCalledWith({ host: self })
	})

	it("startSubtask は providerRef/taskId と引数を素通しで委譲する", async () => {
		const self = fakeTask({ providerRef: { deref: () => ({}) }, taskId: "t1" })
		const todos = [{ id: "1" }]

		const result = await self.startSubtask("msg", todos, "code")

		expect(result).toBe("child")
		expect(startSubtask).toHaveBeenCalledWith(self.providerRef, "t1", "msg", todos, "code")
	})

	it("resumeAfterDelegation は { host: this } で委譲する", async () => {
		const self = fakeTask()
		await self.resumeAfterDelegation()
		expect(resumeAfterDelegation).toHaveBeenCalledWith({ host: self })
	})

	it("getSystemPrompt は providerRef/api/cwd/diffStrategy 等で buildSystemPrompt へ委譲する", async () => {
		const self = fakeTask({
			providerRef: { deref: () => ({}) },
			api: { id: "api" },
			workspacePath: "/ws",
			diffStrategy: { name: "diff" },
			rooIgnoreController: { name: "ignore" },
		})

		const result = await self.getSystemPrompt()

		expect(result).toBe("SYS")
		const arg = vi.mocked(buildSystemPrompt).mock.calls[0][0] as any
		expect(arg.providerRef).toBe(self.providerRef)
		expect(arg.api).toBe(self.api)
		expect(arg.cwd).toBe("/ws") // cwd getter → workspacePath
		expect(arg.diffStrategy).toBe(self.diffStrategy)
	})

	it("handleContextWindowExceededError は buildApiRequestDeps の結果を orchestrator へ渡す", async () => {
		const self = fakeTask({ providerRef: { deref: () => ({}) } })

		await self.handleContextWindowExceededError()

		expect(buildApiRequestDeps).toHaveBeenCalled()
		expect(handleContextWindowExceededError).toHaveBeenCalledWith("DEPS")
	})

	it("checkpointRestore / checkpointDiff は (this, options) で委譲する", async () => {
		const self = fakeTask()
		const restoreOpts = { ts: 1, commitHash: "h", mode: "restore" }
		const diffOpts = { ts: 2, commitHash: "h2" }

		await expect(self.checkpointRestore(restoreOpts)).resolves.toBe("restored")
		await expect(self.checkpointDiff(diffOpts)).resolves.toBe("diff")
		expect(checkpointRestore).toHaveBeenCalledWith(self, restoreOpts)
		expect(checkpointDiff).toHaveBeenCalledWith(self, diffOpts)
	})

	it("getFilesReadByAgentSafely は fileContextTracker の失敗を握り潰して undefined を返す", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const self = fakeTask({
			fileContextTracker: { getFilesReadByAgent: vi.fn().mockRejectedValue(new Error("boom")) },
		})

		const result = await self.getFilesReadByAgentSafely("ctx")

		expect(result).toBeUndefined()
		expect(errSpy).toHaveBeenCalled()
	})

	it("getFilesReadByAgentSafely は成功時に fileContextTracker の結果を返す", async () => {
		const self = fakeTask({
			fileContextTracker: { getFilesReadByAgent: vi.fn().mockResolvedValue(["a.ts"]) },
		})

		const result = await self.getFilesReadByAgentSafely("ctx")

		expect(result).toEqual(["a.ts"])
	})
})
