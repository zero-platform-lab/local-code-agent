import { describe, expect, it } from "vitest"

import { isTerminalClientError, MAX_API_RETRY_ATTEMPTS } from "../apiRetryPolicy"

describe("isTerminalClientError", () => {
	it("非リトライの 4xx は終端（code / error.status に乗った 400、409・425 も）", () => {
		const terminal: unknown[] = [
			{ status: 400 },
			{ status: 401 },
			{ status: 403 },
			{ status: 404 },
			{ status: 409 },
			{ status: 422 },
			{ status: 425 },
			{ code: 400 },
			{ error: { status: 400 } },
			{ code: 20, response: { status: 400 } },
		]
		for (const e of terminal) {
			expect(isTerminalClientError(e)).toBe(true)
		}
	})

	it("一時的な 4xx（408 / 429）は終端にしない", () => {
		for (const status of [408, 429]) {
			expect(isTerminalClientError({ status })).toBe(false)
		}
	})

	it("5xx とステータス無しは終端にしない", () => {
		expect(isTerminalClientError({ status: 500 })).toBe(false)
		expect(isTerminalClientError({ message: "network error" })).toBe(false)
	})

	it("context-window 超過は終端にしない", () => {
		expect(isTerminalClientError({ status: 400 }, { isContextWindowExceeded: true })).toBe(false)
	})
})

describe("MAX_API_RETRY_ATTEMPTS", () => {
	it("無限ループを防ぐ寛大な値", () => {
		expect(MAX_API_RETRY_ATTEMPTS).toBeGreaterThanOrEqual(5)
	})
})
