// npx vitest run src/components/chat/__tests__/chatMessageVisibility.spec.ts

import type { ClineMessage } from "@openai-agent/types"

import {
	messagesToRemember,
	selectVisibleMessages,
	VIEWPORT_MEMORY_SIZE,
	type MessageVisibilityContext,
} from "../chatMessageVisibility"

let nextTs = 1

const say = (kind: string, extra: Partial<ClineMessage> = {}): ClineMessage =>
	({ type: "say", say: kind, ts: nextTs++, ...extra }) as ClineMessage

const ask = (kind: string, extra: Partial<ClineMessage> = {}): ClineMessage =>
	({ type: "ask", ask: kind, ts: nextTs++, ...extra }) as ClineMessage

/** 何も見たことがない状態。 */
const fresh: MessageVisibilityContext = { hasBeenSeen: () => false }
/** すべて表示済みの状態。 */
const allSeen: MessageVisibilityContext = { hasBeenSeen: () => true }

const visibleKinds = (messages: ClineMessage[], ctx: MessageVisibilityContext = fresh) =>
	selectVisibleMessages(messages, ctx).map((m) => m.say ?? m.ask)

beforeEach(() => {
	nextTs = 1
})

describe("selectVisibleMessages — first sighting", () => {
	it("keeps ordinary messages", () => {
		const messages = [say("text", { text: "hi" }), say("completion_result", { text: "done" })]

		expect(selectVisibleMessages(messages, fresh)).toEqual(messages)
	})

	it("does not cap the number of messages", () => {
		// 上限を設けると Virtuoso の添字がずれるので、あえて全部返す。
		const messages = Array.from({ length: 600 }, (_, i) => say("text", { text: `m${i}` }))

		expect(selectVisibleMessages(messages, fresh)).toHaveLength(600)
	})

	it.each(["api_req_finished", "api_req_retried", "api_req_deleted", "mcp_server_request_started"])(
		"never shows say:%s",
		(kind) => {
			expect(visibleKinds([say(kind)])).toEqual([])
		},
	)

	it.each(["api_req_failed", "resume_task", "resume_completed_task"])(
		"never shows ask:%s as a row, since it is surfaced as buttons",
		(kind) => {
			expect(visibleKinds([ask(kind)])).toEqual([])
		},
	)

	it("hides a completion_result that has no text yet", () => {
		expect(visibleKinds([ask("completion_result", { text: "" })])).toEqual([])
	})

	it("shows a completion_result once it has text", () => {
		expect(visibleKinds([ask("completion_result", { text: "done" })])).toEqual(["completion_result"])
	})

	it("hides a text message with neither text nor images", () => {
		expect(visibleKinds([say("text", { text: "" })])).toEqual([])
		expect(visibleKinds([say("text")])).toEqual([])
	})

	it("shows a text message that only carries images", () => {
		expect(visibleKinds([say("text", { text: "", images: ["data:image/png;base64,x"] })])).toEqual(["text"])
	})
})

describe("selectVisibleMessages — waiting notices", () => {
	it.each(["api_req_retry_delayed", "api_req_rate_limit_wait"])("shows %s while it is the newest message", (kind) => {
		expect(visibleKinds([say("text", { text: "a" }), say(kind)])).toEqual(["text", kind])
	})

	it.each(["api_req_retry_delayed", "api_req_rate_limit_wait"])("hides %s once something newer arrives", (kind) => {
		expect(visibleKinds([say(kind), say("text", { text: "a" })])).toEqual(["text"])
	})

	it.each(["api_req_retry_delayed", "api_req_rate_limit_wait"])(
		"keeps %s when a resume_task lands right after it, so the reason stays visible",
		(kind) => {
			// resume_task 自体は行として出ないが、その直前の待機理由は残す。
			expect(visibleKinds([say(kind), ask("resume_task")])).toEqual([kind])
		},
	)

	it("hides the waiting notice when resume_task is not directly after it", () => {
		expect(visibleKinds([say("api_req_rate_limit_wait"), say("text", { text: "a" }), ask("resume_task")])).toEqual([
			"text",
		])
	})

	it("compares by identity, so an equal-looking earlier notice is still hidden", () => {
		const older = say("api_req_rate_limit_wait")
		const newer = { ...older, ts: 99 } as ClineMessage

		expect(selectVisibleMessages([older, newer], fresh)).toEqual([newer])
	})
})

describe("selectVisibleMessages — checkpoint suppression", () => {
	it("hides a checkpoint flagged with suppressMessage", () => {
		expect(visibleKinds([say("checkpoint_saved", { checkpoint: { suppressMessage: true } as any })])).toEqual([])
	})

	it("shows a checkpoint without the flag", () => {
		expect(visibleKinds([say("checkpoint_saved", { checkpoint: { hash: "abc" } as any })])).toEqual([
			"checkpoint_saved",
		])
	})

	it("hides a checkpoint whose hash belongs to a user message", () => {
		const messages = [
			say("user_feedback", { checkpoint: { type: "user_message", hash: "abc" } as any }),
			say("checkpoint_saved", { text: "abc" }),
		]

		expect(visibleKinds(messages)).toEqual(["user_feedback"])
	})

	it("keeps a checkpoint whose hash belongs to no user message", () => {
		const messages = [
			say("user_feedback", { checkpoint: { type: "user_message", hash: "abc" } as any }),
			say("checkpoint_saved", { text: "different" }),
		]

		expect(visibleKinds(messages)).toEqual(["user_feedback", "checkpoint_saved"])
	})

	it("only matches user_message checkpoints, not other checkpoint types", () => {
		const messages = [
			say("user_feedback", { checkpoint: { type: "tool", hash: "abc" } as any }),
			say("checkpoint_saved", { text: "abc" }),
		]

		expect(visibleKinds(messages)).toEqual(["user_feedback", "checkpoint_saved"])
	})

	it("suppresses a checkpoint even when it has already been seen", () => {
		expect(
			visibleKinds([say("checkpoint_saved", { checkpoint: { suppressMessage: true } as any })], allSeen),
		).toEqual([])
	})
})

describe("selectVisibleMessages — messages already shown once", () => {
	it.each(["api_req_failed", "resume_task", "resume_completed_task"])(
		"still hides ask:%s after it has been processed",
		(kind) => {
			expect(visibleKinds([ask(kind)], allSeen)).toEqual([])
		},
	)

	it.each(["api_req_finished", "api_req_retried", "api_req_deleted", "mcp_server_request_started"])(
		"still hides say:%s after it has been processed",
		(kind) => {
			expect(visibleKinds([say(kind)], allSeen)).toEqual([])
		},
	)

	it("hides a text message that has become empty", () => {
		expect(visibleKinds([say("text", { text: "" })], allSeen)).toEqual([])
	})

	it("keeps a waiting notice that is no longer newest, once it has been seen", () => {
		// 初回なら「最後じゃない」ので隠れるが、一度出したものは消さない。
		const notice = say("api_req_rate_limit_wait")
		const messages = [notice, say("text", { text: "a" })]

		expect(visibleKinds(messages, fresh)).toEqual(["text"])
		expect(visibleKinds(messages, allSeen)).toEqual(["api_req_rate_limit_wait", "text"])
	})

	it("keeps an empty completion_result that was already shown", () => {
		// 初回は隠すが、既に出したものを後から消すとレイアウトが飛ぶ。
		const messages = [ask("completion_result", { text: "" })]

		expect(visibleKinds(messages, fresh)).toEqual([])
		expect(visibleKinds(messages, allSeen)).toEqual(["completion_result"])
	})

	it("consults the predicate per message, not globally", () => {
		const shown = say("api_req_rate_limit_wait")
		const later = say("text", { text: "a" })
		const seen: MessageVisibilityContext = { hasBeenSeen: (ts) => ts === shown.ts }

		expect(visibleKinds([shown, later], seen)).toEqual(["api_req_rate_limit_wait", "text"])
	})
})

describe("messagesToRemember", () => {
	it("remembers everything when the list is short", () => {
		const messages = [say("text", { text: "a" }), say("text", { text: "b" })]

		expect(messagesToRemember(messages)).toEqual(messages)
	})

	it("remembers only the most recent window", () => {
		const messages = Array.from({ length: VIEWPORT_MEMORY_SIZE + 25 }, () => say("text", { text: "x" }))
		const remembered = messagesToRemember(messages)

		expect(remembered).toHaveLength(VIEWPORT_MEMORY_SIZE)
		expect(remembered.at(-1)).toBe(messages.at(-1))
		expect(remembered[0]).toBe(messages[25])
	})

	it("handles an empty list", () => {
		expect(messagesToRemember([])).toEqual([])
	})
})
