// npx vitest run api/providers/__tests__/testOpenAiConnection.proxy-source.spec.ts
//
// proxyResolvedFrom の分類のうち "vscode-http-proxy"（VS Code の http.proxy 設定
// 由来）を実測する。env 由来（"env"）と none は既存の diagnostics/proxy spec で
// 押さえているため、ここは vscode 設定側の 1 分岐に絞る。
//
// fetch は全モックし、実ネットワークには出ない。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// http.proxy に URL を返す vscode 設定をシミュレートする。
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: (section?: string) => ({
			get: (key: string) =>
				section === "http" && key === "proxy" ? "http://vscode-proxy.example:8080" : undefined,
		}),
	},
}))

import { testOpenAiConnection } from "../openai"
import { _resetProxyDispatcherCache } from "../../../utils/proxyDispatcher"

const originalFetch = globalThis.fetch
const mockedFetch = vi.fn()

beforeEach(() => {
	// env 由来と誤判定されないよう、環境変数側の proxy は消しておく。
	delete process.env.HTTPS_PROXY
	delete process.env.HTTP_PROXY
	delete process.env.https_proxy
	delete process.env.http_proxy
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

describe("testOpenAiConnection proxy source (vscode)", () => {
	it('reports proxyResolvedFrom = "vscode-http-proxy" when the URL comes from VS Code settings', async () => {
		const r = await testOpenAiConnection("http://origin.example/v1", "k", undefined, "gpt-4o-mini")
		expect(r.diagnostics?.proxyUrl).toBe("http://vscode-proxy.example:8080")
		expect(r.diagnostics?.proxyResolvedFrom).toBe("vscode-http-proxy")
	})
})
