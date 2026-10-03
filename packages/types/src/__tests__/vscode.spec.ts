import { describe, it, expect } from "vitest"

import { isLanguage, languages } from "../vscode.js"

describe("isLanguage", () => {
	it("用意した言語の一覧にあるものだけを真とする", () => {
		expect(languages.every((language) => isLanguage(language))).toBe(true)
		// 大文字小文字の違いは、別の言語として扱う。`JA` は小文字にすると一覧の `ja` になるので、
		// 小文字にしてから照合する実装へ変えると、ここで気づける。
		expect(isLanguage("JA")).toBe(false)
		expect(isLanguage("zh-cn")).toBe(false)
		expect(isLanguage("")).toBe(false)
	})
})
