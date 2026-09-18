import { describe, expect, it } from "vitest"

import { getHttpStatus, isTerminalClientError, MAX_API_RETRY_ATTEMPTS } from "../apiRetryPolicy"

describe("apiRetryPolicy", () => {
	describe("getHttpStatus", () => {
		it("status / response.status / statusCode を拾う", () => {
			expect(getHttpStatus({ status: 400 })).toBe(400)
			expect(getHttpStatus({ response: { status: 404 } })).toBe(404)
			expect(getHttpStatus({ statusCode: 403 })).toBe(403)
		})

		it("code と error.status も拾う（ラップされた 400 が終端をすり抜けないように）", () => {
			expect(getHttpStatus({ code: 400 })).toBe(400)
			expect(getHttpStatus({ code: "400" })).toBe(400)
			expect(getHttpStatus({ error: { status: 400 } })).toBe(400)
		})

		it("数値でない種別 code（invalid_request_error など）は status にしない", () => {
			expect(getHttpStatus({ code: "invalid_request_error" })).toBeUndefined()
		})

		it("メッセージに明記された HTTP 番号を保険で拾う", () => {
			expect(getHttpStatus({ message: "Request failed: HTTP 400 Bad Request" })).toBe(400)
			expect(getHttpStatus({ message: "status code: 404" })).toBe(404)
		})

		it("取れなければ undefined", () => {
			expect(getHttpStatus(undefined)).toBeUndefined()
			expect(getHttpStatus({ message: "boom" })).toBeUndefined()
		})
	})

	describe("isTerminalClientError", () => {
		it("非リトライの 4xx は終端（code / error.status に乗った 400 も）", () => {
			const terminal = [
				{ status: 400 },
				{ status: 401 },
				{ status: 403 },
				{ status: 404 },
				{ status: 422 },
				{ code: 400 },
				{ error: { status: 400 } },
			]
			for (const e of terminal) {
				expect(isTerminalClientError(e)).toBe(true)
			}
		})

		it("一時的な 4xx（408 / 409 / 425 / 429）は終端にしない", () => {
			for (const status of [408, 409, 425, 429]) {
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

	it("再試行の上限は無限ループを防ぐ寛大な値", () => {
		expect(MAX_API_RETRY_ATTEMPTS).toBeGreaterThanOrEqual(5)
	})
})
