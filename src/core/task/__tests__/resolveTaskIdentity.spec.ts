// npx vitest run core/task/__tests__/resolveTaskIdentity.spec.ts

import type { HistoryItem } from "@openai-agent/types"

import { resolveTaskIdentity, type TaskIdentityDeps } from "../resolveTaskIdentity"

const deps = (): TaskIdentityDeps => ({
	generateTaskId: vi.fn(() => "generated-task-id"),
	generateInstanceId: vi.fn(() => "inst1234"),
	resolveDefaultWorkspacePath: vi.fn(() => "/default/workspace"),
})

const historyItem = (overrides: Partial<HistoryItem> = {}): HistoryItem =>
	({
		id: "history-id",
		task: "history task text",
		rootTaskId: "history-root",
		parentTaskId: "history-parent",
		...overrides,
	}) as HistoryItem

describe("resolveTaskIdentity — fresh task", () => {
	it("uses the explicit taskId when provided", () => {
		const d = deps()
		const identity = resolveTaskIdentity({ taskId: "explicit", task: "hello" }, d)

		expect(identity.taskId).toBe("explicit")
		expect(d.generateTaskId).not.toHaveBeenCalled()
	})

	it("generates a taskId when none is provided", () => {
		expect(resolveTaskIdentity({ task: "hello" }, deps()).taskId).toBe("generated-task-id")
	})

	it("always generates a fresh instanceId", () => {
		const d = deps()
		resolveTaskIdentity({ taskId: "explicit" }, d)

		expect(d.generateInstanceId).toHaveBeenCalledOnce()
	})

	it("takes root/parent ids from the given task objects", () => {
		const identity = resolveTaskIdentity(
			{ task: "hello", rootTask: { taskId: "root-1" }, parentTask: { taskId: "parent-1", workspacePath: "/p" } },
			deps(),
		)

		expect(identity.rootTaskId).toBe("root-1")
		expect(identity.parentTaskId).toBe("parent-1")
	})

	it("carries task text and images into metadata", () => {
		const identity = resolveTaskIdentity({ task: "hello", images: ["img"] }, deps())

		expect(identity.metadata).toEqual({ task: "hello", images: ["img"] })
	})
})

describe("resolveTaskIdentity — history item wins", () => {
	it("takes id / root / parent / task text from the history item", () => {
		const identity = resolveTaskIdentity(
			{
				taskId: "ignored",
				task: "ignored task",
				rootTask: { taskId: "ignored-root" },
				historyItem: historyItem(),
			},
			deps(),
		)

		expect(identity.taskId).toBe("history-id")
		expect(identity.rootTaskId).toBe("history-root")
		expect(identity.parentTaskId).toBe("history-parent")
		expect(identity.metadata.task).toBe("history task text")
	})

	it("drops images on resume", () => {
		const identity = resolveTaskIdentity({ images: ["img"], historyItem: historyItem() }, deps())

		expect(identity.metadata.images).toEqual([])
	})

	it("still honours parentTask for root/parent ids only via the history item", () => {
		const identity = resolveTaskIdentity(
			{ historyItem: historyItem({ rootTaskId: undefined, parentTaskId: undefined }), rootTask: { taskId: "r" } },
			deps(),
		)

		expect(identity.rootTaskId).toBeUndefined()
		expect(identity.parentTaskId).toBeUndefined()
	})
})

describe("resolveTaskIdentity — workspacePath", () => {
	it("inherits the parent task workspace above everything else", () => {
		const d = deps()
		const identity = resolveTaskIdentity(
			{
				parentTask: { taskId: "p", workspacePath: "/parent/ws" },
				workspacePath: "/explicit",
				historyItem: historyItem(),
			},
			d,
		)

		expect(identity.workspacePath).toBe("/parent/ws")
		expect(d.resolveDefaultWorkspacePath).not.toHaveBeenCalled()
	})

	it("uses the explicit workspacePath when there is no parent task", () => {
		expect(resolveTaskIdentity({ workspacePath: "/explicit" }, deps()).workspacePath).toBe("/explicit")
	})

	it("falls back to the resolved default", () => {
		expect(resolveTaskIdentity({}, deps()).workspacePath).toBe("/default/workspace")
	})
})
