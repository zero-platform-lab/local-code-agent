// npx vitest run api/providers/__tests__/testOpenAiConnection.timeout.spec.ts
//
// 接続テストの上限が `openai-agent.apiRequestTimeout` に従うことを押さえる。
//
// 以前は 15 秒（tools プローブは 20 秒）の固定値だった。応答の遅いローカルモデルは
// 大きな system prompt のプレフィルで初回チャンクまで数分かかることがあり、
// 繋がっているのに「繋がらない」と誤判定していた。
//
// あわせて「タイムアウト無し」(0) の扱いも押さえる。getApiRequestTimeout は 0 以下で
// undefined を返すが、setTimeout(fn, undefined) は遅延 0 として**即発火**するため、
// 素通しするとウォッチドッグが即座に abort し、無制限を選んだ利用者の接続テストが
// 必ず失敗する。ウォッチドッグ自体を張らないことを検査する。
//
// fetch は全モックし、実ネットワークには出ない。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

let apiRequestTimeoutSeconds: number | undefined

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: (section?: string) => ({
			get: (key: string, defaultValue?: unknown) => {
				if (section === "openai-agent" && key === "apiRequestTimeout") return apiRequestTimeoutSeconds
				return defaultValue
			},
		}),
	},
}))

import { testOpenAiConnection } from "../openai"
import { _resetProxyDispatcherCache } from "../../../utils/proxyDispatcher"

const originalFetch = globalThis.fetch
const mockedFetch = vi.fn()

/** `delayMs` 待ってから応答する fetch。待っている間に abort されたら AbortError。 */
function respondAfter(delayMs: number) {
	return async (_url: unknown, init?: { signal?: AbortSignal }) => {
		await new Promise((resolve) => setTimeout(resolve, delayMs))
		if (init?.signal?.aborted) {
			const error = new Error("The operation was aborted")
			error.name = "AbortError"
			throw error
		}
		return {
			ok: true,
			status: 200,
			headers: { get: () => null } as unknown as Headers,
			text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
		} as unknown as Response
	}
}

beforeEach(() => {
	delete process.env.HTTPS_PROXY
	delete process.env.HTTP_PROXY
	delete process.env.https_proxy
	delete process.env.http_proxy
	_resetProxyDispatcherCache()
	mockedFetch.mockReset()
	globalThis.fetch = mockedFetch as unknown as typeof fetch
})

afterEach(() => {
	globalThis.fetch = originalFetch
	_resetProxyDispatcherCache()
})

describe("testOpenAiConnection timeout", () => {
	it("0（タイムアウト無し）ではウォッチドッグを張らない", async () => {
		apiRequestTimeoutSeconds = 0
		mockedFetch.mockImplementation(respondAfter(30))

		const r = await testOpenAiConnection("http://origin.example/v1", "k", undefined, "gpt-4o-mini")

		// 素通しで setTimeout(abort, undefined) にすると、ここが即 abort されて失敗する。
		expect(r.success).toBe(true)
	})

	it("設定した秒数で打ち切る", async () => {
		apiRequestTimeoutSeconds = 0.02 // 20ms
		mockedFetch.mockImplementation(respondAfter(400))

		const r = await testOpenAiConnection("http://origin.example/v1", "k", undefined, "gpt-4o-mini")

		expect(r.success).toBe(false)
	})

	it("応答が上限より速ければ成功する", async () => {
		apiRequestTimeoutSeconds = 30 // 30s
		mockedFetch.mockImplementation(respondAfter(10))

		const r = await testOpenAiConnection("http://origin.example/v1", "k", undefined, "gpt-4o-mini")

		expect(r.success).toBe(true)
	})
})
