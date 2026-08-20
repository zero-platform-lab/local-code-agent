// npx vitest run utils/__tests__/proxyDispatcher.perModel.spec.ts
//
// Model（API 設定プロファイル）単位の proxy 指定を押さえる。
//
// 動機は、SOCKS 経由のモデルと直結のモデルが同一環境に混在すること。VS Code の
// http.proxy はマシン全体に 1 つしか無いため、それだけではどちらかが必ず通らない。
// とくに **"direct"（明示的に直結）** が無いと「VS Code 側に proxy がある状態で
// 直結のモデルを使う」構成が組めない——未設定は「継承」の意味なので、上書きして
// proxy を外す手段にならないため。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const VSCODE_PROXY = "http://vscode-proxy.example:8080"

// VS Code 側に proxy がある状態。ここを起点に、プロファイル側で上書きできるかを見る。
// proxySupport は未設定にして「VS Code 管理下」判定に落ちないようにする（落ちると
// 拡張は dispatcher を張らず、上書きの検査にならない）。
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

import { resolveEffectiveProxy, getProxyDispatcher, _resetProxyDispatcherCache } from "../proxyDispatcher"

beforeEach(() => {
	delete process.env.HTTPS_PROXY
	delete process.env.HTTP_PROXY
	delete process.env.https_proxy
	delete process.env.http_proxy
	_resetProxyDispatcherCache()
})

afterEach(() => _resetProxyDispatcherCache())

describe("resolveEffectiveProxy (Model 単位)", () => {
	it("指定が無ければ VS Code の解決を継承する", () => {
		expect(resolveEffectiveProxy()).toEqual({ url: VSCODE_PROXY, source: "vscode-http-proxy" })
		expect(resolveEffectiveProxy({ mode: "inherit" })).toEqual({
			url: VSCODE_PROXY,
			source: "vscode-http-proxy",
		})
	})

	it('"direct" は VS Code の設定を上書きして proxy を外す', () => {
		// これが本命。VS Code 側に proxy があっても、このモデルだけ直結にできる。
		expect(resolveEffectiveProxy({ mode: "direct" })).toEqual({ url: undefined, source: "profile-direct" })
		expect(getProxyDispatcher({ mode: "direct" })).toBeUndefined()
	})

	it('"custom" はそのモデル専用の URL を使う', () => {
		expect(resolveEffectiveProxy({ mode: "custom", url: "http://per-model.example:3128" })).toEqual({
			url: "http://per-model.example:3128",
			source: "profile",
		})
	})

	it('"custom" で URL が空なら継承に落とす', () => {
		// 設定途中（モードだけ選んで URL 未入力）で通信を壊さないため。
		for (const url of [undefined, "", "   "]) {
			expect(resolveEffectiveProxy({ mode: "custom", url })).toEqual({
				url: VSCODE_PROXY,
				source: "vscode-http-proxy",
			})
		}
	})
})

describe("dispatcher キャッシュ", () => {
	it("URL ごとに保持し、交互に使っても作り直さない", () => {
		const a1 = getProxyDispatcher({ mode: "custom", url: "http://a.example:3128" })
		const b1 = getProxyDispatcher({ mode: "custom", url: "http://b.example:3128" })
		const a2 = getProxyDispatcher({ mode: "custom", url: "http://a.example:3128" })
		const b2 = getProxyDispatcher({ mode: "custom", url: "http://b.example:3128" })

		expect(a1).toBeDefined()
		expect(b1).toBeDefined()
		expect(a1).not.toBe(b1)
		// 単一エントリのキャッシュだと、交互に引くたびに作り直しになっていた。
		expect(a2).toBe(a1)
		expect(b2).toBe(b1)
	})
})
