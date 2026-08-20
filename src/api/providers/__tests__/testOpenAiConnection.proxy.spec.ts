// npx vitest run src/api/providers/__tests__/testOpenAiConnection.proxy.spec.ts
//
// **統合テスト**。モックではなく本物の HTTP proxy を localhost に立てて、
// testOpenAiConnection がその proxy を経由するかを実測する。
//
// なぜ通常の spec ではダメか:
//   従来のテストは「fetch が呼ばれた」「引数に headers が含まれる」までしか
//   検証していなかった。実運用では Node の built-in fetch が HTTPS_PROXY を
//   見ないため、proxy 経由での通信は成立しなかった（ユーザー報告の原因）。
//   ここでは実際のソケットが proxy を経由するかを HTTP レベルで確認する。
//
// **仕組み**:
//   undici の ProxyAgent は plain HTTP でも CONNECT で tunnel を張るため、
//   proxy 単体では最終レスポンスを返せない。そこで:
//     1. 実 origin サーバを localhost に立てる（/models を返す）
//     2. proxy サーバを別 port に立てる。CONNECT を受けたら origin へ tunnel する
//     3. Base URL を http://127.0.0.1:<origin_port>/v1 にして
//        HTTPS_PROXY=http://127.0.0.1:<proxy_port> を設定
//     4. proxy が CONNECT を受け取ったこと + origin がリクエストを受けたこと + 各ヘッダの中身
//   これで「proxy を経由した」ことと「ヘッダが実際に origin に届いた」ことを同時に見る。

import http from "node:http"
import net from "node:net"
import type { AddressInfo } from "node:net"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({ get: () => undefined }),
	},
}))

import nock from "nock"

import { testOpenAiConnection } from "../openai"
import { _resetProxyDispatcherCache } from "../../../utils/proxyDispatcher"
import { allowNetConnect } from "../../../vitest.setup"

interface OriginRequest {
	method: string | undefined
	url: string | undefined
	authorization: string | undefined
	customHeader: string | undefined
}

async function startOrigin(): Promise<{
	port: number
	requests: OriginRequest[]
	close: () => Promise<void>
}> {
	const requests: OriginRequest[] = []
	const server = http.createServer((req, res) => {
		requests.push({
			method: req.method,
			url: req.url,
			authorization: req.headers["authorization"] as string | undefined,
			customHeader: req.headers["x-integration-test"] as string | undefined,
		})
		res.setHeader("content-type", "application/json")
		res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as AddressInfo).port,
		requests,
		close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
	}
}

interface ProxyEvent {
	type: "CONNECT" | "HTTP"
	target: string
}

async function startProxy(): Promise<{
	port: number
	events: ProxyEvent[]
	close: () => Promise<void>
}> {
	const events: ProxyEvent[] = []
	const server = http.createServer((req, res) => {
		// 使わないが、CONNECT 経由ではなく素の HTTP proxying が来た場合の記録。
		events.push({ type: "HTTP", target: req.url ?? "" })
		res.statusCode = 501
		res.end()
	})
	server.on("connect", (req, clientSocket, head) => {
		const target = req.url ?? ""
		events.push({ type: "CONNECT", target })
		const [host, portStr] = target.split(":")
		const port = Number(portStr) || 80

		const serverSocket = net.connect(port, host, () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
			if (head.length) serverSocket.write(head)
			serverSocket.pipe(clientSocket)
			clientSocket.pipe(serverSocket)
		})
		serverSocket.on("error", () => clientSocket.destroy())
		clientSocket.on("error", () => serverSocket.destroy())
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as AddressInfo).port,
		events,
		close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
	}
}

describe("testOpenAiConnection with a real HTTP proxy", () => {
	beforeEach(() => {
		_resetProxyDispatcherCache()
		// vitest.setup.ts の nock.disableNetConnect() で 127.0.0.1 も塞がれるため、
		// 実 socket を張るこのテストでは明示的に緩和する。
		allowNetConnect("127.0.0.1")
	})
	afterEach(() => {
		delete process.env.HTTPS_PROXY
		delete process.env.HTTP_PROXY
		delete process.env.https_proxy
		delete process.env.http_proxy
		_resetProxyDispatcherCache()
		nock.disableNetConnect()
	})

	it("routes the chat-completion request through the configured HTTP_PROXY and preserves headers end-to-end", async () => {
		const origin = await startOrigin()
		const proxy = await startProxy()
		try {
			process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`

			const result = await testOpenAiConnection(
				`http://127.0.0.1:${origin.port}/v1`,
				"secret-key",
				{ "X-Integration-Test": "yes" },
				"gpt-4o-mini",
			)

			// 接続テストは 2 プローブ（① 通常 / ② tool calling）を投げる。両方 proxy を通る。
			// 1. proxy を実際に経由している（CONNECT イベントが 2 回、いずれも origin 宛）
			expect(proxy.events).toHaveLength(2)
			for (const ev of proxy.events) {
				expect(ev.type).toBe("CONNECT")
				expect(ev.target).toBe(`127.0.0.1:${origin.port}`)
			}

			// 2. origin まで 2 リクエスト（① 通常 / ② tool calling）届いている
			expect(origin.requests).toHaveLength(2)
			for (const r of origin.requests) {
				expect(r.method).toBe("POST")
				expect(r.url).toBe("/v1/chat/completions")
				// 3. API キーが Authorization ヘッダに載って origin まで届いている
				expect(r.authorization).toBe("Bearer secret-key")
				// 4. カスタムヘッダが実 HTTP レイヤに載っている
				expect(r.customHeader).toBe("yes")
			}

			// 5. 応答が正しくパースされる（① tools 無し / ② tool calling とも成功）
			expect(result.success).toBe(true)
			expect(result.message).toContain("応答")
		} finally {
			await proxy.close()
			await origin.close()
		}
	})

	it("does NOT use a proxy when none is configured (baseline)", async () => {
		const origin = await startOrigin()
		try {
			const result = await testOpenAiConnection(
				`http://127.0.0.1:${origin.port}/v1`,
				"secret-key",
				undefined,
				"gpt-4o-mini",
			)
			// origin へ直接届いていること（① 通常 / ② tool calling の 2 リクエスト）
			expect(origin.requests).toHaveLength(2)
			for (const r of origin.requests) expect(r.url).toBe("/v1/chat/completions")
			expect(result.success).toBe(true)
		} finally {
			await origin.close()
		}
	})
})
