// npx vitest run core/tools/__tests__/accessMcpResourceTool.spec.ts
//
// access_mcp_resource は MCP サーバのリソースを読み出すツール。承認拒否・必須パラメータ
// 欠落・例外といった「事故が起きる側」の経路がまったく検証されていなかった（C0 0%）。
//
// ここで固定するのは次の不変条件:
//   1. **利用者が拒否したら readResource は 1 度も呼ばれない**（承認ゲートの不変条件。
//      ExecuteCommandTool.invariants.spec の expectNoCommandRan と同じ形）
//   2. 必須パラメータ（server_name / uri）が欠けたら承認も readResource も走らない
//   3. 承認を通った場合のみ readResource へ到達し、text/画像の整形が正しく行われる
//
// McpHub は実体を起動せず、readResource を含めて丸ごと贋物にして
// 「readResource が呼ばれていないこと」をアサートできるようにしている。

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ToolUse } from "../../../shared/tools"

// formatResponse を差し替え（生成文字列を単純化して観測しやすくする）。
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolResult: vi.fn((text: string, images?: string[]) =>
			images && images.length > 0 ? `RESULT:${text}[+${images.length}img]` : `RESULT:${text}`,
		),
		toolDenied: vi.fn(() => "DENIED"),
	},
}))

import { accessMcpResourceTool } from "../accessMcpResourceTool"
import { makeMockTask } from "../../task/__tests__/makeMockTask"

/**
 * **readResource が 1 度も呼ばれていないこと。** 承認ゲートを通らない経路で
 * 外部リソース読み出し（副作用）に到達しないことを固定する。
 */
function expectResourceNeverRead(readResource: ReturnType<typeof vi.fn>, label: string) {
	expect(readResource, `${label}: mcpHub.readResource`).not.toHaveBeenCalled()
}

describe("accessMcpResourceTool", () => {
	let task: any
	let askApproval: ReturnType<typeof vi.fn>
	let handleError: ReturnType<typeof vi.fn>
	let pushToolResult: ReturnType<typeof vi.fn>
	let readResource: ReturnType<typeof vi.fn>

	const cbs = () => ({ askApproval, handleError, pushToolResult })

	const wireHub = (hub: unknown) => {
		task.providerRef = {
			deref: vi.fn().mockReturnValue({ getMcpHub: vi.fn().mockReturnValue(hub) }),
		}
	}

	/** readResource 付きの hub を張る。戻り値はテストごとに指定。 */
	const wireResource = (result?: unknown) => {
		readResource = vi.fn().mockResolvedValue(result)
		wireHub({ readResource })
	}

	const block = (server?: string, uri?: string, partial = false): ToolUse<"access_mcp_resource"> => ({
		type: "tool_use",
		name: "access_mcp_resource",
		params: { server_name: server, uri },
		nativeArgs: { server_name: server ?? "", uri: uri ?? "" } as any,
		partial,
	})

	beforeEach(() => {
		askApproval = vi.fn().mockResolvedValue(true)
		handleError = vi.fn()
		pushToolResult = vi.fn()
		readResource = vi.fn()

		task = makeMockTask() as any
		task.sayAndCreateMissingParamError = vi.fn().mockResolvedValue("MISSING")
		task.say = vi.fn().mockResolvedValue(undefined)
		task.ask = vi.fn().mockResolvedValue(undefined)
		wireHub({ readResource })
	})

	describe("必須パラメータ", () => {
		it("server_name 欠落 → missing param を返し、承認も readResource も走らない", async () => {
			await accessMcpResourceTool.handle(task, block(undefined, "res://x"), cbs())

			expect(task.mistakeTracker.count).toBe(1)
			expect(task.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("access_mcp_resource")
			expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("access_mcp_resource", "server_name")
			expect(pushToolResult).toHaveBeenCalledWith("MISSING")
			expect(askApproval).not.toHaveBeenCalled()
			expectResourceNeverRead(readResource, "server_name 欠落")
		})

		it("uri 欠落 → missing param を返し、承認も readResource も走らない", async () => {
			await accessMcpResourceTool.handle(task, block("srv", undefined), cbs())

			expect(task.mistakeTracker.count).toBe(1)
			expect(task.tokenUsageTracker.recordToolError).toHaveBeenCalledWith("access_mcp_resource")
			expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("access_mcp_resource", "uri")
			expect(pushToolResult).toHaveBeenCalledWith("MISSING")
			expect(askApproval).not.toHaveBeenCalled()
			expectResourceNeverRead(readResource, "uri 欠落")
		})
	})

	describe("承認ゲート", () => {
		it("利用者が拒否したら toolDenied を返し readResource は 1 度も呼ばれない", async () => {
			askApproval.mockResolvedValue(false)
			wireResource({ contents: [{ uri: "u", text: "秘密" }] })

			await accessMcpResourceTool.handle(task, block("srv", "res://x"), cbs())

			expect(task.mistakeTracker.count).toBe(0)
			expect(askApproval).toHaveBeenCalledWith("use_mcp_server", expect.stringContaining("access_mcp_resource"))
			expect(pushToolResult).toHaveBeenCalledWith("DENIED")
			expect(task.say).not.toHaveBeenCalledWith("mcp_server_request_started")
			expectResourceNeverRead(readResource, "利用者が拒否")
		})
	})

	describe("承認後の実行と整形", () => {
		it("text コンテンツを結合して say / tool_result を返す", async () => {
			wireResource({
				contents: [
					{ uri: "u1", text: "hello" },
					{ uri: "u2", text: "" }, // 空 text は除外される
					{ uri: "u3" }, // text 無しも除外
				],
			})

			await accessMcpResourceTool.handle(task, block("srv", "res://x"), cbs())

			expect(task.say).toHaveBeenCalledWith("mcp_server_request_started")
			expect(readResource).toHaveBeenCalledWith("srv", "res://x")
			expect(task.say).toHaveBeenCalledWith("mcp_server_response", "hello", [])
			expect(pushToolResult).toHaveBeenCalledWith("RESULT:hello")
		})

		it("resourceResult が undefined なら (Empty response)", async () => {
			wireResource(undefined)

			await accessMcpResourceTool.handle(task, block("srv", "res://x"), cbs())

			expect(readResource).toHaveBeenCalledWith("srv", "res://x")
			expect(task.say).toHaveBeenCalledWith("mcp_server_response", "(Empty response)", [])
			expect(pushToolResult).toHaveBeenCalledWith("RESULT:(Empty response)")
		})

		it("全 text が空なら (Empty response) に畳む", async () => {
			wireResource({ contents: [{ uri: "u1", text: "" }, { uri: "u2" }] })

			await accessMcpResourceTool.handle(task, block("srv", "res://x"), cbs())

			expect(task.say).toHaveBeenCalledWith("mcp_server_response", "(Empty response)", [])
		})

		it("画像コンテンツを分類・整形する（生 base64 / data URL / 非画像 / blob 無し / mime 無し）", async () => {
			wireResource({
				contents: [
					{ uri: "t", text: "本文" }, // text
					{ uri: "i1", mimeType: "image/png", blob: "RAW" }, // 生 base64 → data: 付与
					{ uri: "i2", mimeType: "image/jpeg", blob: "data:image/jpeg;base64,ZZ" }, // 既に data URL
					{ uri: "n1", mimeType: "text/plain", blob: "NOTIMG" }, // 非画像 → 除外
					{ uri: "n2", mimeType: "image/gif" }, // blob 無し → 除外
					{ uri: "n3", blob: "NOMIME" }, // mimeType 無し → 除外
				],
			})

			await accessMcpResourceTool.handle(task, block("srv", "res://x"), cbs())

			expect(task.say).toHaveBeenCalledWith("mcp_server_response", "本文", [
				"data:image/png;base64,RAW",
				"data:image/jpeg;base64,ZZ",
			])
			expect(pushToolResult).toHaveBeenCalledWith("RESULT:本文[+2img]")
		})
	})

	describe("例外処理", () => {
		it("readResource が Error を投げたら handleError('accessing MCP resource') に委ねる", async () => {
			const boom = new Error("読み出し失敗")
			readResource = vi.fn().mockRejectedValue(boom)
			wireHub({ readResource })

			await accessMcpResourceTool.handle(task, block("srv", "res://x"), cbs())

			expect(handleError).toHaveBeenCalledWith("accessing MCP resource", boom)
		})

		it("非 Error を投げても Error に包んで handleError へ渡す", async () => {
			readResource = vi.fn().mockRejectedValue("文字列エラー")
			wireHub({ readResource })

			await accessMcpResourceTool.handle(task, block("srv", "res://x"), cbs())

			expect(handleError).toHaveBeenCalledWith("accessing MCP resource", expect.any(Error))
			const [, err] = handleError.mock.calls[0]
			expect((err as Error).message).toContain("文字列エラー")
		})
	})

	describe("handlePartial", () => {
		it("server_name / uri を含む partial メッセージで use_mcp_server を ask する", async () => {
			await accessMcpResourceTool.handlePartial(task, block("srv", "res://x", true))

			const [askType, payload, partialFlag] = task.ask.mock.calls[0]
			expect(askType).toBe("use_mcp_server")
			const parsed = JSON.parse(payload as string)
			expect(parsed).toEqual({ type: "access_mcp_resource", serverName: "srv", uri: "res://x" })
			expect(partialFlag).toBe(true)
		})

		it("server_name / uri 未定義でも空文字にフォールバックして ask する", async () => {
			const partialBlock: ToolUse<"access_mcp_resource"> = {
				type: "tool_use",
				name: "access_mcp_resource",
				params: {},
				partial: true,
			}

			await accessMcpResourceTool.handlePartial(task, partialBlock)

			const [, payload] = task.ask.mock.calls[0]
			const parsed = JSON.parse(payload as string)
			expect(parsed).toEqual({ type: "access_mcp_resource", serverName: "", uri: "" })
		})
	})
})
