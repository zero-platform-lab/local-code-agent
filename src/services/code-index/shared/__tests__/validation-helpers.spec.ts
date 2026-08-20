// i18n はテストで決定論的にするためモック化する。
// キー自体を返しつつ、補間パラメータを埋め込んだ文字列にして検証しやすくする。
vitest.mock("../../../../i18n", () => ({
	t: (key: string, params?: Record<string, any>) => (params ? `${key}::${JSON.stringify(params)}` : key),
}))

import {
	sanitizeErrorMessage,
	getErrorMessageForStatus,
	extractStatusCode,
	extractErrorMessage,
	handleValidationError,
	withValidationErrorHandling,
	formatEmbeddingError,
} from "../validation-helpers"

describe("sanitizeErrorMessage", () => {
	it("should sanitize Unix-style file paths", () => {
		const input = "Error reading file /Users/username/projects/myapp/src/index.ts"
		const expected = "Error reading file [REDACTED_PATH]"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize Windows-style file paths", () => {
		const input = "Cannot access C:\\Users\\username\\Documents\\project\\file.js"
		const expected = "Cannot access [REDACTED_PATH]"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize relative file paths", () => {
		const input = "File not found: ./src/components/Button.tsx"
		const expected = "File not found: [REDACTED_PATH]"
		expect(sanitizeErrorMessage(input)).toBe(expected)

		const input2 = "Cannot read ../config/settings.json"
		const expected2 = "Cannot read [REDACTED_PATH]"
		expect(sanitizeErrorMessage(input2)).toBe(expected2)
	})

	it("should sanitize URLs with various protocols", () => {
		const input = "Failed to connect to http://localhost:11434/api/embed"
		const expected = "Failed to connect to [REDACTED_URL]"
		expect(sanitizeErrorMessage(input)).toBe(expected)

		const input2 = "Error fetching https://api.example.com:8080/v1/embeddings"
		const expected2 = "Error fetching [REDACTED_URL]"
		expect(sanitizeErrorMessage(input2)).toBe(expected2)
	})

	it("should sanitize IP addresses", () => {
		const input = "Connection refused at 192.168.1.100"
		const expected = "Connection refused at [REDACTED_IP]"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize port numbers", () => {
		const input = "Server running on :8080 failed"
		const expected = "Server running on :[REDACTED_PORT] failed"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize email addresses", () => {
		const input = "User john.doe@example.com not found"
		const expected = "User [REDACTED_EMAIL] not found"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize paths in quotes", () => {
		const input = 'Cannot open file "/home/user/documents/secret.txt"'
		const expected = 'Cannot open file "[REDACTED_PATH]"'
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should handle complex error messages with multiple sensitive items", () => {
		const input = "Failed to fetch http://localhost:11434 from /Users/john/project at 192.168.1.1:3000"
		const expected = "Failed to fetch [REDACTED_URL] from [REDACTED_PATH] at [REDACTED_IP]:[REDACTED_PORT]"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should handle non-string inputs gracefully", () => {
		expect(sanitizeErrorMessage(null as any)).toBe("null")
		expect(sanitizeErrorMessage(undefined as any)).toBe("undefined")
		expect(sanitizeErrorMessage(123 as any)).toBe("123")
		expect(sanitizeErrorMessage({} as any)).toBe("[object Object]")
	})

	it("should preserve non-sensitive error messages", () => {
		const input = "Invalid JSON format"
		expect(sanitizeErrorMessage(input)).toBe(input)

		const input2 = "Connection timeout"
		expect(sanitizeErrorMessage(input2)).toBe(input2)
	})

	it("should handle file paths with special characters", () => {
		const input = 'Error in "/path/to/file with spaces.txt"'
		const expected = 'Error in "[REDACTED_PATH]"'
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize multiple occurrences of sensitive data", () => {
		const input = "Copy from /src/file1.js to /dest/file2.js failed"
		const expected = "Copy from [REDACTED_PATH] to [REDACTED_PATH] failed"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})
})

describe("getErrorMessageForStatus", () => {
	it("401/403 は認証失敗メッセージを返す", () => {
		expect(getErrorMessageForStatus(401, "openai")).toBe("embeddings:validation.authenticationFailed")
		expect(getErrorMessageForStatus(403, "openai")).toBe("embeddings:validation.authenticationFailed")
	})

	it("404 は embedderType により文言を出し分ける", () => {
		expect(getErrorMessageForStatus(404, "openai")).toBe("embeddings:validation.modelNotAvailable")
		expect(getErrorMessageForStatus(404, "openai-compatible")).toBe("embeddings:validation.invalidEndpoint")
	})

	it("429 はサービス利用不可メッセージを返す", () => {
		expect(getErrorMessageForStatus(429, "openai")).toBe("embeddings:validation.serviceUnavailable")
	})

	it("その他の 4xx/5xx は設定エラーメッセージを返す", () => {
		expect(getErrorMessageForStatus(500, "openai")).toBe("embeddings:validation.configurationError")
		expect(getErrorMessageForStatus(400, "openai")).toBe("embeddings:validation.configurationError")
	})

	it("範囲外のステータス（truthy だが 400 未満）は undefined を返す", () => {
		expect(getErrorMessageForStatus(200, "openai")).toBeUndefined()
	})

	it("status が undefined の場合は undefined を返す", () => {
		expect(getErrorMessageForStatus(undefined, "openai")).toBeUndefined()
	})
})

describe("extractStatusCode", () => {
	it("直接の status プロパティを優先する", () => {
		expect(extractStatusCode({ status: 401 })).toBe(401)
	})

	it("response.status から取得する", () => {
		expect(extractStatusCode({ response: { status: 404 } })).toBe(404)
	})

	it('エラーメッセージ内の "HTTP <code>:" を解析する', () => {
		expect(extractStatusCode({ message: "HTTP 429: Too Many Requests" })).toBe(429)
	})

	it("メッセージはあるが HTTP パターンに一致しない場合は undefined", () => {
		expect(extractStatusCode({ message: "some random failure" })).toBeUndefined()
	})

	it("どのプロパティも無ければ undefined", () => {
		expect(extractStatusCode({})).toBeUndefined()
	})

	// serialize-error 経由のフォールバック（直接アクセスでは取れないが直列化で復元できる経路）。
	// 初回アクセスだけ undefined を返すゲッターで、直接チェックをすり抜け直列化時に値を得る状況を再現する。
	it("直接アクセスで取れず serialize-error 経由でのみ status を復元できる", () => {
		let accessed = false
		const error = {
			get status() {
				if (!accessed) {
					accessed = true
					return undefined
				}
				return 503
			},
		}
		expect(extractStatusCode(error)).toBe(503)
	})

	it("直接アクセスで取れず serialize-error 経由でのみ response.status を復元できる", () => {
		let seen = false
		const error = {
			get response() {
				if (!seen) {
					seen = true
					return undefined
				}
				return { status: 404 }
			},
		}
		expect(extractStatusCode(error)).toBe(404)
	})
})

describe("extractErrorMessage", () => {
	it("message プロパティを返す", () => {
		expect(extractErrorMessage({ message: "boom" })).toBe("boom")
	})

	it("文字列そのものを返す", () => {
		expect(extractErrorMessage("string error")).toBe("string error")
	})

	it("message が無いオブジェクトは toString で文字列化する", () => {
		expect(extractErrorMessage({ toString: () => "custom-string" })).toBe("custom-string")
	})

	it("toString が例外を投げる場合は Unknown error にフォールバックする", () => {
		const error = {
			toString: () => {
				throw new Error("boom")
			},
		}
		expect(extractErrorMessage(error)).toBe("Unknown error")
	})

	it("toString を持たず message も直列化で取れない場合は Unknown error", () => {
		const error = Object.create(null)
		error.foo = "bar"
		expect(extractErrorMessage(error)).toBe("Unknown error")
	})

	// serialize-error 経由でのみ message を復元できるフォールバック経路。
	// toString を持たない null プロトタイプ + 初回だけ undefined を返すゲッターで再現する。
	it("直接アクセスで取れず serialize-error 経由でのみ message を復元できる", () => {
		const error: any = Object.create(null)
		let accessed = false
		Object.defineProperty(error, "message", {
			enumerable: true,
			configurable: true,
			get() {
				if (!accessed) {
					accessed = true
					return undefined
				}
				return "recovered-message"
			},
		})
		expect(extractErrorMessage(error)).toBe("recovered-message")
	})
})

describe("handleValidationError", () => {
	it("customHandlers が結果を返した場合はそれを優先する", () => {
		const result = handleValidationError(new Error("ignored"), "openai", {
			beforeStandardHandling: () => ({ valid: false, error: "custom" }),
		})
		expect(result).toEqual({ valid: false, error: "custom" })
	})

	it("customHandlers が undefined を返した場合は標準処理に進む", () => {
		const result = handleValidationError({ status: 401 }, "openai", {
			beforeStandardHandling: () => undefined,
		})
		expect(result).toEqual({ valid: false, error: "embeddings:validation.authenticationFailed" })
	})

	it("ステータスコードに基づくエラーを返す", () => {
		const result = handleValidationError({ status: 404 }, "openai-compatible")
		expect(result).toEqual({ valid: false, error: "embeddings:validation.invalidEndpoint" })
	})

	it.each([
		["ENOTFOUND api.example.com"],
		["ECONNREFUSED"],
		["ETIMEDOUT"],
		["AbortError"],
		["HTTP 0: aborted"],
		["No response"],
	])("接続系エラー（%s）は connectionFailed を返す", (message) => {
		const result = handleValidationError({ message }, "openai")
		expect(result).toEqual({ valid: false, error: "embeddings:validation.connectionFailed" })
	})

	it("JSON パース失敗は invalidResponse を返す", () => {
		const result = handleValidationError({ message: "Failed to parse response JSON" }, "openai")
		expect(result).toEqual({ valid: false, error: "embeddings:validation.invalidResponse" })
	})

	it("標準に該当しないメッセージはそのまま返す", () => {
		const result = handleValidationError({ message: "something weird happened" }, "openai")
		expect(result).toEqual({ valid: false, error: "something weird happened" })
	})

	it("メッセージが Unknown error のときは configurationError にフォールバックする", () => {
		// Error 以外の値（数値）を投げると extractErrorMessage が "Unknown error" を返し、
		// 標準ハンドラの最終フォールバックに到達する。
		const result = handleValidationError(42, "openai")
		expect(result).toEqual({ valid: false, error: "embeddings:validation.configurationError" })
	})
})

describe("withValidationErrorHandling", () => {
	it("検証関数が成功した場合はその結果を返す", async () => {
		const result = await withValidationErrorHandling(async () => ({ valid: true }), "openai")
		expect(result).toEqual({ valid: true })
	})

	it("検証関数が例外を投げた場合は handleValidationError に委譲する", async () => {
		const result = await withValidationErrorHandling(async () => {
			throw { status: 401 }
		}, "openai")
		expect(result).toEqual({ valid: false, error: "embeddings:validation.authenticationFailed" })
	})
})

describe("formatEmbeddingError", () => {
	it("401 は認証失敗メッセージの Error を返す", () => {
		const err = formatEmbeddingError({ status: 401 }, 3)
		expect(err).toBeInstanceOf(Error)
		expect(err.message).toBe("embeddings:authenticationFailed")
	})

	it("401 以外のステータスコードがある場合は failedWithStatus を使う", () => {
		const err = formatEmbeddingError({ status: 500, message: "boom" }, 3)
		expect(err.message).toContain("embeddings:failedWithStatus")
		expect(err.message).toContain('"statusCode":500')
		expect(err.message).toContain('"attempts":3')
	})

	it("ステータスコードが無い場合は failedWithError を使う", () => {
		const err = formatEmbeddingError({ message: "network down" }, 5)
		expect(err.message).toContain("embeddings:failedWithError")
		expect(err.message).toContain('"errorMessage":"network down"')
	})
})
