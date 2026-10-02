// npx vitest run core/webview/__tests__/webviewDiagnostics.spec.ts
//
// 白い画面の調査用のログ。出力パネルに残る文が、切り分けに使える形になっているかを確かめる。

import {
	STATE_POST_WARN_BYTES,
	describeStatePost,
	describeWebviewLaunch,
	formatWebviewDiagnostic,
	postStateWithDiagnostics,
} from "../webviewDiagnostics"
import { uiMessageHandlers } from "../uiMessageHandlers"
import type { WebviewMessageHost } from "../webviewMessageHost"

vi.mock("vscode", () => ({ commands: { executeCommand: vi.fn() }, window: {} }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

/** JSON にすると `bytes` バイトちょうどになる状態。`{"clineMessages":[""]}` の枠の分を差し引いて埋める。 */
function stateOfBytes(bytes: number) {
	const frame = Buffer.byteLength(JSON.stringify({ clineMessages: [""] }), "utf8")
	return { clineMessages: ["x".repeat(bytes - frame)] as never[] }
}

describe("describeStatePost", () => {
	it("上限ちょうどは警告しない", () => {
		const state = stateOfBytes(100)

		expect(describeStatePost(state, 100)).toBe("[Webview] state post: 100 bytes, clineMessages=1")
	})

	it("上限を 1 バイトでも超えたら警告する", () => {
		const state = stateOfBytes(101)

		expect(describeStatePost(state, 100)).toBe(
			"[Webview] WARN state post: 101 bytes, clineMessages=1 (over 100 bytes)",
		)
	})

	it("既定の上限は 5 MB で、届く大きさの状態で警告になる", () => {
		expect(STATE_POST_WARN_BYTES).toBe(5 * 1024 * 1024)

		const line = describeStatePost(stateOfBytes(STATE_POST_WARN_BYTES + 1))

		expect(line).toMatch(/^\[Webview\] WARN state post: 5242881 bytes/)
	})

	it("clineMessages を省いた状態はそう書く", () => {
		expect(describeStatePost({})).toBe("[Webview] state post: 2 bytes, clineMessages=omitted")
	})

	it("バイト数は文字数ではなく UTF-8 で数える", () => {
		// 「あ」は 3 バイト。文字数で数えると 1 になる。
		const line = describeStatePost({ clineMessages: ["あ"] as never[] }, 1_000)

		expect(line).toBe(
			`[Webview] state post: ${Buffer.byteLength('{"clineMessages":["あ"]}')} bytes, clineMessages=1`,
		)
	})

	it("直列化できない状態は、計測の失敗として警告する", () => {
		const circular: Record<string, unknown> = { clineMessages: [] }
		circular.self = circular

		expect(describeStatePost(circular as never)).toMatch(
			/^\[Webview\] WARN state post: failed to measure \(clineMessages=0\): .*circular/i,
		)
	})

	it("Error 以外が投げられても、文にして残す", () => {
		const state = {
			clineMessages: [],
			toJSON() {
				throw "not an error"
			},
		}

		expect(describeStatePost(state as never)).toBe(
			"[Webview] WARN state post: failed to measure (clineMessages=0): not an error",
		)
	})
})

describe("describeWebviewLaunch", () => {
	const now = new Date("2026-10-02T07:00:00.000Z")

	it("タスクの途中なら、そのタスクを書く", () => {
		expect(describeWebviewLaunch("t-1", now)).toBe(
			"[Webview] launched at 2026-10-02T07:00:00.000Z (task t-1 is running)",
		)
	})

	it("タスクが無ければ、そう書く", () => {
		expect(describeWebviewLaunch(undefined, now)).toBe("[Webview] launched at 2026-10-02T07:00:00.000Z (no task)")
	})
})

describe("postStateWithDiagnostics", () => {
	it("大きさをログへ残してから、状態を送る", async () => {
		const order: string[] = []
		const host = {
			log: vi.fn((line: string) => void order.push(`log:${line}`)),
			postMessageToWebview: vi.fn(async (message: unknown) => void order.push(`post:${JSON.stringify(message)}`)),
		}

		await postStateWithDiagnostics(host, { clineMessages: [] }, 1_000)

		expect(order).toEqual([
			"log:[Webview] state post: 20 bytes, clineMessages=0",
			'post:{"type":"state","state":{"clineMessages":[]}}',
		])
	})

	it("状態が無くても落ちずに送る", async () => {
		const host = { log: vi.fn(), postMessageToWebview: vi.fn(async () => undefined) }

		await postStateWithDiagnostics(host, undefined)

		expect(host.log).toHaveBeenCalledWith("[Webview] state post: 2 bytes, clineMessages=omitted")
		expect(host.postMessageToWebview).toHaveBeenCalledWith({ type: "state", state: undefined })
	})
})

describe("Webview から届いた診断", () => {
	it("[Webview] を付けて出力パネルへ書く", async () => {
		const provider = { log: vi.fn() } as unknown as WebviewMessageHost

		await uiMessageHandlers.webviewDiagnostic!(provider, { type: "webviewDiagnostic", text: "error: boom" })

		expect(provider.log).toHaveBeenCalledWith("[Webview] error: boom")
	})

	it("本文が無くても、届いたことは残す", () => {
		expect(formatWebviewDiagnostic(undefined)).toBe("[Webview] (empty diagnostic)")
	})
})
