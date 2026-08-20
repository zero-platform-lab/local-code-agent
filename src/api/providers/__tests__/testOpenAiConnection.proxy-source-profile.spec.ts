// npx vitest run api/providers/__tests__/testOpenAiConnection.proxy-source-profile.spec.ts
//
// Model（API 設定プロファイル）単位の proxy を使ったときの診断表示を押さえる。
//
// 解決（getProxyDispatcher）と表示（診断）を別々に引くと、実際に通っている経路と
// 表示がズレる。かつて拡張独自設定でこれが起きており、SOCKS を指定したときに限って
// `Proxy: (none)` と表示していた。切り分けのための機能なので、そこが実態とズレると
// 用を成さない。解決は resolveEffectiveProxy に一本化してあるが、再発を固定する。
//
// fetch は全モックし、実ネットワークには出ない。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const PROFILE_PROXY = "socks5://127.0.0.1:1080"
const VSCODE_PROXY = "http://vscode-proxy.example:8080"

// VS Code 側にも proxy がある状態。プロファイル指定がそれを上書きすることも同時に見る。
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: (section?: string) => ({
			get: (key: string, defaultValue?: unknown) => {
				if (section === "http" && key === "proxy") return VSCODE_PROXY
				return defaultValue
			},
		}),
	},
}))

import { testOpenAiConnection } from "../openai"
import { _resetProxyDispatcherCache } from "../../../utils/proxyDispatcher"

const originalFetch = globalThis.fetch
const mockedFetch = vi.fn()

const args = ["http://origin.example/v1", "k", undefined, "gpt-4o-mini", undefined, undefined] as const

beforeEach(() => {
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

describe("接続テスト診断の proxy 表示", () => {
	it("プロファイル指定の proxy をそのまま報告する", async () => {
		const r = await testOpenAiConnection(...args, { mode: "custom", url: PROFILE_PROXY })

		expect(r.diagnostics?.proxyUrl).toBe(PROFILE_PROXY)
		expect(r.diagnostics?.proxyResolvedFrom).toBe("profile")
		expect(r.diagnostics?.humanReadable).toContain(PROFILE_PROXY)
		// 実態は SOCKS 経由なのに "(none)" と出すのが元の不具合。
		expect(r.diagnostics?.humanReadable).not.toContain("Proxy: (none)")
	})

	it("直結指定を「未設定」と混同しない", async () => {
		const r = await testOpenAiConnection(...args, { mode: "direct" })

		expect(r.diagnostics?.proxyUrl).toBeUndefined()
		expect(r.diagnostics?.proxyResolvedFrom).toBe("profile-direct")
		// VS Code 側に proxy がある環境で「直結を選んだ」のか「未設定」なのかが
		// 読めないと切り分けられない。
		expect(r.diagnostics?.humanReadable).toContain("直結")
		expect(r.diagnostics?.humanReadable).not.toContain("Proxy: (none)")
	})

	it("指定が無ければ VS Code の解決を報告する", async () => {
		const r = await testOpenAiConnection(...args)

		expect(r.diagnostics?.proxyUrl).toBe(VSCODE_PROXY)
		expect(r.diagnostics?.proxyResolvedFrom).toBe("vscode-http-proxy")
	})
})
