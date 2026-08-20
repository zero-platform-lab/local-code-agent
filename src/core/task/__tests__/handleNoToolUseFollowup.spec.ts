import { describe, it, expect, vi } from "vitest"

import { handleAssistantToolUseFollowup } from "../handleNoToolUseFollowup"

function makeHost(
	opts: {
		content?: Array<{ type: string }>
		noToolUse?: number
		count?: number
	} = {},
) {
	const say = vi.fn((..._a: unknown[]) => Promise.resolve())
	const host = {
		stream: {
			assistantMessageContent: (opts.content ?? []) as never,
			userMessageContent: [] as Array<{ type: string; text?: string }>,
		},
		graceRetry: { noToolUse: opts.noToolUse ?? 0 },
		mistakeTracker: { count: opts.count ?? 0 },
		say,
	}
	return { host, say }
}

describe("handleAssistantToolUseFollowup", () => {
	it("tool_use を1つでも使っていたら counter を 0 にリセットして即 return（push も say もしない）", async () => {
		const { host, say } = makeHost({ content: [{ type: "tool_use" }], noToolUse: 5, count: 2 })

		await handleAssistantToolUseFollowup(host as never)

		expect(host.graceRetry.noToolUse).toBe(0)
		expect(host.mistakeTracker.count).toBe(2)
		expect(host.stream.userMessageContent).toHaveLength(0)
		expect(say).not.toHaveBeenCalled()
	})

	it("mcp_tool_use のみでも「ツールを使った」と判定して counter を 0 にリセットする", async () => {
		const { host, say } = makeHost({ content: [{ type: "text" }, { type: "mcp_tool_use" }], noToolUse: 3 })

		await handleAssistantToolUseFollowup(host as never)

		expect(host.graceRetry.noToolUse).toBe(0)
		expect(host.stream.userMessageContent).toHaveLength(0)
		expect(say).not.toHaveBeenCalled()
	})

	it("初回のツール未使用は grace retry：counter を 1 に上げるだけでエラー/mistake は出さない", async () => {
		const { host, say } = makeHost({ content: [{ type: "text" }], noToolUse: 0, count: 3 })

		await handleAssistantToolUseFollowup(host as never)

		expect(host.graceRetry.noToolUse).toBe(1)
		expect(host.mistakeTracker.count).toBe(3)
		expect(say).not.toHaveBeenCalled()
		// grace retry でも「ツールを使ってください」プロンプトは常に積む
		expect(host.stream.userMessageContent).toHaveLength(1)
		expect(host.stream.userMessageContent[0]).toMatchObject({ type: "text" })
		expect(host.stream.userMessageContent[0].text).toContain("[ERROR] You did not use a tool")
	})

	it("2連続でツール未使用なら MODEL_NO_TOOLS_USED を出し mistake count を++する", async () => {
		const { host, say } = makeHost({ content: [{ type: "text" }], noToolUse: 1, count: 3 })

		await handleAssistantToolUseFollowup(host as never)

		expect(host.graceRetry.noToolUse).toBe(2)
		expect(say).toHaveBeenCalledWith("error", "MODEL_NO_TOOLS_USED")
		expect(host.mistakeTracker.count).toBe(4)
		expect(host.stream.userMessageContent).toHaveLength(1)
		expect(host.stream.userMessageContent[0].text).toContain("[ERROR] You did not use a tool")
	})
})
