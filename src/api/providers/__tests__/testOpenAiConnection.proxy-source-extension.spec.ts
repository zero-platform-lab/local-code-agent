// npx vitest run api/providers/__tests__/testOpenAiConnection.proxy-source-extension.spec.ts
//
// 拡張独自設定 `openai-agent.proxyUrl` を使ったときの診断表示を押さえる。
//
// 以前は実通信（getProxyDispatcher）が拡張設定を最優先する一方、診断は
// VS Code の http.proxy と環境変数しか見ていなかった。結果、SOCKS を拡張設定に
// 入れた場合——つまり VS Code 側では指定しようのない、拡張設定を使う唯一の理由が
// ある場合——に限って診断が `Proxy: (none)` と表示していた。切り分けのための機能
// なので、そこが実態とズレると用を成さない。
//
// fetch は全モックし、実ネットワークには出ない。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const EXTENSION_PROXY = "socks5://127.0.0.1:1080"

// 拡張設定に SOCKS を入れ、VS Code 側は proxySupport を既定 ("override") 相当にする。
// この状態で「VS Code 管理下だから委ねる」に落ちてしまうと拡張設定が無視されるため、
// 拡張設定が優先されることもここで担保される。
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: (section?: string) => ({
			get: (key: string, defaultValue?: unknown) => {
				if (section === "openai-agent" && key === "proxyUrl") return EXTENSION_PROXY
				if (section === "http" && key === "proxySupport") return "override"
				return defaultValue
			},
		}),
	},
}))

import { testOpenAiConnection } from "../openai"
import { _resetProxyDispatcherCache, resolveEffectiveProxy } from "../../../utils/proxyDispatcher"

const originalFetch = globalThis.fetch
const mockedFetch = vi.fn()

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

describe("proxy resolution (extension setting)", () => {
	it("VS Code 管理下でも拡張独自設定を優先する", () => {
		expect(resolveEffectiveProxy()).toEqual({ url: EXTENSION_PROXY, source: "extension-setting" })
	})

	it("診断が実際に使う proxy を報告する", async () => {
		const r = await testOpenAiConnection("http://origin.example/v1", "k", undefined, "gpt-4o-mini")
		expect(r.diagnostics?.proxyUrl).toBe(EXTENSION_PROXY)
		expect(r.diagnostics?.proxyResolvedFrom).toBe("extension-setting")
	})

	it("人間可読の診断にも proxy が出る", async () => {
		const r = await testOpenAiConnection("http://origin.example/v1", "k", undefined, "gpt-4o-mini")
		expect(r.diagnostics?.humanReadable).toContain(EXTENSION_PROXY)
		// 実態は SOCKS 経由なのに "(none)" と出すのが元の不具合。
		expect(r.diagnostics?.humanReadable).not.toContain("Proxy: (none)")
	})
})
