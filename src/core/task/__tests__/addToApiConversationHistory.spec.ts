import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../condense", () => ({ getEffectiveApiHistory: vi.fn() }))
vi.mock("../validateToolResultIds", () => ({ validateAndFixToolResultIds: vi.fn() }))

import { addToApiConversationHistory } from "../addToApiConversationHistory"
import { getEffectiveApiHistory } from "../../condense"
import { validateAndFixToolResultIds } from "../validateToolResultIds"

const mockedEffective = vi.mocked(getEffectiveApiHistory)
const mockedValidate = vi.mocked(validateAndFixToolResultIds)

type Api = Record<string, (...a: unknown[]) => unknown>

function makeDeps(api: Api = {}) {
	const apiConversationHistory: any[] = []
	const save = vi.fn((..._a: unknown[]) => Promise.resolve())
	const host = {
		api,
		messageStore: { apiConversationHistory },
		saveApiConversationHistory: save,
	}
	return { deps: { host }, host, save, apiConversationHistory }
}

function lastPushed(apiConversationHistory: any[]) {
	return apiConversationHistory[apiConversationHistory.length - 1]
}

beforeEach(() => {
	vi.clearAllMocks()
	mockedEffective.mockReturnValue([])
	mockedValidate.mockImplementation((msg) => msg)
})

// 履歴は AgentMessage（Responses item 列）になったので、1 回の追記が複数 item に割れる。
// 平文 reasoning は Responses の item にできないため本文の先頭にテキストとして畳まれ、
// 暗号化 reasoning だけが独立した reasoning item として本文より前に積まれる。
describe("addToApiConversationHistory - assistant メッセージ", () => {
	it("平文 reasoning + 文字列 content: reasoning を本文の先頭に畳んだ message item 1 件になる", async () => {
		const { deps, apiConversationHistory, save } = makeDeps()

		await addToApiConversationHistory(
			deps as never,
			{ role: "assistant", content: "hello" } as never,
			"thinking...",
		)

		expect(apiConversationHistory).toHaveLength(1)
		const pushed = lastPushed(apiConversationHistory)
		expect(pushed.type).toBe("message")
		expect(pushed.role).toBe("assistant")
		expect(pushed.content).toBe("thinking...\nhello")
		expect(typeof pushed.ts).toBe("number")
		expect(save).toHaveBeenCalledTimes(1)
		// assistant 分岐では tool_result 検証系は一切呼ばない
		expect(mockedEffective).not.toHaveBeenCalled()
		expect(mockedValidate).not.toHaveBeenCalled()
	})

	it("平文 reasoning + 配列 content: reasoning を先頭に足し、既存ブロックの中身は温存する", async () => {
		const { deps, apiConversationHistory } = makeDeps()

		await addToApiConversationHistory(
			deps as never,
			{ role: "assistant", content: [{ type: "text", text: "a" }] } as never,
			"reasoned",
		)

		expect(apiConversationHistory).toHaveLength(1)
		const pushed = lastPushed(apiConversationHistory)
		expect(pushed.id).toBeUndefined()
		expect(pushed.content).toBe("reasoned\na")
	})

	it("平文 reasoning + content 無し: reasoning だけの message item になる", async () => {
		const { deps, apiConversationHistory } = makeDeps()

		await addToApiConversationHistory(
			deps as never,
			{ role: "assistant", content: undefined } as never,
			"solo-reason",
		)

		expect(apiConversationHistory).toHaveLength(1)
		expect(lastPushed(apiConversationHistory).content).toBe("solo-reason")
	})

	it("暗号化 reasoning + 文字列 content: encrypted_content と id を持つ reasoning item を本文より前に積む", async () => {
		const { deps, apiConversationHistory } = makeDeps({
			getEncryptedContent: () => ({ encrypted_content: "ENC", id: "eid" }),
		})

		// reasoning 平文なし → 暗号化ブランチへ
		await addToApiConversationHistory(deps as never, { role: "assistant", content: "hi" } as never)

		expect(apiConversationHistory).toHaveLength(2)
		const [reasoningItem, messageItem] = apiConversationHistory
		expect(reasoningItem).toMatchObject({
			type: "reasoning",
			summary: [],
			encrypted_content: "ENC",
			id: "eid",
		})
		expect(messageItem).toMatchObject({ type: "message", role: "assistant", content: "hi" })
		// メタ (ts) は割れた全 item に複製される
		expect(typeof reasoningItem.ts).toBe("number")
		expect(messageItem.ts).toBe(reasoningItem.ts)
	})

	it("平文 reasoning 無し + 暗号化 reasoning 有り(配列 content): id 未提供なら id キーを付けない", async () => {
		const { deps, apiConversationHistory } = makeDeps({
			getEncryptedContent: () => ({ encrypted_content: "ENC2" }),
		})

		await addToApiConversationHistory(
			deps as never,
			{
				role: "assistant",
				content: [{ type: "text", text: "a" }],
			} as never,
		)

		expect(apiConversationHistory).toHaveLength(2)
		const [reasoningItem, messageItem] = apiConversationHistory
		expect(reasoningItem.type).toBe("reasoning")
		expect(reasoningItem.encrypted_content).toBe("ENC2")
		expect("id" in reasoningItem).toBe(false)
		expect(messageItem).toMatchObject({ type: "message", role: "assistant", content: "a" })
	})

	it("暗号化 reasoning + content 無し: reasoning item だけが積まれる", async () => {
		const { deps, apiConversationHistory } = makeDeps({
			getEncryptedContent: () => ({ encrypted_content: "ENC3" }),
		})

		await addToApiConversationHistory(deps as never, { role: "assistant", content: undefined } as never)

		expect(apiConversationHistory).toHaveLength(1)
		expect(lastPushed(apiConversationHistory)).toMatchObject({
			type: "reasoning",
			summary: [],
			encrypted_content: "ENC3",
		})
	})

	it("reasoning/暗号化いずれも無し: content をそのまま保持し id も付かない", async () => {
		const { deps, apiConversationHistory, save } = makeDeps()

		await addToApiConversationHistory(deps as never, { role: "assistant", content: "plain" } as never)

		expect(apiConversationHistory).toHaveLength(1)
		const pushed = lastPushed(apiConversationHistory)
		expect(pushed.content).toBe("plain")
		expect(pushed.id).toBeUndefined()
		expect(save).toHaveBeenCalledTimes(1)
	})

	it("tool_use ブロックは独立した function_call item として本文の後に積まれる", async () => {
		const { deps, apiConversationHistory } = makeDeps()

		await addToApiConversationHistory(
			deps as never,
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling" },
					{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.txt" } },
				],
			} as never,
		)

		expect(apiConversationHistory).toHaveLength(2)
		expect(apiConversationHistory[0]).toMatchObject({ type: "message", role: "assistant", content: "calling" })
		expect(apiConversationHistory[1]).toMatchObject({
			type: "function_call",
			call_id: "call-1",
			name: "read_file",
			arguments: JSON.stringify({ path: "a.txt" }),
		})
	})
})

describe("addToApiConversationHistory - user メッセージ", () => {
	it("直前の effective が assistant: effective 履歴で検証し、変換せず原メッセージのまま validate の返値を push する", async () => {
		const { deps, apiConversationHistory } = makeDeps()
		const effective = [{ type: "message", role: "assistant", content: "prev" }]
		mockedEffective.mockReturnValue(effective as never)
		mockedValidate.mockReturnValueOnce({ role: "user", content: "SENTINEL" } as never)

		const message = { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] }
		await addToApiConversationHistory(deps as never, message as never)

		expect(mockedValidate).toHaveBeenCalledTimes(1)
		// 直前が assistant なので tool_result→text 変換は行わず、原メッセージ参照をそのまま渡す
		expect(mockedValidate.mock.calls[0][0]).toBe(message as never)
		// 検証履歴には effective 履歴全体を渡す
		expect(mockedValidate.mock.calls[0][1]).toBe(effective as never)
		const pushed = lastPushed(apiConversationHistory)
		expect(pushed.content).toBe("SENTINEL")
		expect(typeof pushed.ts).toBe("number")
	})

	it("末尾 item が function_call でも assistant ターンとみなして effective 履歴で検証する", async () => {
		const { deps } = makeDeps()
		// item 列では 1 ターンが複数 item に割れるので、末尾が function_call でも assistant ターン。
		const effective = [{ type: "function_call", call_id: "x", name: "read_file", arguments: "{}" }]
		mockedEffective.mockReturnValue(effective as never)

		const message = { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] }
		await addToApiConversationHistory(deps as never, message as never)

		expect(mockedValidate.mock.calls[0][0]).toBe(message as never)
		expect(mockedValidate.mock.calls[0][1]).toBe(effective as never)
	})

	it("直前が非 assistant + 配列 content: tool_result を text 化(文字列は素通り/非文字列は JSON 化)、他ブロックは温存、検証履歴は空", async () => {
		const { deps, apiConversationHistory } = makeDeps()
		mockedEffective.mockReturnValue([{ type: "message", role: "user", content: "prev-summary" }] as never)

		const message = {
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "a", content: "str-result" },
				{ type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "obj" }] },
				{ type: "text", text: "keep-me" },
			],
		}
		await addToApiConversationHistory(deps as never, message as never)

		const arg = mockedValidate.mock.calls[0][0] as any
		expect(arg.content[0]).toEqual({ type: "text", text: "Tool result:\nstr-result" })
		expect(arg.content[1]).toEqual({
			type: "text",
			text: `Tool result:\n${JSON.stringify([{ type: "text", text: "obj" }])}`,
		})
		expect(arg.content[2]).toEqual({ type: "text", text: "keep-me" })
		// 直前が非 assistant のため、誤補完を避けて検証履歴は空配列にする
		expect(mockedValidate.mock.calls[0][1]).toEqual([])
		// text 化したので orphan な function_call_output item は生まれない
		expect(apiConversationHistory).toHaveLength(1)
		expect(apiConversationHistory[0].type).toBe("message")
		expect(apiConversationHistory[0].content).toBe(
			`Tool result:\nstr-result\nTool result:\n${JSON.stringify([{ type: "text", text: "obj" }])}\nkeep-me`,
		)
	})

	it("履歴が空(直前無し) + 文字列 content: 配列でないため変換せず、空履歴で検証して push する", async () => {
		const { deps, apiConversationHistory } = makeDeps()
		mockedEffective.mockReturnValue([] as never)

		const message = { role: "user", content: "plain user text" }
		await addToApiConversationHistory(deps as never, message as never)

		expect(mockedValidate.mock.calls[0][0]).toBe(message as never)
		expect(mockedValidate.mock.calls[0][1]).toEqual([])
		const pushed = lastPushed(apiConversationHistory)
		expect(pushed.content).toBe("plain user text")
		expect(typeof pushed.ts).toBe("number")
	})

	it("直前が assistant のときの tool_result は function_call_output item として積まれる", async () => {
		const { deps, apiConversationHistory } = makeDeps()
		mockedEffective.mockReturnValue([{ type: "message", role: "assistant", content: "prev" }] as never)

		await addToApiConversationHistory(
			deps as never,
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call-1", content: "done" },
					{ type: "text", text: "next" },
				],
			} as never,
		)

		expect(apiConversationHistory).toHaveLength(2)
		expect(apiConversationHistory[0]).toMatchObject({
			type: "function_call_output",
			call_id: "call-1",
			output: "done",
		})
		expect(apiConversationHistory[1]).toMatchObject({ type: "message", role: "user", content: "next" })
	})
})
