// npx vitest run core/task/__tests__/runAbortTask.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import { AgentEventName } from "@openai-agent/types"

import { runAbortTask } from "../runAbortTask"

function makeHost(over: Record<string, unknown> = {}) {
	return {
		abandoned: false,
		abort: false,
		graceRetry: { resetAll: vi.fn() },
		taskId: "t1",
		instanceId: "i1",
		tokenUsageTracker: { emitFinal: vi.fn() },
		emit: vi.fn(),
		dispose: vi.fn(),
		saveClineMessages: vi.fn(async () => true),
		...over,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("runAbortTask", () => {
	it("abort フラグを立て、counter リセット・final usage・TaskAborted・dispose・save を順に行う", async () => {
		const host = makeHost()

		await runAbortTask(host as never, false)

		expect(host.abort).toBe(true)
		expect(host.abandoned).toBe(false)
		expect(host.graceRetry.resetAll).toHaveBeenCalled()
		expect(host.tokenUsageTracker.emitFinal).toHaveBeenCalled()
		expect(host.emit).toHaveBeenCalledWith(AgentEventName.TaskAborted)
		expect(host.dispose).toHaveBeenCalled()
		expect(host.saveClineMessages).toHaveBeenCalled()
	})

	it("isAbandoned=true なら abandoned も立てる", async () => {
		const host = makeHost()

		await runAbortTask(host as never, true)

		expect(host.abandoned).toBe(true)
	})

	it("dispose が投げても abort は成功し、save まで進む", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const host = makeHost({
			dispose: vi.fn(() => {
				throw new Error("dispose boom")
			}),
		})

		await expect(runAbortTask(host as never, false)).resolves.toBeUndefined()

		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("disposal"), expect.any(Error))
		expect(host.saveClineMessages).toHaveBeenCalled()
		errSpy.mockRestore()
	})

	it("saveClineMessages が投げても握り潰す（abort は必ず成功する）", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const host = makeHost({
			saveClineMessages: vi.fn(async () => {
				throw new Error("save boom")
			}),
		})

		await expect(runAbortTask(host as never, false)).resolves.toBeUndefined()

		expect(errSpy).toHaveBeenCalledWith(
			expect.stringContaining("Error saving messages during abort"),
			expect.any(Error),
		)
		errSpy.mockRestore()
	})
})
