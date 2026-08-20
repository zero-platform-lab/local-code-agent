// npx vitest run core/task/__tests__/TaskLauncher.spec.ts

import { TaskLauncher } from "../TaskLauncher"

const makeTargets = () => ({
	startTask: vi.fn(async () => {}),
	resumeTaskFromHistory: vi.fn(async () => {}),
})

describe("TaskLauncher.sourceFrom", () => {
	it("prefers task/images over historyItem (matches the old constructor branch order)", () => {
		expect(TaskLauncher.sourceFrom({ task: "hello", historyItem: { id: "x" } })).toEqual({
			kind: "fresh",
			task: "hello",
			images: undefined,
		})
		expect(TaskLauncher.sourceFrom({ images: ["img"], historyItem: { id: "x" } })).toEqual({
			kind: "fresh",
			task: undefined,
			images: ["img"],
		})
	})

	it("resolves to history when only a historyItem is given", () => {
		expect(TaskLauncher.sourceFrom({ historyItem: { id: "x" } })).toEqual({ kind: "history" })
	})

	it("resolves to none when nothing is given", () => {
		expect(TaskLauncher.sourceFrom({})).toEqual({ kind: "none" })
	})

	it("treats an empty task string as no source", () => {
		expect(TaskLauncher.sourceFrom({ task: "" })).toEqual({ kind: "none" })
	})
})

describe("TaskLauncher.start", () => {
	it("runs startTask with the captured task/images for a fresh source", async () => {
		const targets = makeTargets()
		const launcher = new TaskLauncher({ kind: "fresh", task: "hello", images: ["img"] }, targets)

		expect(launcher.isStarted).toBe(false)
		await launcher.start()

		expect(targets.startTask).toHaveBeenCalledWith("hello", ["img"])
		expect(targets.resumeTaskFromHistory).not.toHaveBeenCalled()
		expect(launcher.isStarted).toBe(true)
	})

	it("resumes from history for a history source", async () => {
		const targets = makeTargets()

		await new TaskLauncher({ kind: "history" }, targets).start()

		expect(targets.resumeTaskFromHistory).toHaveBeenCalledOnce()
		expect(targets.startTask).not.toHaveBeenCalled()
	})

	it("does nothing for a source-less task", async () => {
		const targets = makeTargets()
		const launcher = new TaskLauncher({ kind: "none" }, targets)

		await launcher.start()

		expect(targets.startTask).not.toHaveBeenCalled()
		expect(targets.resumeTaskFromHistory).not.toHaveBeenCalled()
		expect(launcher.isStarted).toBe(true)
	})

	it("is idempotent — a second start() is a no-op", async () => {
		const targets = makeTargets()
		const launcher = new TaskLauncher({ kind: "fresh", task: "hello" }, targets)

		await launcher.start()
		await launcher.start()

		expect(targets.startTask).toHaveBeenCalledOnce()
	})

	it("marks itself started before awaiting, so a re-entrant start() cannot double-fire", async () => {
		const targets = makeTargets()
		const holder: { launcher?: TaskLauncher } = {}
		targets.startTask.mockImplementation(async () => {
			await holder.launcher?.start()
		})
		holder.launcher = new TaskLauncher({ kind: "fresh", task: "hello" }, targets)

		await holder.launcher.start()

		expect(targets.startTask).toHaveBeenCalledOnce()
	})

	it("propagates the underlying rejection to the caller", async () => {
		const targets = makeTargets()
		targets.startTask.mockRejectedValueOnce(new Error("boom"))

		await expect(new TaskLauncher({ kind: "fresh", task: "hello" }, targets).start()).rejects.toThrow("boom")
	})

	it("exposes the source kind", () => {
		expect(new TaskLauncher({ kind: "history" }, makeTargets()).kind).toBe("history")
	})
})
