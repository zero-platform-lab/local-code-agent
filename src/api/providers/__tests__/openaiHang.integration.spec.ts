// npx vitest run src/api/providers/__tests__/openaiHang.integration.spec.ts
//
// **統合テスト**（モックではなく実サーバ）。「接続は受けるが応答を一切返さない」
// endpoint を localhost に立て、ハンドラがそこへ本物のリクエストを投げて
// **watchdog のタイムアウトで確実に中断する**（＝無限ハングしない）ことを実測する。
//
// 単体テスト（mockCreate が resolve しない）では SDK / fetch の実挙動を通らないため、
// 「abort が効かない環境でも Promise.race で中断できる」ことは実サーバでしか確かめられない。

import http from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
	},
}))

import { OpenAiHandler } from "../openai"
import { allowNetConnect } from "../../../vitest.setup"

/** 接続は受け付けるが、レスポンスを一切返さない（ハングする）サーバ。 */
async function startHangingServer(): Promise<{ port: number; close: () => Promise<void> }> {
	const sockets = new Set<import("node:net").Socket>()
	const server = http.createServer((_req, _res) => {
		// 何も返さない。res.end を呼ばない = クライアントは永遠に応答待ち。
	})
	server.on("connection", (s) => {
		sockets.add(s)
		s.on("close", () => sockets.delete(s))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise((resolve, reject) => {
				for (const s of sockets) s.destroy()
				server.close((e) => (e ? reject(e) : resolve()))
			}),
	}
}

/**
 * 接続は受け付けるが、リクエスト body を一切読まない（socket を pause）サーバ。
 * 大きな body を送ると TCP のフロー制御で **送信が途中で詰まる**（応答待ち以前の
 * 「送信中ハング」）。この状態でも watchdog が中断できるか＝送信フェーズのハングも
 * 保護されるかを実測する。
 */
async function startSendStallServer(): Promise<{ port: number; close: () => Promise<void> }> {
	const sockets = new Set<import("node:net").Socket>()
	const server = http.createServer(() => {
		// ここに到達する頃には body 読み込みが進んでいる。基本は届かない。
	})
	server.on("connection", (s) => {
		sockets.add(s)
		s.pause() // 受信を止める → クライアントの送信が buffer を埋めた時点で詰まる
		s.on("close", () => sockets.delete(s))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise((resolve, reject) => {
				for (const s of sockets) s.destroy()
				server.close((e) => (e ? reject(e) : resolve()))
			}),
	}
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of stream) void _
}

describe("OpenAiHandler against a never-responding endpoint", () => {
	beforeEach(() => {
		allowNetConnect("127.0.0.1")
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("非ストリーミング: 応答が返らなくても watchdog のタイムアウトで中断する", async () => {
		const server = await startHangingServer()
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "m",
				openAiStreamingEnabled: false,
			} as never)
			// テスト用に短いタイムアウト（1.5s）。設定は本来コンストラクタで読むが、ここで上書き。
			;(handler as unknown as { requestTimeoutMs?: number }).requestTimeoutMs = 1500

			const started = Date.now()
			await expect(
				consume(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }] as never)),
			).rejects.toThrow(/timed out after 1500ms/)
			// 無限ハングしていないこと（タイムアウト前後で返っている）。
			expect(Date.now() - started).toBeLessThan(10_000)
		} finally {
			await server.close()
		}
	}, 20_000)

	it("送信途中で詰まっても（サーバが body を読まない）watchdog のタイムアウトで中断する", async () => {
		const server = await startSendStallServer()
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "m",
				openAiStreamingEnabled: false,
			} as never)
			;(handler as unknown as { requestTimeoutMs?: number }).requestTimeoutMs = 1500

			// body を TCP バッファより十分大きくして「送信中ハング」を作る。
			const hugeSystemPrompt = "x".repeat(12_000_000)
			const started = Date.now()
			await expect(
				consume(
					handler.createMessage(hugeSystemPrompt, [
						{ type: "message", role: "user", content: "hi" },
					] as never),
				),
			).rejects.toThrow(/timed out after 1500ms/)
			expect(Date.now() - started).toBeLessThan(10_000)
		} finally {
			await server.close()
		}
	}, 20_000)

	it("ストリーミング: 応答が返らなくても watchdog のタイムアウトで中断する", async () => {
		const server = await startHangingServer()
		try {
			const handler = new OpenAiHandler({
				openAiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
				openAiApiKey: "k",
				openAiModelId: "m",
				openAiStreamingEnabled: true,
			} as never)
			;(handler as unknown as { requestTimeoutMs?: number }).requestTimeoutMs = 1500

			const started = Date.now()
			await expect(
				consume(handler.createMessage("sys", [{ type: "message", role: "user", content: "hi" }] as never)),
			).rejects.toThrow(/timed out after 1500ms/)
			expect(Date.now() - started).toBeLessThan(10_000)
		} finally {
			await server.close()
		}
	}, 20_000)
})
