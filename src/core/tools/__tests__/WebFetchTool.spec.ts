import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest"

const { getProxyDispatcherMock, fetchThroughMock } = vi.hoisted(() => ({
	getProxyDispatcherMock: vi.fn(),
	fetchThroughMock: vi.fn(),
}))
// dispatcher の受け渡しは fetchThrough が担う（VS Code がグローバル fetch を差し替えるため、
// init に dispatcher を積むだけでは効かない）。ここではそこへ正しく渡すかだけを見る。
vi.mock("../../../utils/proxyDispatcher", () => ({
	getProxyDispatcher: getProxyDispatcherMock,
	fetchThrough: fetchThroughMock,
}))

import { WebFetchTool, fetchUrlAsText, htmlToText, toFetchError } from "../WebFetchTool"
import type { ToolCallbacks } from "../BaseTool"

const originalFetch = globalThis.fetch
const fetchMock = fetchThroughMock

function response(status: number, body: string, contentType: string | null): Response {
	return {
		status,
		headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
		text: async () => body,
	} as unknown as Response
}

beforeEach(() => {
	vi.clearAllMocks()
	getProxyDispatcherMock.mockReturnValue(undefined)
	globalThis.fetch = vi.fn() as unknown as typeof fetch
})

describe("htmlToText", () => {
	it("strips script/style/comments/tags and decodes entities", () => {
		const html = `<html><head><style>.x{}</style><script>bad()</script></head><body><!-- c --><h1>Title</h1><p>a &amp; b &lt;ok&gt;</p><br><div>next</div></body></html>`
		const out = htmlToText(html)
		expect(out).not.toContain("bad()")
		expect(out).not.toContain(".x{}")
		// 実タグは除去される（<h1>/<p>/<div> は残らない）。
		expect(out).not.toContain("<h1>")
		expect(out).not.toContain("<p>")
		expect(out).not.toContain("<div>")
		expect(out).toContain("Title")
		// 実体参照はデコードされる（&amp;→&, &lt;→<, &gt;→>）。
		expect(out).toContain("a & b <ok>")
		expect(out).toContain("next")
	})
})

describe("fetchUrlAsText", () => {
	it("HTML はテキスト化する", async () => {
		fetchMock.mockResolvedValue(response(200, "<p>Hello <b>world</b></p>", "text/html; charset=utf-8"))
		const out = await fetchUrlAsText("https://x.test/page")
		expect(out).toContain("HTTP 200 https://x.test/page")
		expect(out).toContain("Hello world")
		expect(out).not.toContain("<p>")
	})

	it("非 HTML は生のまま返す", async () => {
		fetchMock.mockResolvedValue(response(200, "plain text body", "text/plain"))
		const out = await fetchUrlAsText("https://x.test/raw")
		expect(out).toContain("plain text body")
	})

	it("max_length で打ち切る", async () => {
		fetchMock.mockResolvedValue(response(200, "abcdefghij", "text/plain"))
		const out = await fetchUrlAsText("https://x.test/long", 4)
		expect(out).toContain("abcd")
		expect(out).toContain("truncated at 4 chars")
		expect(out).not.toContain("efghij")
	})

	it("proxy dispatcher があれば fetchThrough へ渡す", async () => {
		const dispatcher = { marker: true }
		getProxyDispatcherMock.mockReturnValue(dispatcher)
		fetchMock.mockResolvedValue(response(200, "ok", "text/plain"))
		await fetchUrlAsText("https://x.test/proxied")
		expect(fetchMock.mock.calls[0][0]).toBe(dispatcher)
	})

	it("proxy が無ければ dispatcher 無しで呼ぶ", async () => {
		fetchMock.mockResolvedValue(response(200, "ok", "text/plain"))
		await fetchUrlAsText("https://x.test/direct")
		expect(fetchMock.mock.calls[0][0]).toBeUndefined()
	})

	it("content-type ヘッダが無ければ unknown 表示・生のまま", async () => {
		fetchMock.mockResolvedValue(response(200, "<p>x</p>", null))
		const out = await fetchUrlAsText("https://x.test/noct")
		expect(out).toContain("content-type: unknown")
		expect(out).toContain("<p>x</p>") // html 判定されないので生のまま
	})
})

describe("WebFetchTool.execute", () => {
	function makeTask() {
		return {
			mistakeTracker: { count: 0 },
			stream: { didToolFailInCurrentTurn: false },
			sayAndCreateMissingParamError: vi.fn(async (_t: string, p: string) => `missing:${p}`),
			say: vi.fn(async () => undefined),
		}
	}
	function makeCallbacks(approve = true) {
		return {
			askApproval: vi.fn(async () => approve),
			handleError: vi.fn(async () => {}),
			pushToolResult: vi.fn(),
		} as unknown as ToolCallbacks & { askApproval: Mock; handleError: Mock; pushToolResult: Mock }
	}
	const tool = new WebFetchTool()

	it("url 未指定は missing param エラー", async () => {
		const task = makeTask()
		const cb = makeCallbacks()
		await tool.execute({ url: "" } as never, task as never, cb)
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("web_fetch", "url")
		expect(cb.pushToolResult).toHaveBeenCalledWith("missing:url")
		expect(task.stream.didToolFailInCurrentTurn).toBe(true)
	})

	it("不正 URL は toolError", async () => {
		const task = makeTask()
		const cb = makeCallbacks()
		await tool.execute({ url: "not a url" } as never, task as never, cb)
		expect(cb.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Invalid URL"))
		expect(cb.askApproval).not.toHaveBeenCalled()
	})

	it("http(s) 以外のスキームは toolError", async () => {
		const task = makeTask()
		const cb = makeCallbacks()
		await tool.execute({ url: "ftp://x.test/f" } as never, task as never, cb)
		expect(cb.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("only http(s)"))
	})

	it("承認拒否なら toolDenied", async () => {
		const task = makeTask()
		const cb = makeCallbacks(false)
		await tool.execute({ url: "https://x.test/p" } as never, task as never, cb)
		expect(cb.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({ tool: "webFetch", url: "https://x.test/p" }),
		)
		expect(cb.pushToolResult).toHaveBeenCalled()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("承認されたら取得結果を push する", async () => {
		fetchMock.mockResolvedValue(response(200, "hello", "text/plain"))
		const task = makeTask()
		const cb = makeCallbacks(true)
		await tool.execute({ url: "https://x.test/ok" } as never, task as never, cb)
		expect(cb.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("hello"))
		expect(task.mistakeTracker.count).toBe(0)
	})

	it("fetch が失敗したら handleError", async () => {
		fetchMock.mockRejectedValue(new Error("network down"))
		const task = makeTask()
		const cb = makeCallbacks(true)
		await tool.execute({ url: "https://x.test/err" } as never, task as never, cb)
		expect(cb.handleError).toHaveBeenCalledWith("web_fetch", expect.any(Error))
		expect(task.stream.didToolFailInCurrentTurn).toBe(true)
	})

	it("fetch が非 Error を throw しても handleError に Error を渡す", async () => {
		fetchMock.mockRejectedValue("string failure")
		const task = makeTask()
		const cb = makeCallbacks(true)
		await tool.execute({ url: "https://x.test/e2" } as never, task as never, cb)
		expect(cb.handleError).toHaveBeenCalledWith("web_fetch", expect.any(Error))
	})
})

describe("toFetchError", () => {
	it("AbortError はタイムアウト文言にする", () => {
		const err = new Error("aborted")
		err.name = "AbortError"
		expect(toFetchError("https://x.test/a", err).message).toBe("web_fetch timed out for https://x.test/a after 30s")
	})

	it("TimeoutError もタイムアウト文言にする", () => {
		const err = new Error("timeout")
		err.name = "TimeoutError"
		expect(toFetchError("https://x.test/t", err).message).toContain("timed out")
	})

	it("cause が code 付き Error なら code(message) を出す", () => {
		const err = new Error("fetch failed")
		;(err as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
		expect(toFetchError("https://x.test/c", err).message).toBe(
			"web_fetch failed for https://x.test/c: fetch failed: ECONNREFUSED (connect ECONNREFUSED)",
		)
	})

	it("cause が code 無し Error なら message を出す", () => {
		const err = new Error("fetch failed")
		;(err as { cause?: unknown }).cause = new Error("unable to verify the first certificate")
		expect(toFetchError("https://x.test/tls", err).message).toBe(
			"web_fetch failed for https://x.test/tls: fetch failed: unable to verify the first certificate",
		)
	})

	it("cause が非 Error（文字列）なら String 化して出す", () => {
		const err = new Error("boom")
		;(err as { cause?: unknown }).cause = "weird cause"
		expect(toFetchError("https://x.test/s", err).message).toBe(
			"web_fetch failed for https://x.test/s: boom: weird cause",
		)
	})

	it("cause が無ければ message だけ", () => {
		expect(toFetchError("https://x.test/n", new Error("network down")).message).toBe(
			"web_fetch failed for https://x.test/n: network down",
		)
	})

	it("Error でない throw は String 化する", () => {
		expect(toFetchError("https://x.test/x", "kaboom").message).toBe("web_fetch failed for https://x.test/x: kaboom")
	})
})

// クリーンアップ
afterEach(() => {
	globalThis.fetch = originalFetch
})
