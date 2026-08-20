// npx vitest run core/task/__tests__/buildApiRequestDeps.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import { buildApiRequestDeps } from "../buildApiRequestDeps"

/** buildApiRequestDeps は host の method を大量に .bind() するので、全て関数で埋める。 */
function makeHost() {
	return {
		taskId: "t1",
		cwd: "/cwd",
		tokenUsageTracker: { getTokenUsage: vi.fn(() => ({ contextTokens: 1 })) },
		overwriteApiConversationHistory: vi.fn(async () => {}),
		combineMessages: vi.fn((m: unknown) => m),
		getCurrentProfileId: vi.fn(() => "p1"),
		getFilesReadByAgentSafely: vi.fn(async () => []),
		flushPendingToolResultsToHistory: vi.fn(async () => true),
		getSystemPrompt: vi.fn(async () => "SYS"),
		say: vi.fn(async () => {}),
		ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
		processQueuedMessages: vi.fn(),
		maybeWaitForProviderRateLimit: vi.fn(async () => {}),
		backoffAndAnnounce: vi.fn(async () => {}),
	} as never
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("buildApiRequestDeps.buildTools", () => {
	it("provider が無ければ空の tools 配列を返す（buildNativeTools は呼ばない）", async () => {
		const deps = buildApiRequestDeps(makeHost(), {
			getProvider: () => undefined,
			stampLastGlobalApiRequestTime: vi.fn(),
		} as never)

		const result = await deps.buildTools({ modelInfo: {} } as never)

		expect(result).toEqual({ tools: [] })
	})
})

describe("buildApiRequestDeps.postCondenseTaskContext", () => {
	it("started=true なら condenseTaskContextStarted を webview に投げる", async () => {
		const postMessageToWebview = vi.fn(async () => {})
		const deps = buildApiRequestDeps(makeHost(), {
			getProvider: () => ({ postMessageToWebview }) as never,
			stampLastGlobalApiRequestTime: vi.fn(),
		} as never)

		await deps.postCondenseTaskContext(true)

		expect(postMessageToWebview).toHaveBeenCalledWith({ type: "condenseTaskContextStarted", text: "t1" })
	})

	it("started=false なら condenseTaskContextResponse を投げる", async () => {
		const postMessageToWebview = vi.fn(async () => {})
		const deps = buildApiRequestDeps(makeHost(), {
			getProvider: () => ({ postMessageToWebview }) as never,
			stampLastGlobalApiRequestTime: vi.fn(),
		} as never)

		await deps.postCondenseTaskContext(false)

		expect(postMessageToWebview).toHaveBeenCalledWith({ type: "condenseTaskContextResponse", text: "t1" })
	})

	it("provider が無ければ何もしない（optional chain）", async () => {
		const deps = buildApiRequestDeps(makeHost(), {
			getProvider: () => undefined,
			stampLastGlobalApiRequestTime: vi.fn(),
		} as never)

		await expect(deps.postCondenseTaskContext(true)).resolves.toBeUndefined()
	})
})

describe("buildApiRequestDeps.log", () => {
	it("provider.log に委譲する（段階表示ログ）", () => {
		const log = vi.fn()
		const deps = buildApiRequestDeps(makeHost(), {
			getProvider: () => ({ log }) as never,
			stampLastGlobalApiRequestTime: vi.fn(),
		} as never)

		deps.log?.("[API] test")

		expect(log).toHaveBeenCalledWith("[API] test")
	})

	it("provider が無ければ何もしない", () => {
		const deps = buildApiRequestDeps(makeHost(), {
			getProvider: () => undefined,
			stampLastGlobalApiRequestTime: vi.fn(),
		} as never)

		expect(() => deps.log?.("x")).not.toThrow()
	})
})
