// npx vitest run packages/core/src/message-utils/__tests__/consolidateApiRequests.spec.ts

import type { ClineMessage } from "@openai-agent/types"

import { consolidateApiRequests } from "../consolidateApiRequests.js"

describe("consolidateApiRequests", () => {
	// Helper function to create a basic api_req_started message
	const createApiReqStarted = (ts: number, data: Record<string, unknown> = {}): ClineMessage => ({
		ts,
		type: "say",
		say: "api_req_started",
		text: JSON.stringify(data),
	})

	// Helper function to create a basic api_req_finished message
	const createApiReqFinished = (ts: number, data: Record<string, unknown> = {}): ClineMessage => ({
		ts,
		type: "say",
		say: "api_req_finished",
		text: JSON.stringify(data),
	})

	// Helper function to create a regular text message
	const createTextMessage = (ts: number, text: string): ClineMessage => ({
		ts,
		type: "say",
		say: "text",
		text,
	})

	it("should consolidate a matching pair of api_req_started and api_req_finished messages", () => {
		const messages: ClineMessage[] = [
			createApiReqStarted(1000, { request: "GET /api/data" }),
			createApiReqFinished(1001, { cost: 0.005 }),
		]

		const result = consolidateApiRequests(messages)

		expect(result.length).toBe(1)
		expect(result[0]!.say).toBe("api_req_started")

		const parsedText = JSON.parse(result[0]!.text || "{}")
		expect(parsedText.request).toBe("GET /api/data")
		expect(parsedText.cost).toBe(0.005)
	})

	it("should handle messages with no api_req pairs", () => {
		const messages: ClineMessage[] = [createTextMessage(1000, "Hello"), createTextMessage(1001, "World")]

		const result = consolidateApiRequests(messages)

		expect(result).toEqual(messages)
	})

	it("should handle empty messages array", () => {
		const result = consolidateApiRequests([])
		expect(result).toEqual([])
	})

	it("should handle single message array", () => {
		const messages: ClineMessage[] = [createTextMessage(1000, "Hello")]
		const result = consolidateApiRequests(messages)
		expect(result).toEqual(messages)
	})

	it("should preserve non-api messages in the result", () => {
		const messages: ClineMessage[] = [
			createTextMessage(1000, "Before"),
			createApiReqStarted(1001, { request: "test" }),
			createApiReqFinished(1002, { cost: 0.01 }),
			createTextMessage(1003, "After"),
		]

		const result = consolidateApiRequests(messages)

		expect(result.length).toBe(3)
		expect(result[0]!.text).toBe("Before")
		expect(result[1]!.say).toBe("api_req_started")
		expect(result[2]!.text).toBe("After")
	})

	it("should handle multiple api_req pairs", () => {
		const messages: ClineMessage[] = [
			createApiReqStarted(1000, { request: "first" }),
			createApiReqFinished(1001, { cost: 0.01 }),
			createApiReqStarted(1002, { request: "second" }),
			createApiReqFinished(1003, { cost: 0.02 }),
		]

		const result = consolidateApiRequests(messages)

		expect(result.length).toBe(2)
		expect(JSON.parse(result[0]!.text || "{}").request).toBe("first")
		expect(JSON.parse(result[1]!.text || "{}").request).toBe("second")
	})

	it("should handle orphan api_req_started without finish", () => {
		const messages: ClineMessage[] = [
			createApiReqStarted(1000, { request: "orphan" }),
			createTextMessage(1001, "Text"),
		]

		const result = consolidateApiRequests(messages)

		expect(result.length).toBe(2)
		expect(result[0]!.say).toBe("api_req_started")
		expect(JSON.parse(result[0]!.text || "{}").request).toBe("orphan")
	})

	it("should handle invalid JSON in message text", () => {
		const messages: ClineMessage[] = [
			{ ts: 1000, type: "say", say: "api_req_started", text: "invalid json" },
			createApiReqFinished(1001, { cost: 0.01 }),
		]

		const result = consolidateApiRequests(messages)

		// Should still consolidate, merging what it can
		expect(result.length).toBe(1)
	})

	it("先行する started が無い api_req_finished は結果から落ちる", () => {
		// startedIndices が空 → startIndex は undefined 分岐を通り、マージ処理へ入らない
		const messages: ClineMessage[] = [createApiReqFinished(1000, { cost: 0.01 }), createTextMessage(1001, "after")]

		const result = consolidateApiRequests(messages)

		// finished は消え、text だけ残る
		expect(result.length).toBe(1)
		expect(result[0]!.text).toBe("after")
	})

	it("api_req_finished 側の JSON が不正でも start 側の内容は保たれる", () => {
		// finish 側 JSON.parse が投げても catch で握り、finishData は空のまま
		const messages: ClineMessage[] = [
			createApiReqStarted(1000, { request: "keep-me" }),
			{ ts: 1001, type: "say", say: "api_req_finished", text: "broken json" },
		]

		const result = consolidateApiRequests(messages)

		expect(result.length).toBe(1)
		expect(JSON.parse(result[0]!.text || "{}").request).toBe("keep-me")
	})

	it("api_req_finished の text が空なら parse を試みずマージする", () => {
		// message.text が falsy → `if (message.text)` の false 分岐（parse スキップ）
		const messages: ClineMessage[] = [
			createApiReqStarted(1000, { request: "req" }),
			{ ts: 1001, type: "say", say: "api_req_finished", text: "" },
		]

		const result = consolidateApiRequests(messages)

		expect(result.length).toBe(1)
		expect(JSON.parse(result[0]!.text || "{}").request).toBe("req")
	})
})
