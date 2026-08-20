import { describe, it, expect, vi, beforeEach } from "vitest"

import { runInitiateTaskLoop } from "../runInitiateTaskLoop"

function makeHost(over: Record<string, unknown> = {}) {
	return {
		abort: false,
		recursivelyMakeClineRequests: vi.fn(async () => true),
		emit: vi.fn(),
		initCheckpointService: vi.fn(),
		rooIgnoreController: { initialize: vi.fn(async () => {}) },
		...over,
	}
}

const userContent = [{ type: "text", text: "start" }] as never

beforeEach(() => {
	vi.clearAllMocks()
})

describe("runInitiateTaskLoop", () => {
	it("起動時に checkpoint 初期化してから TaskStarted を emit する", async () => {
		const host = makeHost()

		await runInitiateTaskLoop({ host } as never, userContent)

		expect(host.initCheckpointService).toHaveBeenCalledTimes(1)
		expect(host.emit).toHaveBeenCalledWith("taskStarted")
		expect(host.initCheckpointService.mock.invocationCallOrder[0]).toBeLessThan(
			host.emit.mock.invocationCallOrder[0],
		)
	})

	it(".agentignore の初期化を await してから初回リクエストへ進む（保護ファイルの素通り窓を塞ぐ）", async () => {
		const order: string[] = []
		const init = vi.fn(async () => {
			order.push("init")
		})
		const rec = vi.fn(async () => {
			order.push("rec")
			return true
		})
		const host = makeHost({ rooIgnoreController: { initialize: init }, recursivelyMakeClineRequests: rec })

		await runInitiateTaskLoop({ host } as never, userContent)

		expect(init).toHaveBeenCalledTimes(1)
		expect(order).toEqual(["init", "rec"])
	})

	it("rooIgnoreController が未設定でも throw せず進む", async () => {
		const host = makeHost({ rooIgnoreController: undefined })

		await expect(runInitiateTaskLoop({ host } as never, userContent)).resolves.toBeUndefined()
		expect(host.recursivelyMakeClineRequests).toHaveBeenCalledTimes(1)
	})

	it("最初から abort ならループを回さない（リクエストしない）", async () => {
		const host = makeHost({ abort: true })

		await runInitiateTaskLoop({ host } as never, userContent)

		expect(host.recursivelyMakeClineRequests).not.toHaveBeenCalled()
		// checkpoint 初期化と emit は abort でも行う
		expect(host.initCheckpointService).toHaveBeenCalledTimes(1)
		expect(host.emit).toHaveBeenCalledTimes(1)
	})

	it("didEndLoop=true なら 1 回で break、初回は includeFileDetails=true", async () => {
		const host = makeHost({ recursivelyMakeClineRequests: vi.fn(async () => true) })

		await runInitiateTaskLoop({ host } as never, userContent)

		expect(host.recursivelyMakeClineRequests).toHaveBeenCalledTimes(1)
		expect(host.recursivelyMakeClineRequests).toHaveBeenCalledWith(userContent, true)
	})

	it("didEndLoop=false なら No-tools プロンプトで再度回し、2 回目は includeFileDetails=false", async () => {
		const rec = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
		const host = makeHost({ recursivelyMakeClineRequests: rec })

		await runInitiateTaskLoop({ host } as never, userContent)

		expect(rec).toHaveBeenCalledTimes(2)
		// 2 回目は includeFileDetails=false、userContent は No tools used プロンプト
		const secondCall = rec.mock.calls[1]
		expect(secondCall[1]).toBe(false)
		expect(secondCall[0]).toHaveLength(1)
		expect(secondCall[0][0]).toMatchObject({ type: "text" })
		expect((secondCall[0][0] as { text: string }).text.length).toBeGreaterThan(0)
	})
})
