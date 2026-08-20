import EventEmitter from "events"

import { describe, it, expect, vi, beforeEach } from "vitest"

import { AgentEventName, type HistoryItem } from "@openai-agent/types"

import type { Task } from "../../task/Task"
import { makeTaskCreationCallback, type TaskEventForwardingHost } from "../taskEventForwarding"

class FakeTask extends EventEmitter {
	abortReason?: string
	rootTask?: Task
	parentTask?: Task

	constructor(
		readonly taskId = "task-1",
		readonly instanceId = "instance-1",
	) {
		super()
	}
}

const asTask = (task: FakeTask) => task as unknown as Task

const makeHost = (overrides: Partial<TaskEventForwardingHost> = {}) => {
	const host: TaskEventForwardingHost = {
		log: vi.fn(),
		getCurrentTask: vi.fn(() => undefined),
		getTaskWithId: vi.fn(async (id: string) => ({ historyItem: { id } as HistoryItem })),
		createTaskWithHistoryItem: vi.fn(async () => undefined),
		...overrides,
	}

	return host
}

describe("makeTaskCreationCallback", () => {
	let emit: ReturnType<typeof vi.fn>
	let setCleanup: ReturnType<typeof vi.fn>

	beforeEach(() => {
		emit = vi.fn()
		setCleanup = vi.fn()
	})

	const attach = (host: TaskEventForwardingHost, task: FakeTask) => {
		makeTaskCreationCallback(host, { emit, setCleanup })(asTask(task))
	}

	it("emits TaskCreated with the instance itself", () => {
		const task = new FakeTask()
		attach(makeHost(), task)

		expect(emit).toHaveBeenCalledWith(AgentEventName.TaskCreated, asTask(task))
	})

	it("relays task arguments unchanged", () => {
		const task = new FakeTask()
		attach(makeHost(), task)

		const tokenUsage = { totalTokensIn: 1 }
		const toolUsage = { read_file: { attempts: 1, failures: 0 } }
		task.emit(AgentEventName.TaskCompleted, "task-1", tokenUsage, toolUsage)

		expect(emit).toHaveBeenCalledWith(AgentEventName.TaskCompleted, "task-1", tokenUsage, toolUsage)
	})

	it("supplies taskId for events the task emits without arguments", () => {
		const task = new FakeTask("task-42")
		attach(makeHost(), task)

		task.emit(AgentEventName.TaskStarted)
		task.emit(AgentEventName.TaskFocused)
		task.emit(AgentEventName.TaskUnfocused)

		expect(emit).toHaveBeenCalledWith(AgentEventName.TaskStarted, "task-42")
		expect(emit).toHaveBeenCalledWith(AgentEventName.TaskFocused, "task-42")
		expect(emit).toHaveBeenCalledWith(AgentEventName.TaskUnfocused, "task-42")
	})

	it("registers one cleanup per attached listener and detaches them all", () => {
		const task = new FakeTask()
		attach(makeHost(), task)

		const [instance, cleanupFns] = setCleanup.mock.calls[0]
		expect(instance).toBe(task)
		expect(cleanupFns).toHaveLength(task.eventNames().length)

		cleanupFns.forEach((fn: () => void) => fn())
		expect(task.eventNames()).toHaveLength(0)
	})

	it("rehydrates the task from history when streaming failed", async () => {
		const host = makeHost()
		const task = new FakeTask()
		task.abortReason = "streaming_failed"
		task.rootTask = { taskId: "root" } as Task
		task.parentTask = { taskId: "parent" } as Task
		attach(host, task)

		task.emit(AgentEventName.TaskAborted)
		await vi.waitFor(() => expect(host.createTaskWithHistoryItem).toHaveBeenCalled())

		expect(emit).toHaveBeenCalledWith(AgentEventName.TaskAborted, "task-1")
		expect(host.createTaskWithHistoryItem).toHaveBeenCalledWith({
			id: "task-1",
			rootTask: task.rootTask,
			parentTask: task.parentTask,
		})
	})

	it("does not rehydrate on user-initiated cancels", async () => {
		const host = makeHost()
		const task = new FakeTask()
		attach(host, task)

		task.emit(AgentEventName.TaskAborted)
		await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(AgentEventName.TaskAborted, "task-1"))

		expect(host.createTaskWithHistoryItem).not.toHaveBeenCalled()
	})

	it("skips rehydrate when another instance already replaced this one", async () => {
		const host = makeHost({ getCurrentTask: vi.fn(() => asTask(new FakeTask("task-1", "instance-2"))) })
		const task = new FakeTask()
		task.abortReason = "streaming_failed"
		attach(host, task)

		task.emit(AgentEventName.TaskAborted)
		await vi.waitFor(() => expect(host.log).toHaveBeenCalled())

		expect(host.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(vi.mocked(host.log).mock.calls[0][0]).toContain("Skipping rehydrate")
	})

	it("logs instead of throwing when rehydrate fails", async () => {
		const host = makeHost({
			getTaskWithId: vi.fn(async () => {
				throw new Error("history gone")
			}),
		})
		const task = new FakeTask()
		task.abortReason = "streaming_failed"
		attach(host, task)

		task.emit(AgentEventName.TaskAborted)
		await vi.waitFor(() => expect(host.log).toHaveBeenCalled())

		expect(vi.mocked(host.log).mock.calls[0][0]).toContain("history gone")
	})
})
