// npx vitest run core/condense/__tests__/index.coverage.spec.ts
//
// 既存 index.spec.ts では届かない分岐（API エラー catch・folded context の失敗・
// environmentDetails の自動注入・tool トークン加算・ネスト condense・cleanup の混在ケース）を埋める。

import type { ApiHandler } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"

vi.mock("../../../api/transform/image-cleaning", () => ({
	maybeRemoveImageBlocks: vi.fn((messages: ApiMessage[]) => [...messages]),
}))

// generateFoldedFileContext は差し替えて、成功・失敗を制御する
vi.mock("../foldedFileContext", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../foldedFileContext")>()
	return {
		...actual,
		generateFoldedFileContext: vi.fn(),
	}
})

import { summarizeConversation, extractCommandBlocks, cleanupAfterTruncation, getEffectiveApiHistory } from "../index"
import { generateFoldedFileContext } from "../foldedFileContext"

const mockedGenerateFolded = vi.mocked(generateFoldedFileContext)

const taskId = "test-task"
const systemPrompt = "You are a helpful assistant."

/** テキストのみを流す成功ストリーム。usage の totalCost は任意。 */
function makeStream(text: string, usage?: { totalCost?: number }) {
	return (async function* () {
		yield { type: "text" as const, text }
		yield { type: "usage" as const, ...(usage ?? {}) }
	})()
}

/** 反復（for await）中に reject するストリーム。ジェネレータを使わず require-yield を避ける。 */
function makeThrowingStream(err: unknown) {
	return {
		[Symbol.asyncIterator]() {
			return { next: () => Promise.reject(err) }
		},
	} as any
}

function makeApiHandler(stream: AsyncGenerator<any> | object): ApiHandler {
	return {
		createMessage: vi.fn().mockReturnValue(stream),
		countTokens: vi.fn().mockResolvedValue(100),
		getModel: vi.fn().mockReturnValue({ id: "m", info: { contextWindow: 8000, supportsPromptCache: false } }),
	} as unknown as ApiHandler
}

/** 要約をトリガするのに十分な通常メッセージ列（summary なし）。 */
function longMessages(): ApiMessage[] {
	return [
		{ type: "message", role: "user", content: "Hello", ts: 1 },
		{ type: "message", role: "assistant", content: "Hi", ts: 2 },
		{ type: "message", role: "user", content: "How are you?", ts: 3 },
		{ type: "message", role: "assistant", content: "Good", ts: 4 },
		{ type: "message", role: "user", content: "Tell me more", ts: 5 },
	]
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedGenerateFolded.mockResolvedValue({
		content: "",
		sections: [],
		filesProcessed: 0,
		filesSkipped: 0,
		characterCount: 0,
	})
})

describe("extractCommandBlocks: 空テキスト", () => {
	it("itemText が空なら早期に空文字を返す（!text の true 側）", () => {
		const msg: ApiMessage = { type: "message", role: "user", content: "" }
		expect(extractCommandBlocks(msg)).toBe("")
	})
})

describe("summarizeConversation: 直近サマリ後すぐの再要約", () => {
	it("サマリ直後で対象が 2 件以下なら condensed_recently エラー（recentSummaryExists && length<=2）", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "old", ts: 1 },
			{ type: "message", role: "user", content: "summary", ts: 2, isSummary: true, condenseId: "s1" },
			{ type: "message", role: "user", content: "after", ts: 3 },
		]
		const api = makeApiHandler(makeStream("x", { totalCost: 0 }))

		const result = await summarizeConversation({ messages, apiHandler: api, systemPrompt, taskId })

		expect(result.error).toBeTruthy()
		expect(api.createMessage).not.toHaveBeenCalled()
	})
})

describe("summarizeConversation: 末尾がサマリで対象 1 件以下", () => {
	it("対象が 1 件以下でも履歴が 2 件以上なら condensed_recently（三項の : 側）", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "old", ts: 1 },
			{ type: "message", role: "user", content: "summary", ts: 2, isSummary: true, condenseId: "s1" },
		]
		const api = makeApiHandler(makeStream("x", { totalCost: 0 }))

		const result = await summarizeConversation({ messages, apiHandler: api, systemPrompt, taskId })

		expect(result.error).toBeTruthy()
		expect(api.createMessage).not.toHaveBeenCalled()
	})
})

describe("summarizeConversation: API 呼び出しの失敗を握りつぶす（catch 分岐）", () => {
	it("Error に status/code/response/body があれば errorDetails に取り込む", async () => {
		const err: any = new Error("api boom")
		err.status = 500
		err.code = "ERR_X"
		err.response = { detail: "resp" }
		err.body = { detail: "body" }
		const api = makeApiHandler(makeThrowingStream(err))
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const result = await summarizeConversation({ messages: longMessages(), apiHandler: api, systemPrompt, taskId })

		expect(result.error).toBeTruthy()
		expect(result.errorDetails).toContain("Error: api boom")
		expect(result.errorDetails).toContain("HTTP Status: 500")
		expect(result.errorDetails).toContain("Error Code: ERR_X")
		expect(result.errorDetails).toContain("API Response:")
		expect(result.errorDetails).toContain("Response Body:")
		errSpy.mockRestore()
	})

	it("response/body がシリアライズ不能なら [Unable to serialize] を残す", async () => {
		const circular: any = {}
		circular.self = circular
		const err: any = new Error("boom2")
		err.response = circular
		err.body = circular
		const api = makeApiHandler(makeThrowingStream(err))
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const result = await summarizeConversation({ messages: longMessages(), apiHandler: api, systemPrompt, taskId })

		expect(result.errorDetails).toContain("API Response: [Unable to serialize]")
		expect(result.errorDetails).toContain("Response Body: [Unable to serialize]")
		errSpy.mockRestore()
	})

	it("Error でない値が投げられても String 化して返す（else 側）", async () => {
		// 文字列を reject（instanceof Error にならない）
		const api = makeApiHandler(makeThrowingStream("plain string failure"))
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const result = await summarizeConversation({ messages: longMessages(), apiHandler: api, systemPrompt, taskId })

		expect(result.error).toBeTruthy()
		expect(result.errorDetails).toBe("plain string failure")
		errSpy.mockRestore()
	})
})

describe("summarizeConversation: usage の totalCost 既定", () => {
	it("usage に totalCost が無ければ cost は 0（?? 0 の既定側）", async () => {
		const api = makeApiHandler(makeStream("A concise summary")) // usage に totalCost 無し
		const result = await summarizeConversation({ messages: longMessages(), apiHandler: api, systemPrompt, taskId })
		expect(result.error).toBeUndefined()
		expect(result.cost).toBe(0)
	})
})

describe("summarizeConversation: folded file context の失敗は非致命", () => {
	it("generateFoldedFileContext が投げても要約は成立する（catch 分岐）", async () => {
		mockedGenerateFolded.mockRejectedValue(new Error("tree-sitter down"))
		const api = makeApiHandler(makeStream("Summary body", { totalCost: 0.01 }))
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const result = await summarizeConversation({
			messages: longMessages(),
			apiHandler: api,
			systemPrompt,
			taskId,
			filesReadByAgent: ["a.ts"],
			cwd: "/proj",
		})

		expect(result.error).toBeUndefined()
		expect(result.summary).toBe("Summary body")
		expect(errSpy).toHaveBeenCalledWith(
			expect.stringContaining("[summarizeConversation] Failed to generate folded file context:"),
			expect.any(Error),
		)
		errSpy.mockRestore()
	})
})

describe("summarizeConversation: folded sections を要約へ連結", () => {
	it("非空セクションは push し、空白のみのセクションは飛ばす（section.trim の両側）", async () => {
		mockedGenerateFolded.mockResolvedValue({
			content: "<system-reminder>real</system-reminder>",
			sections: ["<system-reminder>real</system-reminder>", "   \n  "],
			filesProcessed: 1,
			filesSkipped: 0,
			characterCount: 10,
		})
		const api = makeApiHandler(makeStream("Body", { totalCost: 0 }))

		const result = await summarizeConversation({
			messages: longMessages(),
			apiHandler: api,
			systemPrompt,
			taskId,
			filesReadByAgent: ["a.ts"],
			cwd: "/proj",
		})

		const summaryMsg = result.messages.find((m) => m.isSummary)!
		const content = (summaryMsg as any).content as string
		expect(content).toContain("<system-reminder>real</system-reminder>")
		// 空白のみのセクションは連結されない（余分な "\n\n   \n  " が入らない）
		expect(content.split("<system-reminder>real</system-reminder>")).toHaveLength(2)
	})
})

describe("summarizeConversation: 末尾メッセージに ts が無い", () => {
	it("末尾の ts が無ければ Date.now() を基準にする（?? Date.now() の既定側）", async () => {
		const before = Date.now()
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1 },
			{ type: "message", role: "assistant", content: "Hi", ts: 2 },
			{ type: "message", role: "user", content: "More", ts: 3 },
			{ type: "message", role: "assistant", content: "Ok", ts: 4 },
			{ type: "message", role: "user", content: "Last with no ts" }, // ts 無し
		]
		const api = makeApiHandler(makeStream("Body", { totalCost: 0 }))

		const result = await summarizeConversation({ messages, apiHandler: api, systemPrompt, taskId })

		const summaryMsg = result.messages.find((m) => m.isSummary)!
		// Date.now()+1 相当（過去の ts=4 ではなく現在時刻ベース）
		expect(summaryMsg.ts!).toBeGreaterThan(before)
	})
})

describe("summarizeConversation: 自動トリガ時の environmentDetails 注入", () => {
	it("isAutomaticTrigger かつ environmentDetails があれば要約へ含める", async () => {
		const api = makeApiHandler(makeStream("Body", { totalCost: 0 }))
		const result = await summarizeConversation({
			messages: longMessages(),
			apiHandler: api,
			systemPrompt,
			taskId,
			isAutomaticTrigger: true,
			environmentDetails: "<environment_details>ENV-XYZ</environment_details>",
		})
		const summaryMsg = result.messages.find((m) => m.isSummary)!
		expect((summaryMsg as any).content as string).toContain("ENV-XYZ")
	})
})

describe("summarizeConversation: tool 定義トークンの加算", () => {
	it("metadata.tools があれば tool テキストを countTokens し newContextTokens に加算する", async () => {
		const api = makeApiHandler(makeStream("Body", { totalCost: 0 }))
		// countTokens: 1 回目(本文)=100, 2 回目(tools)=25
		;(api.countTokens as any).mockResolvedValueOnce(100).mockResolvedValueOnce(25)

		const result = await summarizeConversation({
			messages: longMessages(),
			apiHandler: api,
			systemPrompt,
			taskId,
			metadata: { tools: [{ type: "function", name: "read_file" }] } as any,
		})

		expect(result.newContextTokens).toBe(125)
		// tools を JSON 化した文字列で countTokens が呼ばれる
		const calls = (api.countTokens as any).mock.calls
		const toolCall = calls.find((c: any[]) => JSON.stringify(c[0]).includes("read_file"))
		expect(toolCall).toBeDefined()
	})
})

describe("summarizeConversation: 既に condenseParent を持つメッセージは維持（ネスト condense）", () => {
	it("既存 condenseParent は上書きしない（map の return msg 側）", async () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "Hello", ts: 1, condenseParent: "old-parent" },
			{ type: "message", role: "assistant", content: "Hi", ts: 2 },
			{ type: "message", role: "user", content: "More", ts: 3 },
			{ type: "message", role: "assistant", content: "Ok", ts: 4 },
			{ type: "message", role: "user", content: "Even more", ts: 5 },
		]
		const api = makeApiHandler(makeStream("Body", { totalCost: 0 }))

		const result = await summarizeConversation({ messages, apiHandler: api, systemPrompt, taskId })

		const first = result.messages.find((m) => m.ts === 1)!
		// 既存の親を維持（新しい condenseId で上書きされない）
		expect(first.condenseParent).toBe("old-parent")
		// 新規タグは付いていないメッセージ(ts=2)は新しい condenseId を持つ
		const summary = result.messages.find((m) => m.isSummary)!
		const second = result.messages.find((m) => m.ts === 2)!
		expect(second.condenseParent).toBe(summary.condenseId)
	})
})

describe("getEffectiveApiHistory: サマリ無し・truncation あり", () => {
	it("サマリが無くても truncation マーカーを集め、truncationParent を隠す", () => {
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "assistant",
				content: "[truncated]",
				isTruncationMarker: true,
				truncationId: "T1",
				ts: 1,
			},
			{
				type: "message",
				role: "user",
				content: "hidden",
				truncationParent: "T1", // 存在するマーカー → 隠される
				condenseParent: "C-orphan", // orphan（サマリ無し）→ 隠さない
				ts: 2,
			},
			{ type: "message", role: "user", content: "visible", ts: 3 },
		]

		const result = getEffectiveApiHistory(messages)
		const contents = result.map((m) => (m as any).content)
		// truncationParent を持つ隠しメッセージは落ちる
		expect(contents).not.toContain("hidden")
		// マーカーと通常メッセージは残る
		expect(contents).toContain("[truncated]")
		expect(contents).toContain("visible")
	})
})

describe("cleanupAfterTruncation: 片方が有効・片方が orphan の混在", () => {
	it("orphan の truncationParent を消しつつ、生きている condenseParent は保持する", () => {
		const messages: ApiMessage[] = [
			{ type: "message", role: "user", content: "summary", isSummary: true, condenseId: "C1", ts: 1 },
			{
				type: "message",
				role: "user",
				content: "tagged",
				condenseParent: "C1", // 生きている（サマリ C1 は残存）
				truncationParent: "T-gone", // orphan（マーカー無し）
				ts: 2,
			},
		]

		const result = cleanupAfterTruncation(messages)
		const tagged = result.find((m) => m.ts === 2)!
		expect(tagged.condenseParent).toBe("C1") // 保持
		expect(tagged.truncationParent).toBeUndefined() // 除去
	})

	it("orphan の condenseParent を消しつつ、生きている truncationParent は保持する", () => {
		const messages: ApiMessage[] = [
			{
				type: "message",
				role: "assistant",
				content: "marker",
				isTruncationMarker: true,
				truncationId: "T1",
				ts: 1,
			},
			{
				type: "message",
				role: "user",
				content: "tagged",
				condenseParent: "C-gone", // orphan
				truncationParent: "T1", // 生きている
				ts: 2,
			},
		]

		const result = cleanupAfterTruncation(messages)
		const tagged = result.find((m) => m.ts === 2)!
		expect(tagged.truncationParent).toBe("T1") // 保持
		expect(tagged.condenseParent).toBeUndefined() // 除去
	})
})
