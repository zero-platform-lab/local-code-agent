// npx vitest run src/utils/__tests__/proxyDispatcher.spec.ts

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { ProxyAgent, Agent } from "undici"

import {
	getProxyDispatcher,
	getExtensionProxyUrl,
	resolveProxyUrl,
	_resetProxyDispatcherCache,
} from "../proxyDispatcher"

// vscode.workspace.getConfiguration("http").get("proxy") を制御する。
const getMock = vi.fn<(key: string) => string | undefined>()
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({ get: getMock }),
	},
}))

const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const

function clearProxyEnv() {
	for (const k of ENV_KEYS) delete process.env[k]
}

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k]
	clearProxyEnv()
	getMock.mockReset()
	getMock.mockReturnValue(undefined)
	_resetProxyDispatcherCache()
})
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k]
		else process.env[k] = saved[k]
	}
})

describe("resolveProxyUrl", () => {
	it("returns undefined when nothing is configured", () => {
		expect(resolveProxyUrl()).toBeUndefined()
	})

	it("prefers VS Code http.proxy over environment variables", () => {
		getMock.mockReturnValue("http://vscode-proxy:3128")
		process.env.HTTPS_PROXY = "http://env-proxy:8080"
		expect(resolveProxyUrl()).toBe("http://vscode-proxy:3128")
	})

	it("falls back to HTTPS_PROXY when VS Code has no setting", () => {
		process.env.HTTPS_PROXY = "http://env-https:8080"
		expect(resolveProxyUrl()).toBe("http://env-https:8080")
	})

	it("prefers HTTPS_PROXY over HTTP_PROXY", () => {
		process.env.HTTPS_PROXY = "http://https-one:1"
		process.env.HTTP_PROXY = "http://http-one:2"
		expect(resolveProxyUrl()).toBe("http://https-one:1")
	})

	it("accepts lowercase env variables", () => {
		process.env.https_proxy = "http://lower-https:1"
		expect(resolveProxyUrl()).toBe("http://lower-https:1")
	})

	it("treats whitespace-only values as unset", () => {
		getMock.mockReturnValue("   ")
		process.env.HTTPS_PROXY = "   "
		expect(resolveProxyUrl()).toBeUndefined()
	})

	it("falls back to env when the VS Code config lookup throws (テスト等 vscode API 不在)", () => {
		// getConfiguration(...).get が例外を投げる状況（vscode API が使えない環境）を再現する。
		getMock.mockImplementation(() => {
			throw new Error("vscode unavailable")
		})
		process.env.HTTPS_PROXY = "http://env-after-throw:8080"
		expect(resolveProxyUrl()).toBe("http://env-after-throw:8080")
	})

	it("vscode が投げ、環境変数も無ければ undefined", () => {
		getMock.mockImplementation(() => {
			throw new Error("vscode unavailable")
		})
		expect(resolveProxyUrl()).toBeUndefined()
	})
})

describe("getProxyDispatcher", () => {
	it("returns undefined when no proxy is configured", () => {
		expect(getProxyDispatcher()).toBeUndefined()
	})

	it("returns a ProxyAgent when a proxy is configured", () => {
		process.env.HTTPS_PROXY = "http://proxy:3128"
		const d = getProxyDispatcher()
		expect(d).toBeInstanceOf(ProxyAgent)
	})

	it("returns the same dispatcher instance for repeated calls (connection-pool reuse)", () => {
		process.env.HTTPS_PROXY = "http://proxy:3128"
		const a = getProxyDispatcher()
		const b = getProxyDispatcher()
		expect(a).toBe(b)
	})

	it("returns a fresh dispatcher when the proxy URL changes", () => {
		process.env.HTTPS_PROXY = "http://proxy-a:3128"
		const a = getProxyDispatcher()
		process.env.HTTPS_PROXY = "http://proxy-b:3128"
		const b = getProxyDispatcher()
		expect(a).toBeDefined()
		expect(b).toBeDefined()
		expect(a).not.toBe(b)
	})

	it("ProxyAgent の生成に失敗する不正な proxy URL では undefined を返す（落ちない）", () => {
		// 不正な URL は new URL(uri) が投げ、ProxyAgent 構築が失敗する → catch で undefined。
		process.env.HTTPS_PROXY = "not-a-valid-url"
		expect(getProxyDispatcher()).toBeUndefined()
	})

	it("VS Code が proxy を管理していれば（proxySupport≠off）自前 dispatcher を出さない", () => {
		// 本物の VS Code は http.proxySupport（既定 "override"）を返す。そこでは VS Code が
		// 認証/PAC 込みで proxy を解決するので、自前 ProxyAgent で上書きしない。
		process.env.HTTPS_PROXY = "http://proxy:3128"
		getMock.mockImplementation((key: string) => (key === "proxySupport" ? "override" : undefined))
		expect(getProxyDispatcher()).toBeUndefined()
	})

	it('proxySupport="off" なら VS Code は proxy を扱わないので自前 dispatcher を使う', () => {
		process.env.HTTPS_PROXY = "http://proxy:3128"
		getMock.mockImplementation((key: string) => (key === "proxySupport" ? "off" : undefined))
		expect(getProxyDispatcher()).toBeInstanceOf(ProxyAgent)
	})
})

describe("getExtensionProxyUrl（拡張独自 proxy 設定）", () => {
	it("openai-agent.proxyUrl があればそれを返す", () => {
		getMock.mockImplementation((key: string) => (key === "proxyUrl" ? "socks5://127.0.0.1:1080" : undefined))
		expect(getExtensionProxyUrl()).toBe("socks5://127.0.0.1:1080")
	})

	it("空白のみは未設定扱い", () => {
		getMock.mockImplementation((key: string) => (key === "proxyUrl" ? "   " : undefined))
		expect(getExtensionProxyUrl()).toBeUndefined()
	})

	it("vscode API が投げても落ちず undefined", () => {
		getMock.mockImplementation(() => {
			throw new Error("vscode unavailable")
		})
		expect(getExtensionProxyUrl()).toBeUndefined()
	})
})

describe("getProxyDispatcher — 拡張独自 proxy を最優先", () => {
	it("http(s):// の拡張 proxy は ProxyAgent（VS Code 管理下でも上書き）", () => {
		getMock.mockImplementation((key: string) => {
			if (key === "proxyUrl") return "http://ext-proxy:3128"
			if (key === "proxySupport") return "override"
			return undefined
		})
		expect(getProxyDispatcher()).toBeInstanceOf(ProxyAgent)
	})

	it("socks5:// の拡張 proxy は SOCKS dispatcher（Agent で ProxyAgent ではない）", () => {
		getMock.mockImplementation((key: string) =>
			key === "proxyUrl" ? "socks5://user:pass@127.0.0.1:1080" : undefined,
		)
		const d = getProxyDispatcher()
		expect(d).toBeInstanceOf(Agent)
		expect(d).not.toBeInstanceOf(ProxyAgent)
	})

	it("socks4:// も SOCKS dispatcher を返す（type=4 経路）", () => {
		getMock.mockImplementation((key: string) => (key === "proxyUrl" ? "socks4://127.0.0.1:1080" : undefined))
		expect(getProxyDispatcher()).toBeInstanceOf(Agent)
	})

	it("拡張 proxy が不正 URL なら undefined（落ちない）", () => {
		getMock.mockImplementation((key: string) => (key === "proxyUrl" ? "::::" : undefined))
		expect(getProxyDispatcher()).toBeUndefined()
	})

	it("拡張 proxy 未設定なら従来ロジック（env の ProxyAgent）に委ねる", () => {
		process.env.HTTPS_PROXY = "http://env:3128"
		expect(getProxyDispatcher()).toBeInstanceOf(ProxyAgent)
	})

	it("vscode API が全面的に投げても env にフォールバックして落ちない", () => {
		getMock.mockImplementation(() => {
			throw new Error("vscode unavailable")
		})
		process.env.HTTPS_PROXY = "http://env:3128"
		expect(getProxyDispatcher()).toBeInstanceOf(ProxyAgent)
	})
})
