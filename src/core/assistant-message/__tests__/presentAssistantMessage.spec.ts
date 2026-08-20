// npx vitest run core/assistant-message/__tests__/presentAssistantMessage.spec.ts
//
// presentAssistantMessage は「モデル応答のブロック列を 1 つずつ提示していく」オーケストレータ。
// tool_use / mcp_tool_use の実処理は presentToolUse / presentMcpToolUse へ委譲するので、ここでは
// その 2 つを贋物にして、**制御フローの不変条件**だけを固定する:
//   1. abort 済みなら例外を投げて 1 ブロックも処理しない
//   2. 既にロック中の再入は「保留」を立てて即戻る（多重処理しない）
//   3. パース済みブロックが無い/壊れていても落ちない（複製失敗は握りつぶして解錠する）
//   4. text ブロックは <thinking> タグを剥がして say する。直前に拒否/使用済みなら出さない
//   5. 部分ストリームの扱い（partial は前進せず、保留更新があれば末尾で再帰する）
//
// presentToolUse / presentMcpToolUse は vi.mock で完全に置き換え、委譲先が呼ばれたことだけを見る。

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../presentToolUse", () => ({ presentToolUse: vi.fn(async (..._a: unknown[]) => undefined) }))
vi.mock("../presentMcpToolUse", () => ({ presentMcpToolUse: vi.fn(async (..._a: unknown[]) => undefined) }))

import { presentAssistantMessage } from "../presentAssistantMessage"
import { presentToolUse } from "../presentToolUse"
import { presentMcpToolUse } from "../presentMcpToolUse"

const presentToolUseMock = presentToolUse as unknown as ReturnType<typeof vi.fn>
const presentMcpToolUseMock = presentMcpToolUse as unknown as ReturnType<typeof vi.fn>

// 委譲されない（=await されない）再帰があるので、末尾のマイクロタスク/タイマを掃く。
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

type Stream = {
	assistantMessageContent: any[]
	currentStreamingContentIndex: number
	currentStreamingDidCheckpoint: boolean
	didCompleteReadingStream: boolean
	didAlreadyUseTool: boolean
	didRejectTool: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	userMessageContent: unknown[]
	userMessageContentReady: boolean
}

function makeCline(overrides: Record<string, unknown> = {}) {
	const stream: Stream = {
		assistantMessageContent: [],
		currentStreamingContentIndex: 0,
		currentStreamingDidCheckpoint: false,
		didCompleteReadingStream: false,
		didAlreadyUseTool: false,
		didRejectTool: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		userMessageContent: [],
		userMessageContentReady: false,
	}

	return {
		taskId: "task-1",
		instanceId: "inst-1",
		abort: false,
		stream,
		say: vi.fn(async (..._a: unknown[]) => undefined),
		...overrides,
	} as any
}

beforeEach(() => {
	vi.clearAllMocks()
})

// --- 1. abort ---------------------------------------------------------------

describe("presentAssistantMessage - abort", () => {
	it("abort 済みなら例外を投げ、委譲もしない", async () => {
		const cline = makeCline({ abort: true })
		cline.stream.assistantMessageContent = [{ type: "text", content: "x", partial: false }]

		await expect(presentAssistantMessage(cline)).rejects.toThrow(/aborted/)
		expect(cline.say).not.toHaveBeenCalled()
		expect(presentToolUseMock).not.toHaveBeenCalled()
	})
})

// --- 2. ロック中の再入 -------------------------------------------------------

describe("presentAssistantMessage - ロック中の再入", () => {
	it("ロック中は保留フラグだけ立てて即 return する", async () => {
		const cline = makeCline()
		cline.stream.presentAssistantMessageLocked = true
		cline.stream.assistantMessageContent = [{ type: "text", content: "x", partial: false }]

		await presentAssistantMessage(cline)

		expect(cline.stream.presentAssistantMessageHasPendingUpdates).toBe(true)
		expect(cline.say).not.toHaveBeenCalled()
		// ロック状態には手を付けない（別処理が保持しているため）
		expect(cline.stream.presentAssistantMessageLocked).toBe(true)
	})
})

// --- 3. index が範囲外 -------------------------------------------------------

describe("presentAssistantMessage - index が範囲外", () => {
	it("範囲外かつ読み取り完了なら ready を立てて解錠する", async () => {
		const cline = makeCline()
		cline.stream.assistantMessageContent = [] // length 0
		cline.stream.currentStreamingContentIndex = 0 // 0 >= 0
		cline.stream.didCompleteReadingStream = true

		await presentAssistantMessage(cline)

		expect(cline.stream.userMessageContentReady).toBe(true)
		expect(cline.stream.presentAssistantMessageLocked).toBe(false)
	})

	it("範囲外でも読み取り未完なら ready は立てないが解錠はする", async () => {
		const cline = makeCline()
		cline.stream.currentStreamingContentIndex = 0
		cline.stream.didCompleteReadingStream = false

		await presentAssistantMessage(cline)

		expect(cline.stream.userMessageContentReady).toBe(false)
		expect(cline.stream.presentAssistantMessageLocked).toBe(false)
	})
})

// --- 4. ブロック複製の失敗 ---------------------------------------------------

describe("presentAssistantMessage - ブロック複製の失敗", () => {
	it("複製時に例外が出ても落ちず、解錠して return する", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const cline = makeCline()

		// スプレッド複製時にゲッターが投げるが、catch 内の JSON.stringify は toJSON で無事に済む。
		const throwing: Record<string, unknown> = { toJSON: () => "safe" }
		Object.defineProperty(throwing, "boom", {
			enumerable: true,
			get() {
				throw new Error("clone fail")
			},
		})
		cline.stream.assistantMessageContent = [throwing]

		await expect(presentAssistantMessage(cline)).resolves.toBeUndefined()

		expect(cline.stream.presentAssistantMessageLocked).toBe(false)
		expect(errSpy).toHaveBeenCalled()
		expect(cline.say).not.toHaveBeenCalled()
		errSpy.mockRestore()
	})
})

// --- 5. mcp_tool_use への委譲 ------------------------------------------------

describe("presentAssistantMessage - mcp_tool_use", () => {
	it("mcp_tool_use ブロックは presentMcpToolUse に委譲する", async () => {
		const cline = makeCline()
		cline.stream.assistantMessageContent = [{ type: "mcp_tool_use", id: "c", partial: false }]
		cline.stream.didCompleteReadingStream = true

		await presentAssistantMessage(cline)

		expect(presentMcpToolUseMock).toHaveBeenCalledTimes(1)
		expect(presentMcpToolUseMock.mock.calls[0][1]).toMatchObject({ type: "mcp_tool_use" })
		expect(presentToolUseMock).not.toHaveBeenCalled()
		expect(cline.stream.userMessageContentReady).toBe(true)
	})
})

// --- 6. text ブロック --------------------------------------------------------

describe("presentAssistantMessage - text ブロック", () => {
	it("<thinking> タグを剥がして say する", async () => {
		const cline = makeCline()
		cline.stream.assistantMessageContent = [
			{ type: "text", content: "<thinking>reasoning</thinking>visible", partial: false },
		]
		cline.stream.didCompleteReadingStream = true

		await presentAssistantMessage(cline)

		const said = cline.say.mock.calls[0]
		expect(said[0]).toBe("text")
		expect(said[1]).not.toContain("<thinking>")
		expect(said[1]).not.toContain("</thinking>")
		expect(said[1]).toContain("visible")
		expect(said[3]).toBe(false) // partial
	})

	it("空の text はそのまま say する（strip をスキップし、partial は前進しない）", async () => {
		const cline = makeCline()
		cline.stream.assistantMessageContent = [{ type: "text", content: "", partial: true }]

		await presentAssistantMessage(cline)

		expect(cline.say).toHaveBeenCalledWith("text", "", undefined, true)
		// partial なので index は進めない
		expect(cline.stream.currentStreamingContentIndex).toBe(0)
	})

	it("直前に拒否済みなら text を say しない", async () => {
		const cline = makeCline()
		cline.stream.assistantMessageContent = [{ type: "text", content: "hi", partial: false }]
		cline.stream.didRejectTool = true

		await presentAssistantMessage(cline)

		expect(cline.say).not.toHaveBeenCalled()
	})

	it("直前に使用済みなら text を say しない", async () => {
		const cline = makeCline()
		cline.stream.assistantMessageContent = [{ type: "text", content: "hi", partial: false }]
		cline.stream.didAlreadyUseTool = true

		await presentAssistantMessage(cline)

		expect(cline.say).not.toHaveBeenCalled()
	})
})

// --- 7. 前進と再帰 -----------------------------------------------------------

describe("presentAssistantMessage - 前進と再帰", () => {
	it("完了ブロックの後に次ブロックがあれば自身を再帰呼び出しして全部提示する", async () => {
		const cline = makeCline()
		cline.stream.assistantMessageContent = [
			{ type: "text", content: "one", partial: false },
			{ type: "text", content: "two", partial: false },
		]
		cline.stream.didCompleteReadingStream = true

		await presentAssistantMessage(cline)
		await flush()

		expect(cline.say).toHaveBeenCalledTimes(2)
		expect(cline.say.mock.calls[0]).toEqual(["text", "one", undefined, false])
		expect(cline.say.mock.calls[1]).toEqual(["text", "two", undefined, false])
		expect(cline.stream.userMessageContentReady).toBe(true)
	})

	it("処理中に届いた保留更新があれば末尾で再帰する", async () => {
		const cline = makeCline()
		cline.stream.assistantMessageContent = [{ type: "text", content: "hi", partial: true }]

		let reentered = false
		cline.say = vi.fn(async () => {
			if (!reentered) {
				reentered = true
				// ロック保持中に再入 → 保留フラグが立つ
				await presentAssistantMessage(cline)
			}
			return undefined
		})

		await presentAssistantMessage(cline)
		await flush()

		// 保留を検知して末尾で再帰し、同じ部分ブロックが再提示される
		expect(cline.say.mock.calls.length).toBeGreaterThanOrEqual(2)
		expect(cline.stream.presentAssistantMessageHasPendingUpdates).toBe(false)
	})
})
