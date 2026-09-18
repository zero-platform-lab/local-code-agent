import { describe, expect, it } from "vitest"

import { getHttpStatus } from "../httpStatus"

describe("getHttpStatus", () => {
	it("status / response.status / statusCode / error.status を拾う", () => {
		expect(getHttpStatus({ status: 400 })).toBe(400)
		expect(getHttpStatus({ response: { status: 404 } })).toBe(404)
		expect(getHttpStatus({ statusCode: 403 })).toBe(403)
		expect(getHttpStatus({ error: { status: 400 } })).toBe(400)
	})

	it("数値の code も拾う（ラップされた 400 が終端をすり抜けないように）", () => {
		expect(getHttpStatus({ code: 400 })).toBe(400)
		expect(getHttpStatus({ code: "400" })).toBe(400)
	})

	it("HTTP 範囲(100–599)外の数値 code は本当の status を隠さない", () => {
		// errno のような小さな数値 code が、別フィールドの本当の status を上書きしないこと。
		expect(getHttpStatus({ code: 20, response: { status: 400 } })).toBe(400)
		expect(getHttpStatus({ code: 20 })).toBeUndefined()
	})

	it("数値でない code（種別名や ECONNRESET）は無視する", () => {
		expect(getHttpStatus({ code: "invalid_request_error" })).toBeUndefined()
		expect(getHttpStatus({ code: "ECONNRESET" })).toBeUndefined()
	})

	it("メッセージ本文からは拾わない（一時的エラーの文言による誤検出を避ける）", () => {
		expect(getHttpStatus({ message: "connection reset; upstream returned HTTP 400" })).toBeUndefined()
	})

	it("取れなければ undefined", () => {
		expect(getHttpStatus(undefined)).toBeUndefined()
		expect(getHttpStatus({})).toBeUndefined()
	})
})
