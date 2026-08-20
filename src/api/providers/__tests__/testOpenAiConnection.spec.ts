// npx vitest run src/api/providers/__tests__/testOpenAiConnection.spec.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { testOpenAiConnection, runConnectionProbe } from "../openai"

// 実装は global fetch で極小チャット補完を POST する。fetch を差し替える。
const originalFetch = globalThis.fetch
const mockedFetch = vi.fn()

// 既定のモデル。モデル未設定だと送信先が定まらないため必須（実補完テスト）。
const MODEL = "gpt-4o-mini"

beforeEach(() => {
	mockedFetch.mockReset()
	globalThis.fetch = mockedFetch as unknown as typeof fetch
})
afterEach(() => {
	globalThis.fetch = originalFetch
})

function ok(status = 200, body: unknown = { choices: [{ message: { content: "ok" } }] }): Response {
	const text = JSON.stringify(body ?? {})
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => null } as unknown as Headers,
		json: async () => body,
		text: async () => text,
	} as unknown as Response
}

// 生のレスポンス（任意の text body / ok フラグ）を返すヘルパ。
function raw(status: number, textBody: string, isOk = status >= 200 && status < 300): Response {
	return {
		ok: isOk,
		status,
		headers: { get: () => null } as unknown as Headers,
		text: async () => textBody,
	} as unknown as Response
}

describe("testOpenAiConnection", () => {
	it("fails when the base URL is missing", async () => {
		const r = await testOpenAiConnection("")
		expect(r.success).toBe(false)
		expect(r.message).toContain("Base URL")
	})

	it("fails when the base URL is malformed", async () => {
		const r = await testOpenAiConnection("not a url")
		expect(r.success).toBe(false)
		expect(r.message).toContain("不正")
	})

	it("fails (clear message) when the model is missing", async () => {
		const r = await testOpenAiConnection("http://x/v1", "k")
		expect(r.success).toBe(false)
		expect(r.message).toContain("モデル")
		// モデルが無ければ 1 度も fetch しない。
		expect(mockedFetch).not.toHaveBeenCalled()
	})

	it("succeeds when the model responds with choices", async () => {
		mockedFetch.mockResolvedValue(ok(200, { choices: [{ message: { content: "hi" } }] }))
		const r = await testOpenAiConnection("http://localhost:8000/v1", "k", undefined, MODEL)
		expect(r.success).toBe(true)
		expect(r.message).toContain("応答")
		expect(r.diagnostics?.modelResponded).toBe(true)
	})

	it("POSTs a minimal chat completion to /chat/completions (non-Azure)", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		const [url, init] = mockedFetch.mock.calls[0]
		expect(url).toBe("http://x/v1/chat/completions")
		expect(init.method).toBe("POST")
		expect(init.headers).toMatchObject({ Authorization: "Bearer k", "content-type": "application/json" })
		const body = JSON.parse(init.body)
		expect(body.model).toBe(MODEL)
		expect(body.stream).toBe(false)
		expect(Array.isArray(body.messages)).toBe(true)
	})

	it("uses the Azure deployments path + api-key header when useAzure is set", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		await testOpenAiConnection(
			"https://ex.openai.azure.com/openai",
			"k",
			undefined,
			MODEL,
			true,
			"2024-08-01-preview",
		)
		const [url, init] = mockedFetch.mock.calls[0]
		expect(url).toBe(
			"https://ex.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-08-01-preview",
		)
		expect(init.headers).toMatchObject({ "api-key": "k" })
		expect(init.headers.Authorization).toBeUndefined()
	})

	it("detects Azure from the host even without useAzure", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		await testOpenAiConnection("https://ex.openai.azure.com/openai", "k", undefined, MODEL)
		const [url] = mockedFetch.mock.calls[0]
		expect(url).toContain("/deployments/gpt-4o-mini/chat/completions?api-version=")
	})

	it("exposes the sent request body in diagnostics (何を送ったか見える)", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		const preview = r.diagnostics?.requestBodyPreview
		expect(preview).toBeDefined()
		const sent = JSON.parse(preview!)
		expect(sent.model).toBe(MODEL)
		expect(sent.stream).toBe(false)
		// 実際に fetch へ渡した body と一致する。
		const [, init] = mockedFetch.mock.calls[0]
		expect(preview).toBe(init.body)
		// human-readable ブロックにも出る。
		expect(r.diagnostics?.humanReadable).toContain("Request body:")
	})

	it("classifies 401/403 as an auth error", async () => {
		mockedFetch.mockResolvedValue(ok(401))
		const r = await testOpenAiConnection("http://x/v1", "bad-key", undefined, MODEL)
		expect(r.success).toBe(false)
		expect(r.message).toContain("認証")
	})

	it("classifies 404 as an endpoint/path error", async () => {
		mockedFetch.mockResolvedValue(ok(404))
		expect((await testOpenAiConnection("http://x", "k", undefined, MODEL)).message).toContain("404")
	})

	it("gives an Azure-specific hint on 404 when Azure", async () => {
		mockedFetch.mockResolvedValue(ok(404))
		const r = await testOpenAiConnection("https://ex.openai.azure.com/openai", "k", undefined, MODEL, true)
		expect(r.message).toContain("デプロイ")
	})

	it("classifies DNS failures", async () => {
		mockedFetch.mockRejectedValue(
			Object.assign(new Error("fetch failed"), {
				cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" },
			}),
		)
		expect((await testOpenAiConnection("http://nope.invalid/v1", "k", undefined, MODEL)).message).toContain("DNS")
	})

	it("classifies connection refused", async () => {
		mockedFetch.mockRejectedValue(
			Object.assign(new Error("fetch failed"), {
				cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" },
			}),
		)
		expect((await testOpenAiConnection("http://localhost:9/v1", "k", undefined, MODEL)).message).toContain("拒否")
	})

	it("classifies TLS/SSL certificate errors", async () => {
		mockedFetch.mockRejectedValue(
			Object.assign(new Error("fetch failed"), {
				cause: { code: "CERT_HAS_EXPIRED", message: "certificate has expired" },
			}),
		)
		expect((await testOpenAiConnection("https://x/v1", "k", undefined, MODEL)).message).toContain("SSL")
	})

	it("classifies timeouts", async () => {
		mockedFetch.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }))
		expect((await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)).message).toContain("タイムアウト")
	})

	it("classifies proxy failures", async () => {
		mockedFetch.mockRejectedValue(new Error("error connecting to proxy"))
		expect((await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)).message).toContain("プロキシ")
	})

	it("passes custom headers through to fetch", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		await testOpenAiConnection("http://x/v1", "k", { "X-Custom": "yes" }, MODEL)
		// ① 通常 + ② tool calling の 2 プローブ。両方が同じヘッダを載せる。
		expect(mockedFetch).toHaveBeenCalledTimes(2)
		for (const [, init] of mockedFetch.mock.calls) {
			expect(init.headers).toMatchObject({
				Authorization: "Bearer k",
				"X-Custom": "yes",
			})
		}
	})

	it("succeeds but flags modelResponded=false when the body is not valid JSON", async () => {
		mockedFetch.mockResolvedValue(raw(200, "<<not json>>"))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(true)
		expect(r.message).toContain("choices が空")
		expect(r.diagnostics?.responseBodyPreview).toContain("not json")
		expect(r.diagnostics?.modelResponded).toBe(false)
	})

	it("handles an empty response body (ok but no choices)", async () => {
		mockedFetch.mockResolvedValue(raw(200, ""))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(true)
		expect(r.diagnostics?.modelResponded).toBe(false)
	})

	it("flags modelResponded=false when choices is present but empty", async () => {
		mockedFetch.mockResolvedValue(ok(200, { choices: [] }))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(true)
		expect(r.diagnostics?.modelResponded).toBe(false)
	})

	it("reports a generic server error for a 5xx status", async () => {
		mockedFetch.mockResolvedValue(ok(500))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(false)
		expect(r.message).toContain("サーバー")
		expect(r.message).toContain("500")
	})

	it("classifies an explicit ETIMEDOUT code as a timeout", async () => {
		mockedFetch.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" }))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.message).toContain("タイムアウト")
	})

	it("classifies a 'timeout' message even without a code", async () => {
		mockedFetch.mockRejectedValue(new Error("upstream timeout while reading"))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.message).toContain("タイムアウト")
	})

	it("falls back to the deep cause message when the top-level message is empty", async () => {
		mockedFetch.mockRejectedValue(Object.assign(new Error(""), { cause: { message: "deep cause detail" } }))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.message).toContain("deep cause detail")
		expect(r.diagnostics?.errorMessage).toBe("deep cause detail")
	})

	it("falls back to String(error) when neither message nor cause message exist", async () => {
		mockedFetch.mockRejectedValue(Object.assign(new Error(""), { cause: {} }))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(false)
		expect(r.message).toContain("Error")
	})

	it("renders diagnostics for a bare object rejection carrying a code", async () => {
		mockedFetch.mockRejectedValue({ code: "ECONNREFUSED", message: "refused hard" })
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(false)
		expect(r.diagnostics?.errorName).toBeUndefined()
		expect(r.diagnostics?.errorCode).toBe("ECONNREFUSED")
		expect(r.diagnostics?.humanReadable).toContain("ECONNREFUSED")
	})

	it("renders diagnostics for a bare object rejection with only a message", async () => {
		mockedFetch.mockRejectedValue({ message: "plain failure only" })
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(false)
		expect(r.diagnostics?.errorName).toBeUndefined()
		expect(r.diagnostics?.errorCode).toBeUndefined()
		expect(r.diagnostics?.humanReadable).toContain("Error")
	})

	it("redacts a non-Bearer sensitive header value (api-key) by length only", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		const r = await testOpenAiConnection("http://x/v1", undefined, { "api-key": "secret123" }, MODEL)
		const apiKeyHeader = r.diagnostics?.requestHeaders.find((h) => h.name.toLowerCase() === "api-key")
		expect(apiKeyHeader?.redactedValue).toBe("<9 chars>")
		expect(r.diagnostics?.humanReadable).not.toContain("secret123")
		expect(JSON.stringify(r.diagnostics)).not.toContain("secret123")
	})

	// --- ② tool calling プローブ（testOpenAiConnection への配線） ---

	it("① 成功時に ② tool calling プローブを追加で投げる（tools 付きボディ）", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(mockedFetch).toHaveBeenCalledTimes(2)
		// ①: tools 無し
		const firstBody = JSON.parse(mockedFetch.mock.calls[0][1].body)
		expect(firstBody.tools).toBeUndefined()
		// ②: tools + tool_choice + parallel_tool_calls、stream:false
		const secondBody = JSON.parse(mockedFetch.mock.calls[1][1].body)
		expect(secondBody.tools).toHaveLength(1)
		expect(secondBody.tools[0].function.name).toBe("connectivity_probe")
		expect(secondBody.tool_choice).toBe("auto")
		expect(secondBody.parallel_tool_calls).toBe(true)
		expect(secondBody.stream).toBe(false)
	})

	it("② tool calling がタイムアウト（無応答）なら失敗として報告する", async () => {
		mockedFetch.mockResolvedValueOnce(ok(200)) // ① 通常は成功
		mockedFetch.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" })) // ② はハング相当
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(false)
		expect(r.message).toContain("tool calling")
		expect(r.diagnostics?.toolCallProbe?.timedOut).toBe(true)
		expect(r.diagnostics?.humanReadable).toContain("② tool calling")
		expect(r.diagnostics?.humanReadable).toContain("TIMEOUT")
	})

	it("② tool calling が HTTP 400 を返したら失敗として報告する", async () => {
		mockedFetch.mockResolvedValueOnce(ok(200)) // ①
		mockedFetch.mockResolvedValueOnce(raw(400, '{"error":"bad tool schema"}')) // ②
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(false)
		expect(r.message).toContain("HTTP 400")
		expect(r.diagnostics?.toolCallProbe?.status).toBe(400)
		expect(r.diagnostics?.humanReadable).toContain("② tool calling")
	})

	it("① が HTTP 401 で失敗したら ② は投げない", async () => {
		mockedFetch.mockResolvedValueOnce(raw(401, "bad key")) // ① 認証失敗
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(false)
		expect(mockedFetch).toHaveBeenCalledTimes(1)
		expect(r.diagnostics?.toolCallProbe).toBeUndefined()
	})

	it("② tool calling も成功なら「通常・tool calling とも応答」メッセージ", async () => {
		mockedFetch.mockResolvedValue(ok(200, { choices: [{ message: { content: "hi" } }] }))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(true)
		expect(r.message).toContain("tool calling")
		expect(r.diagnostics?.toolCallProbe?.status).toBe(200)
		expect(r.diagnostics?.toolCallProbe?.modelResponded).toBe(true)
	})

	it("choices が空でも 2 プローブとも受信すれば success（空 choices 文言）", async () => {
		mockedFetch.mockResolvedValue(ok(200, { choices: [] }))
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(true)
		expect(r.message).toContain("choices が空")
	})

	it("② tool calling が一般エラー（タイムアウト以外）でも失敗として報告する", async () => {
		mockedFetch.mockResolvedValueOnce(ok(200)) // ① 成功
		mockedFetch.mockRejectedValueOnce(new Error("socket hang up")) // ② は非 abort エラー
		const r = await testOpenAiConnection("http://x/v1", "k", undefined, MODEL)
		expect(r.success).toBe(false)
		expect(r.message).toContain("tool calling")
		expect(r.message).toContain("socket hang up")
		expect(r.diagnostics?.toolCallProbe?.timedOut).toBe(false)
		expect(r.diagnostics?.humanReadable).toContain("Result: Error")
	})
})

describe("runConnectionProbe", () => {
	const base = { url: "http://x/v1/chat/completions", headers: { Authorization: "Bearer k" }, model: MODEL }

	it("withTools:false ではボディに tools を載せない", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		const r = await runConnectionProbe({ ...base, label: "L", withTools: false, timeoutMs: 5000 })
		expect(r.withTools).toBe(false)
		expect(JSON.parse(r.requestBodyPreview).tools).toBeUndefined()
		expect(r.status).toBe(200)
		expect(r.modelResponded).toBe(true)
		expect(r.timedOut).toBe(false)
	})

	it("withTools:true ではボディに tools/tool_choice/parallel_tool_calls を載せる", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		const r = await runConnectionProbe({ ...base, label: "L", withTools: true, timeoutMs: 5000 })
		const b = JSON.parse(r.requestBodyPreview)
		expect(b.tools[0].function.name).toBe("connectivity_probe")
		expect(b.tool_choice).toBe("auto")
		expect(b.parallel_tool_calls).toBe(true)
	})

	it("dispatcher を渡すと fetch の init.dispatcher に載せる", async () => {
		mockedFetch.mockResolvedValue(ok(200))
		const dispatcher = { marker: true } as never
		await runConnectionProbe({ ...base, dispatcher, label: "L", withTools: false, timeoutMs: 5000 })
		expect(mockedFetch.mock.calls[0][1].dispatcher).toBe(dispatcher)
	})

	it("timeoutMs 経過で abort し timedOut=true（didTimeout 経路）", async () => {
		mockedFetch.mockImplementation(
			(_u: unknown, init: { signal: AbortSignal }) =>
				new Promise((_, reject) => {
					init.signal.addEventListener("abort", () =>
						reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					)
				}),
		)
		const r = await runConnectionProbe({ ...base, label: "L", withTools: true, timeoutMs: 20 })
		expect(r.timedOut).toBe(true)
	})

	it("即 AbortError なら didTimeout=false でも timedOut=true（|| 右辺）", async () => {
		mockedFetch.mockRejectedValue(Object.assign(new Error("x"), { name: "AbortError" }))
		const r = await runConnectionProbe({ ...base, label: "L", withTools: false, timeoutMs: 5000 })
		expect(r.timedOut).toBe(true)
	})

	it("一般エラーは timedOut=false・errorName/errorMessage を残す", async () => {
		mockedFetch.mockRejectedValue(new Error("boom"))
		const r = await runConnectionProbe({ ...base, label: "L", withTools: false, timeoutMs: 5000 })
		expect(r.timedOut).toBe(false)
		expect(r.errorName).toBe("Error")
		expect(r.errorMessage).toBe("boom")
	})

	it("message が空なら cause.message を採用する（|| 右辺）", async () => {
		mockedFetch.mockRejectedValue(Object.assign(new Error(""), { cause: { message: "deep cause" } }))
		const r = await runConnectionProbe({ ...base, label: "L", withTools: false, timeoutMs: 5000 })
		expect(r.errorMessage).toBe("deep cause")
	})

	it("非 JSON 応答は preview を残し modelResponded は未設定", async () => {
		mockedFetch.mockResolvedValue(raw(200, "not json"))
		const r = await runConnectionProbe({ ...base, label: "L", withTools: false, timeoutMs: 5000 })
		expect(r.responseBodyPreview).toContain("not json")
		expect(r.modelResponded).toBeUndefined()
	})

	it("choices が空配列なら modelResponded=false", async () => {
		mockedFetch.mockResolvedValue(ok(200, { choices: [] }))
		const r = await runConnectionProbe({ ...base, label: "L", withTools: false, timeoutMs: 5000 })
		expect(r.modelResponded).toBe(false)
	})
})
