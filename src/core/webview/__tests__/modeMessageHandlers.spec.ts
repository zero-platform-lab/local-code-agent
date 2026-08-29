// npx vitest run core/webview/__tests__/modeMessageHandlers.spec.ts
//
// モード関連の webview メッセージハンドラ。カスタムモード機構の撤去で
// customModesMessageHandlers から移した、切替・フラグ保存・一覧問い合わせの 3 つ。

import type { WebviewMessage } from "@openai-agent/types"

import { modeMessageHandlers } from "../modeMessageHandlers"
import type { WebviewMessageHost } from "../webviewMessageHost"

function makeHost() {
	return {
		log: vi.fn(),
		handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		getModes: vi.fn().mockResolvedValue([
			{ slug: "code", name: "💻 Code" },
			{ slug: "research", name: "🔍 Research & Ops" },
		]),
		contextProxy: { setValue: vi.fn().mockResolvedValue(undefined) },
	} as unknown as WebviewMessageHost
}

const call = (host: WebviewMessageHost, message: Partial<WebviewMessage>) =>
	modeMessageHandlers[message.type as WebviewMessage["type"]]!(host, message as WebviewMessage)

describe("modeMessageHandlers", () => {
	describe("mode", () => {
		it("実在する slug なら handleModeSwitch する", async () => {
			const host = makeHost()

			await call(host, { type: "mode", text: "research" })

			expect(host.handleModeSwitch).toHaveBeenCalledWith("research")
		})

		it("未知の slug は捨ててログに残す", async () => {
			// 追従質問のサジェスト経由でモデル生成の slug が来るため、検証せずに
			// globalState へ書き込んではならない。
			const host = makeHost()

			await call(host, { type: "mode", text: "no-such-mode" })

			expect(host.handleModeSwitch).not.toHaveBeenCalled()
			expect(host.log).toHaveBeenCalledWith(expect.stringContaining("no-such-mode"))
		})

		it("slug が空でも切り替えない", async () => {
			const host = makeHost()

			await call(host, { type: "mode", text: undefined })

			expect(host.handleModeSwitch).not.toHaveBeenCalled()
		})
	})

	describe("hasOpenedModeSelector", () => {
		it("bool を保存して state を配り直す", async () => {
			const host = makeHost()

			await call(host, { type: "hasOpenedModeSelector", bool: true })

			expect(host.contextProxy.setValue).toHaveBeenCalledWith("hasOpenedModeSelector", true)
			expect(host.postStateToWebview).toHaveBeenCalled()
		})

		it("bool 未指定は true として扱う（?? true の既定側）", async () => {
			const host = makeHost()

			await call(host, { type: "hasOpenedModeSelector" })

			expect(host.contextProxy.setValue).toHaveBeenCalledWith("hasOpenedModeSelector", true)
		})
	})

	describe("requestModes", () => {
		it("モード一覧を webview へ返す", async () => {
			const host = makeHost()

			await call(host, { type: "requestModes" })

			expect(host.postMessageToWebview).toHaveBeenCalledWith({
				type: "modes",
				modes: [
					{ slug: "code", name: "💻 Code" },
					{ slug: "research", name: "🔍 Research & Ops" },
				],
			})
		})

		it("取得に失敗したらログを残して空一覧を返す", async () => {
			const host = makeHost()
			vi.mocked(host.getModes).mockRejectedValue(new Error("boom"))

			await call(host, { type: "requestModes" })

			expect(host.log).toHaveBeenCalledWith(expect.stringContaining("Error fetching modes"))
			expect(host.postMessageToWebview).toHaveBeenCalledWith({ type: "modes", modes: [] })
		})
	})
})
