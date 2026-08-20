import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { ExtensionContext } from "vscode"

import type { McpProviderRef } from "../mcpProviderRef"

// McpHub 本体は接続層。ここは「シングルトンの寿命管理」だけを検証したいので、
// 本物の外部サーバへ繋がる McpHub をモックし、new / waitUntilReady / dispose だけ観測する。
const hubInstances: Array<{ waitUntilReady: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = []

vi.mock("../McpHub", () => ({
	McpHub: vi.fn().mockImplementation(() => {
		const instance = {
			waitUntilReady: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
		hubInstances.push(instance)
		return instance
	}),
}))

import { McpHub } from "../McpHub"
import { McpServerManager } from "../McpServerManager"

const MockedMcpHub = vi.mocked(McpHub)

/** globalState.update を観測できる最小の ExtensionContext。 */
function makeContext() {
	const update = vi.fn().mockResolvedValue(undefined)
	return { context: { globalState: { update } } as unknown as ExtensionContext, update }
}

/** postMessageToWebview を観測できる最小の provider。 */
function makeProvider(overrides: Partial<McpProviderRef> = {}): McpProviderRef {
	return {
		cwd: "/ws",
		context: {},
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/settings"),
		getState: vi.fn().mockResolvedValue({}),
		...overrides,
	}
}

beforeEach(() => {
	hubInstances.length = 0
	MockedMcpHub.mockClear()
})

afterEach(async () => {
	// シングルトンの静的状態はテストを跨いで残るので毎回リセットする。
	const { context } = makeContext()
	await McpServerManager.cleanup(context)
})

describe("McpServerManager.getInstance", () => {
	it("初回は McpHub を生成し waitUntilReady を待って global state を書く", async () => {
		const { context, update } = makeContext()
		const provider = makeProvider()

		const hub = await McpServerManager.getInstance(context, provider)

		expect(MockedMcpHub).toHaveBeenCalledTimes(1)
		expect(hubInstances[0].waitUntilReady).toHaveBeenCalledTimes(1)
		expect(update).toHaveBeenCalledWith("mcpHubInstanceId", expect.any(String))
		expect(hub).toBe(hubInstances[0])
	})

	it("2 回目以降は既存インスタンスを返し McpHub を作り直さない", async () => {
		const { context } = makeContext()

		const first = await McpServerManager.getInstance(context, makeProvider())
		const second = await McpServerManager.getInstance(context, makeProvider())

		expect(first).toBe(second)
		expect(MockedMcpHub).toHaveBeenCalledTimes(1)
	})

	it("初期化中に来た並行呼び出しは同じ初期化 promise を共有する", async () => {
		const { context } = makeContext()

		const [a, b] = await Promise.all([
			McpServerManager.getInstance(context, makeProvider()),
			McpServerManager.getInstance(context, makeProvider()),
		])

		expect(a).toBe(b)
		expect(MockedMcpHub).toHaveBeenCalledTimes(1)
	})
})

describe("McpServerManager.notifyProviders", () => {
	it("登録済み provider 全てへ postMessage する", async () => {
		const { context } = makeContext()
		const p1 = makeProvider()
		const p2 = makeProvider()
		await McpServerManager.getInstance(context, p1)
		await McpServerManager.getInstance(context, p2)

		McpServerManager.notifyProviders({ type: "ping" })

		expect(p1.postMessageToWebview).toHaveBeenCalledWith({ type: "ping" })
		expect(p2.postMessageToWebview).toHaveBeenCalledWith({ type: "ping" })
	})

	it("postMessage が失敗しても他の provider の通知は止めない", async () => {
		const { context } = makeContext()
		const failing = makeProvider({ postMessageToWebview: vi.fn().mockRejectedValue(new Error("boom")) })
		const ok = makeProvider()
		await McpServerManager.getInstance(context, failing)
		await McpServerManager.getInstance(context, ok)

		// reject は catch されるので throw しない。
		expect(() => McpServerManager.notifyProviders({ type: "ping" })).not.toThrow()
		expect(ok.postMessageToWebview).toHaveBeenCalledWith({ type: "ping" })
		// マイクロタスクを 1 周させて catch を確定させる（未処理 rejection を出さない）。
		await Promise.resolve()
	})

	it("unregisterProvider した provider には通知しない", async () => {
		const { context } = makeContext()
		const removed = makeProvider()
		const kept = makeProvider()
		await McpServerManager.getInstance(context, removed)
		await McpServerManager.getInstance(context, kept)

		McpServerManager.unregisterProvider(removed)
		McpServerManager.notifyProviders({ type: "ping" })

		expect(removed.postMessageToWebview).not.toHaveBeenCalled()
		expect(kept.postMessageToWebview).toHaveBeenCalledWith({ type: "ping" })
	})
})

describe("McpServerManager.cleanup", () => {
	it("インスタンスを dispose し global state を消してから provider 集合を空にする", async () => {
		const { context, update } = makeContext()
		await McpServerManager.getInstance(context, makeProvider())
		const created = hubInstances[0]

		await McpServerManager.cleanup(context)

		expect(created.dispose).toHaveBeenCalledTimes(1)
		expect(update).toHaveBeenLastCalledWith("mcpHubInstanceId", undefined)

		// dispose 後は次の getInstance が新しいインスタンスを作る。
		await McpServerManager.getInstance(context, makeProvider())
		expect(MockedMcpHub).toHaveBeenCalledTimes(2)
	})

	it("インスタンスが無いときの cleanup は dispose を呼ばず provider だけ片付ける", async () => {
		const { context, update } = makeContext()

		await McpServerManager.cleanup(context)

		// instance null なので dispose 対象は無く、global state 更新も走らない。
		expect(update).not.toHaveBeenCalled()
	})
})
