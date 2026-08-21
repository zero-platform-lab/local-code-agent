// npx vitest run utils/__tests__/socksDispatcher.spec.ts
//
// SOCKS 経由の実通信を、その場に立てた最小の SOCKS5 サーバで検査する。
//
// ここを実物で見るのは 2 点が単体では出ないため:
//
// 1. **平文 HTTP** の宛先。undici の connector は `httpSocket` を TLS 更新のときしか
//    受け付けない（`assert(!httpSocket, 'httpSocket can only be sent on TLS update')`）。
//    渡すと ERR_ASSERTION で落ちる。ローカルの vLLM / Ollama を SOCKS 越しに使う構成が該当。
// 2. **remote DNS**。宛先をホスト名のまま proxy へ送っているか（ATYP=3）。ローカルで
//    解決してしまうと、proxy の向こうにしか DNS が無い環境で繋がらない。

import { describe, it, expect, afterEach, vi } from "vitest"
import * as net from "node:net"
import * as http from "node:http"

vi.mock("vscode", () => ({ workspace: { getConfiguration: () => ({ get: () => undefined }) } }))

import { getProxyDispatcher, fetchThrough, _resetProxyDispatcherCache } from "../proxyDispatcher"

type Seen = { type: "hostname" | "ipv4"; host: string }

/** 受け取った宛先を記録して、そのまま中継するだけの SOCKS5 サーバ。 */
function startSocks(seen: Seen[], forwardTo: { host: string; port: number }) {
	const server = net.createServer((c) => {
		let stage = 0
		c.on("data", (d) => {
			if (stage === 0) {
				c.write(Buffer.from([0x05, 0x00])) // 認証なしで合意
				stage = 1
				return
			}
			if (stage === 1) {
				const atyp = d[3]
				if (atyp === 0x03) {
					const len = d[4]
					seen.push({ type: "hostname", host: d.subarray(5, 5 + len).toString() })
				} else {
					seen.push({ type: "ipv4", host: `${d[4]}.${d[5]}.${d[6]}.${d[7]}` })
				}
				const up = net.connect(forwardTo, () => {
					c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
					c.pipe(up)
					up.pipe(c)
				})
				up.on("error", () => c.destroy())
				stage = 2
			}
		})
		c.on("error", () => undefined)
	})
	return new Promise<{ port: number; close: () => void }>((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }),
		),
	)
}

function startOrigin() {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end('{"ok":true}')
	})
	return new Promise<{ port: number; close: () => void }>((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }),
		),
	)
}

const cleanups: Array<() => void> = []
afterEach(() => {
	cleanups.splice(0).forEach((f) => f())
	_resetProxyDispatcherCache()
})

describe("SOCKS dispatcher（実サーバ）", () => {
	it("平文 HTTP の宛先を SOCKS 経由で取得できる", async () => {
		const origin = await startOrigin()
		const seen: Seen[] = []
		const socks = await startSocks(seen, { host: "127.0.0.1", port: origin.port })
		cleanups.push(origin.close, socks.close)

		const dispatcher = getProxyDispatcher({ mode: "custom", url: `socks5://127.0.0.1:${socks.port}` })
		const res = await fetchThrough(dispatcher, `http://127.0.0.1:${origin.port}/x`, { method: "GET" })

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
	})

	it("宛先をホスト名のまま proxy へ送る（remote DNS）", async () => {
		const origin = await startOrigin()
		const seen: Seen[] = []
		const socks = await startSocks(seen, { host: "127.0.0.1", port: origin.port })
		cleanups.push(origin.close, socks.close)

		const dispatcher = getProxyDispatcher({ mode: "custom", url: `socks5h://127.0.0.1:${socks.port}` })
		// ローカルでは解決できない名前。proxy 側で解決される前提なので、ここで
		// ローカル解決していれば ENOTFOUND になる。
		await fetchThrough(dispatcher, "http://only-resolvable-via-proxy.invalid/x", { method: "GET" })

		expect(seen).toEqual([{ type: "hostname", host: "only-resolvable-via-proxy.invalid" }])
	})
})
