// npx vitest run core/task/__tests__/TaskBuilder.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import { DEFAULT_CONSECUTIVE_MISTAKE_LIMIT } from "@openai-agent/types"

const { mockInitialize } = vi.hoisted(() => ({ mockInitialize: vi.fn(() => Promise.resolve()) }))

// 重い collaborator は全てモックして、TaskBuilder のオーケストレーション部だけを検証する。
vi.mock("../../ignore/AgentIgnoreController", () => ({
	AgentIgnoreController: vi.fn().mockImplementation(() => ({ initialize: mockInitialize })),
}))
vi.mock("../../protect/AgentProtectedController", () => ({ AgentProtectedController: vi.fn() }))
vi.mock("../../../api", () => ({ buildApiHandler: vi.fn(() => ({ id: "api" })) }))
vi.mock("../../auto-approval", () => ({ AutoApprovalHandler: vi.fn() }))
vi.mock("../../context-tracking/FileContextTracker", () => ({ FileContextTracker: vi.fn() }))
vi.mock("../TaskMessageStore", () => ({ TaskMessageStore: vi.fn() }))
vi.mock("../../message-queue/MessageQueueService", () => ({ MessageQueueService: vi.fn() }))
vi.mock("../../diff/strategies/multi-search-replace", () => ({ MultiSearchReplaceDiffStrategy: vi.fn() }))
vi.mock("../../tools/ToolRepetitionDetector", () => ({ ToolRepetitionDetector: vi.fn() }))

import { buildTaskCollaborators } from "../TaskBuilder"
import { MistakeTracker } from "../MistakeTracker"

function makeInput(over: Record<string, unknown> = {}) {
	return {
		apiConfiguration: { apiProvider: "openai" },
		provider: {} as never,
		taskId: "t1",
		cwd: "/cwd",
		globalStoragePath: "/store",
		...over,
	} as never
}

beforeEach(() => {
	vi.clearAllMocks()
	mockInitialize.mockReturnValue(Promise.resolve())
})

describe("buildTaskCollaborators", () => {
	it("consecutiveMistakeLimit 未指定なら DEFAULT を使う", () => {
		const collaborators = buildTaskCollaborators(makeInput())

		expect(collaborators.mistakeTracker).toBeInstanceOf(MistakeTracker)
		expect(collaborators.mistakeTracker.limit).toBe(DEFAULT_CONSECUTIVE_MISTAKE_LIMIT)
	})

	it("consecutiveMistakeLimit を渡せばそれを使う", () => {
		const collaborators = buildTaskCollaborators(makeInput({ consecutiveMistakeLimit: 7 }))

		expect(collaborators.mistakeTracker.limit).toBe(7)
	})

	it("rooIgnoreController.initialize() の失敗は握り潰してログするだけ（構築は成功する）", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		// Promise はモック呼び出し時に生成する（事前生成だと .catch 付与前に unhandled 判定される）。
		mockInitialize.mockImplementationOnce(() => Promise.reject(new Error("boom")))

		const collaborators = buildTaskCollaborators(makeInput())

		expect(collaborators).toBeDefined()
		// fire-and-forget の .catch が非同期に走るのを待つ
		await Promise.resolve()
		await Promise.resolve()
		expect(errSpy).toHaveBeenCalledWith("Failed to initialize AgentIgnoreController:", expect.any(Error))
		errSpy.mockRestore()
	})
})
