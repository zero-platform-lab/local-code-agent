// npx vitest run src/api/providers/__tests__/testOpenAiConnection.diagnostics.spec.ts
//
// 診断ブロックの内容と伏せ字の実測。
// - API キーの値そのものはログにも UI にも出ないこと
// - 送信 URL / method / ヘッダ名 / proxy 情報が診断に含まれること
// - 成功時は modelResponded と応答 body preview が含まれること
// - 失敗時（404 / abort）はエラーコードや status が含まれること

import http from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import nock from "nock"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({ get: () => undefined }),
	},
}))

import { testOpenAiConnection } from "../openai"
import { allowNetConnect } from "../../../vitest.setup"
import { _resetProxyDispatcherCache } from "../../../utils/proxyDispatcher"

async function startOrigin(handler: http.RequestListener): Promise<{
	port: number
	close: () => Promise<void>
}> {
	const server = http.createServer(handler)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as AddressInfo).port,
		close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
	}
}

describe("testOpenAiConnection diagnostics", () => {
	beforeEach(() => {
		_resetProxyDispatcherCache()
		allowNetConnect("127.0.0.1")
	})
	afterEach(() => {
		nock.disableNetConnect()
		delete process.env.HTTPS_PROXY
		delete process.env.HTTP_PROXY
	})

	it("includes request URL / method / header names but never the API key value", async () => {
		const origin = await startOrigin((_req, res) => {
			res.setHeader("content-type", "application/json")
			res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))
		})
		try {
			const secret = "sk-super-secret-1234567890"
			const r = await testOpenAiConnection(
				`http://127.0.0.1:${origin.port}/v1`,
				secret,
				{ "X-Custom": "custom-value-abc" },
				"gpt-4o-mini",
			)
			const d = r.diagnostics!

			// URL / method
			expect(d.requestUrl).toBe(`http://127.0.0.1:${origin.port}/v1/chat/completions`)
			expect(d.requestMethod).toBe("POST")

			// ヘッダ名は載る
			const names = d.requestHeaders.map((h) => h.name.toLowerCase())
			expect(names).toContain("authorization")
			expect(names).toContain("x-custom")

			// API キーの実値は載らない
			expect(d.humanReadable).not.toContain(secret)
			expect(JSON.stringify(d)).not.toContain(secret)

			// カスタムヘッダの値も伏せる
			expect(d.humanReadable).not.toContain("custom-value-abc")

			// 長さ情報は残っている
			const auth = d.requestHeaders.find((h) => h.name.toLowerCase() === "authorization")!
			expect(auth.length).toBe(`Bearer ${secret}`.length)
			expect(auth.redactedValue).toContain("Bearer")
			expect(auth.redactedValue).toContain(`${secret.length} chars`)
		} finally {
			await origin.close()
		}
	})

	it("captures response status, header sample, body preview, and modelResponded on success", async () => {
		const origin = await startOrigin((_req, res) => {
			res.setHeader("content-type", "application/json")
			res.setHeader("x-request-id", "req-abc")
			res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }))
		})
		try {
			const r = await testOpenAiConnection(`http://127.0.0.1:${origin.port}/v1`, "k", undefined, "gpt-4o-mini")
			const d = r.diagnostics!

			expect(r.success).toBe(true)
			expect(d.responseStatus).toBe(200)
			expect(d.responseHeaders).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "content-type", value: "application/json" }),
					expect.objectContaining({ name: "x-request-id", value: "req-abc" }),
				]),
			)
			expect(d.responseBodyPreview).toContain("hi")
			expect(d.modelResponded).toBe(true)
		} finally {
			await origin.close()
		}
	})

	it("captures HTTP status and body preview on 4xx", async () => {
		const origin = await startOrigin((_req, res) => {
			res.writeHead(401, { "content-type": "application/json" })
			res.end(JSON.stringify({ error: { message: "bad key" } }))
		})
		try {
			const r = await testOpenAiConnection(
				`http://127.0.0.1:${origin.port}/v1`,
				"wrong",
				undefined,
				"gpt-4o-mini",
			)
			const d = r.diagnostics!
			expect(r.success).toBe(false)
			expect(d.responseStatus).toBe(401)
			expect(d.responseBodyPreview).toContain("bad key")
			expect(d.humanReadable).toContain("HTTP 401")
		} finally {
			await origin.close()
		}
	})

	it("records error name / cause code when the connection fails", async () => {
		// 誰も listen していないポート → connect が拒否される。
		const r = await testOpenAiConnection(`http://127.0.0.1:1/v1`, "k", undefined, "gpt-4o-mini")
		const d = r.diagnostics!
		expect(r.success).toBe(false)
		// name か code のどちらかは埋まる
		expect(d.errorName || d.errorCode || d.errorCauseCode).toBeTruthy()
		expect(d.humanReadable).toContain("Error")
	})

	it("shows the resolved proxy URL when HTTPS_PROXY is set", async () => {
		process.env.HTTPS_PROXY = "http://proxy.example:3128"
		_resetProxyDispatcherCache()
		// 実接続は失敗して構わない。diagnostics に proxy URL が載れば十分。
		const r = await testOpenAiConnection(`http://never.invalid/v1`, "k", undefined, "gpt-4o-mini")
		expect(r.diagnostics?.proxyUrl).toBe("http://proxy.example:3128")
		expect(r.diagnostics?.proxyResolvedFrom).toBe("env")
	})
})
