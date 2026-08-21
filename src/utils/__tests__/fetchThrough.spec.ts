// npx vitest run utils/__tests__/fetchThrough.spec.ts
//
// **VS Code は拡張ホストのグローバル `fetch` を差し替える**
// （`vs/workbench/api/node/extensionHostProcess.js` の `globalThis.fetch = ...`）。
// 差し替え版は undici の `dispatcher` を認識せず黙って捨てるため、`fetch(url, { dispatcher })`
// では proxy を通らない。指定したのに直接接続され、内部ホスト名なら ENOTFOUND で落ちる。
// しかも診断は設定を報告するだけなので「proxy を使っている」と表示され気付きにくい。
//
// そこで dispatcher が有るときだけ undici の fetch を使う。無いときはグローバルのまま——
// そこは VS Code の proxy 解決（認証・PAC 込み）に委ねる場所で、持ち替えると失う。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// vi.mock は巻き上げられるので、モック本体は vi.hoisted で先に作る。
const { undiciFetchMock } = vi.hoisted(() => ({ undiciFetchMock: vi.fn(async () => new Response("undici")) }))

vi.mock("undici", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, fetch: undiciFetchMock }
})

vi.mock("vscode", () => ({ workspace: { getConfiguration: () => ({ get: () => undefined }) } }))

import { fetchThrough } from "../proxyDispatcher"
import { Agent } from "undici"

const originalFetch = globalThis.fetch
const globalFetchMock = vi.fn(async () => new Response("global"))

beforeEach(() => {
	undiciFetchMock.mockClear()
	globalFetchMock.mockClear()
	globalThis.fetch = globalFetchMock as unknown as typeof fetch
})
afterEach(() => {
	globalThis.fetch = originalFetch
})

describe("fetchThrough", () => {
	it("dispatcher が無ければグローバル fetch を使う（VS Code の proxy 解決に委ねる）", async () => {
		await fetchThrough(undefined, "http://example.test/", { method: "GET" })

		expect(globalFetchMock).toHaveBeenCalledOnce()
		expect(undiciFetchMock).not.toHaveBeenCalled()
	})

	it("dispatcher が有れば undici の fetch を使う（差し替え版は dispatcher を捨てるため）", async () => {
		const dispatcher = new Agent()
		await fetchThrough(dispatcher, "http://example.test/", { method: "GET" })

		expect(undiciFetchMock).toHaveBeenCalledOnce()
		expect(globalFetchMock).not.toHaveBeenCalled()
	})

	it("dispatcher を init に載せて渡す", async () => {
		const dispatcher = new Agent()
		await fetchThrough(dispatcher, "http://example.test/", { method: "POST" })

		const [, init] = undiciFetchMock.mock.calls[0] as unknown as [string, Record<string, unknown>]
		expect(init.dispatcher).toBe(dispatcher)
		expect(init.method).toBe("POST")
	})
})
