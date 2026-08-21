// npx vitest run api/providers/__tests__/testOpenAiConnection.proxy-not-applied.spec.ts
//
// proxy を指定したのに dispatcher の構築に失敗すると、proxy 無しの直接接続に落ちる。
// このとき診断が proxy 名だけを出していると「proxy 経由で失敗した」と誤読させる。
// 実際にそれで原因特定が遅れたので、**適用されなかったことを明示する**。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) },
}))

import { testOpenAiConnection } from "../openai"
import { _resetProxyDispatcherCache } from "../../../utils/proxyDispatcher"

const originalFetch = globalThis.fetch
const mockedFetch = vi.fn()

beforeEach(() => {
	_resetProxyDispatcherCache()
	mockedFetch.mockReset()
	mockedFetch.mockResolvedValue({
		ok: true,
		status: 200,
		headers: { get: () => null } as unknown as Headers,
		text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
	} as unknown as Response)
	globalThis.fetch = mockedFetch as unknown as typeof fetch
})
afterEach(() => {
	globalThis.fetch = originalFetch
	_resetProxyDispatcherCache()
})

const args = ["http://origin.example/v1", "k", undefined, "gpt-4o-mini", undefined, undefined] as const

describe("proxy が適用されなかったときの診断", () => {
	it("URL 不正で dispatcher を作れなければ、適用されていないと明示する", async () => {
		const r = await testOpenAiConnection(...args, { mode: "custom", url: "socks5://[不正" })

		expect(r.diagnostics?.proxyApplied).toBe(false)
		expect(r.diagnostics?.proxyError).toBeTruthy()
		expect(r.diagnostics?.humanReadable).toContain("適用されていません")
		// 理由を捨てずに出す。
		expect(r.diagnostics?.humanReadable).toContain("proxy を使えなかった理由")
	})

	it("正しく作れていれば適用済みとして扱い、警告は出さない", async () => {
		const r = await testOpenAiConnection(...args, { mode: "custom", url: "http://proxy.example:3128" })

		expect(r.diagnostics?.proxyApplied).toBe(true)
		expect(r.diagnostics?.humanReadable).not.toContain("適用されていません")
	})

	it("proxy を指定していなければ警告とは無関係", async () => {
		const r = await testOpenAiConnection(...args, { mode: "direct" })

		expect(r.diagnostics?.proxyApplied).toBe(false)
		expect(r.diagnostics?.humanReadable).not.toContain("適用されていません")
	})
})
