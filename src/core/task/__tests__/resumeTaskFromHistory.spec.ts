import { describe, it, expect, vi } from "vitest"

import { resumeTaskFromHistory } from "../resumeTaskFromHistory"

function makeHost(
	opts: {
		clineMessages?: unknown[]
		apiHistory?: unknown[]
		askResponse?: string
		askText?: string
		askImages?: string[]
		abort?: boolean
		abandoned?: boolean
		abortReason?: string
	} = {},
) {
	return {
		messageStore: { clineMessages: [], apiConversationHistory: [] },
		isInitialized: false,
		abort: opts.abort ?? false,
		abandoned: opts.abandoned ?? false,
		abortReason: opts.abortReason,
		getSavedClineMessages: vi.fn(async () => opts.clineMessages ?? [{ type: "say", say: "text" }]),
		getSavedApiConversationHistory: vi.fn(async () => opts.apiHistory ?? []),
		overwriteClineMessages: vi.fn(async () => {}),
		overwriteApiConversationHistory: vi.fn(async () => {}),
		ask: vi.fn(async () => ({
			response: opts.askResponse ?? "yesButtonClicked",
			text: opts.askText,
			images: opts.askImages,
		})),
		say: vi.fn(async () => {}),
		initiateTaskLoop: vi.fn(async () => {}),
	}
}

const nextContent = (host: ReturnType<typeof makeHost>) => (host.initiateTaskLoop.mock.calls as unknown[][])[0][0]

describe("resumeTaskFromHistory", () => {
	it("応答の無い function_call があれば interrupted の tool_result を補完する", async () => {
		const host = makeHost({
			apiHistory: [{ type: "function_call", call_id: "t1", name: "read_file", arguments: "{}" }],
		})

		await resumeTaskFromHistory({ host } as never)

		expect(nextContent(host)).toEqual([
			{
				type: "tool_result",
				tool_use_id: "t1",
				content: "Task was interrupted before this tool call could be completed.",
			},
		])
	})

	it("応答の無い function_call だけを補完し、履歴はそのまま残す", async () => {
		// 旧実装は「末尾が user なら取り除いて中身を再送」していたが、item 列では
		// 未応答の呼び出しを埋めれば足り、既存の user item を剥がして送り直す必要が無い。
		// 剥がさない方が重複が起きない。
		const host = makeHost({
			apiHistory: [
				{ type: "function_call", call_id: "t1", name: "read_file", arguments: "{}" },
				{ type: "message", role: "user", content: "hi" },
			],
		})

		await resumeTaskFromHistory({ host } as never)

		expect(nextContent(host)).toEqual([
			{
				type: "tool_result",
				tool_use_id: "t1",
				content: "Task was interrupted before this tool call could be completed.",
			},
		])
		expect(host.overwriteApiConversationHistory).toHaveBeenLastCalledWith([
			{ type: "function_call", call_id: "t1", name: "read_file", arguments: "{}" },
			{ type: "message", role: "user", content: "hi" },
		])
	})

	it("応答済みの function_call は補完しない（末尾 user ターンを送り直す）", async () => {
		const host = makeHost({
			apiHistory: [
				{ type: "function_call", call_id: "t1", name: "read_file", arguments: "{}" },
				{ type: "function_call_output", call_id: "t1", output: "done" },
				{ type: "message", role: "user", content: "hi" },
			],
		})

		await resumeTaskFromHistory({ host } as never)

		// 末尾の user ターン（output + 本文）が外れて、テキストとして送り直される
		expect(nextContent(host)).toEqual([
			{ type: "text", text: "done" },
			{ type: "text", text: "hi" },
		])
		expect(host.overwriteApiConversationHistory).toHaveBeenLastCalledWith([
			{ type: "function_call", call_id: "t1", name: "read_file", arguments: "{}" },
		])
	})

	it("末尾が condensation summary ならそのまま保持し、再開文言を足す", async () => {
		const host = makeHost({
			apiHistory: [{ role: "assistant", content: "summary", isSummary: true }],
		})

		await resumeTaskFromHistory({ host } as never)

		expect(nextContent(host)).toEqual([{ type: "text", text: "[TASK RESUMPTION] Resuming task..." }])
	})

	it("messageResponse なら user_feedback を say し、<user_message> を足す", async () => {
		const host = makeHost({
			apiHistory: [{ role: "assistant", content: [{ type: "text", text: "a" }] }],
			askResponse: "messageResponse",
			askText: "please continue",
		})

		await resumeTaskFromHistory({ host } as never)

		expect(host.say).toHaveBeenCalledWith("user_feedback", "please continue", undefined)
		expect(nextContent(host)).toEqual([{ type: "text", text: "<user_message>\nplease continue\n</user_message>" }])
	})

	it("完了済みタスクは resume_completed_task を ask する", async () => {
		const host = makeHost({
			clineMessages: [{ type: "ask", ask: "completion_result" }],
			apiHistory: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		})

		await resumeTaskFromHistory({ host } as never)

		expect(host.ask).toHaveBeenCalledWith("resume_completed_task")
	})

	it("末尾の resume_task と reasoning-only メッセージを掃除してから overwrite する", async () => {
		const host = makeHost({
			clineMessages: [
				{ type: "say", say: "text" },
				{ type: "say", say: "reasoning" },
				{ type: "ask", ask: "resume_task" },
			],
			apiHistory: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		})

		await resumeTaskFromHistory({ host } as never)

		expect(host.overwriteClineMessages).toHaveBeenCalledWith([{ type: "say", say: "text" }])
	})

	it("末尾 api_req_started の text が壊れた JSON でも throw せず、除去せず残す", async () => {
		const host = makeHost({
			clineMessages: [{ type: "say", say: "api_req_started", text: "{corrupt json" }],
			apiHistory: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		})

		await expect(resumeTaskFromHistory({ host } as never)).resolves.toBeUndefined()
		// 除去判定に使えないため message は残す（正常な "{}" なら cost/cancelReason 未定義で除去される）
		expect(host.overwriteClineMessages).toHaveBeenCalledWith([
			{ type: "say", say: "api_req_started", text: "{corrupt json" },
		])
	})

	it("末尾 api_req_started が cost/cancelReason 未定義（text 空）なら除去する", async () => {
		// text が falsy → `text || "{}"` の既定側 → info={} → cost/cancelReason 未定義で splice。
		const host = makeHost({
			clineMessages: [
				{ type: "say", say: "text" },
				{ type: "say", say: "api_req_started", text: "" },
			],
			apiHistory: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		})

		await resumeTaskFromHistory({ host } as never)

		// api_req_started は除去され、残るのは最初の say のみ
		expect(host.overwriteClineMessages).toHaveBeenCalledWith([{ type: "say", say: "text" }])
	})

	it("cost が入った api_req_started は除去しない", async () => {
		const started = { type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.5 }) }
		const host = makeHost({
			clineMessages: [started],
			apiHistory: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		})

		await resumeTaskFromHistory({ host } as never)

		expect(host.overwriteClineMessages).toHaveBeenCalledWith([started])
	})

	it("cancelReason が入った api_req_started は除去しない", async () => {
		const started = {
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ cancelReason: "user_cancelled" }),
		}
		const host = makeHost({
			clineMessages: [started],
			apiHistory: [{ role: "user", content: [{ type: "text", text: "x" }] }],
		})

		await resumeTaskFromHistory({ host } as never)

		expect(host.overwriteClineMessages).toHaveBeenCalledWith([started])
	})

	it("messageResponse で画像が付いていれば imageBlocks を newUserContent に足す", async () => {
		const host = makeHost({
			apiHistory: [{ role: "assistant", content: [{ type: "text", text: "a" }] }],
			askResponse: "messageResponse",
			askText: "見て",
			askImages: ["data:image/png;base64,AAA"],
		})

		await resumeTaskFromHistory({ host } as never)

		expect(nextContent(host)).toEqual([
			{ type: "text", text: "<user_message>\n見て\n</user_message>" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
		])
	})

	it("API 履歴が空なら throw する（通常時）", async () => {
		const host = makeHost({ apiHistory: [] })

		await expect(resumeTaskFromHistory({ host } as never)).rejects.toThrow("No existing API conversation history")
	})

	it("abort 済みなら内部エラーを飲み込んで静かに返す", async () => {
		const host = makeHost({ apiHistory: [], abort: true })

		await expect(resumeTaskFromHistory({ host } as never)).resolves.toBeUndefined()
		expect(host.initiateTaskLoop).not.toHaveBeenCalled()
	})
})
