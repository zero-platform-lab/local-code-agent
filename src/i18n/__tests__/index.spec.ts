// npx vitest run i18n/__tests__/index.spec.ts
//
// i18n/index の各関数は setup の i18next インスタンスへの薄いラッパ。
// 委譲が正しく、未翻訳キーでも落ちないことを固定する。

import { describe, it, expect, vi, beforeEach } from "vitest"

const stub = vi.hoisted(() => ({
	changeLanguage: vi.fn((_lng: string) => undefined),
	t: vi.fn((_key: string, _opts?: unknown) => "翻訳結果"),
	language: "ja",
}))

vi.mock("../setup", () => ({ default: stub }))

import i18nDefault, { initializeI18n, getCurrentLanguage, changeLanguage, t } from "../index"

beforeEach(() => {
	vi.clearAllMocks()
	stub.language = "ja"
	stub.t.mockReturnValue("翻訳結果")
})

describe("i18n/index", () => {
	it("initializeI18n は i18next.changeLanguage へ委譲する", () => {
		initializeI18n("en")
		expect(stub.changeLanguage).toHaveBeenCalledWith("en")
	})

	it("changeLanguage は i18next.changeLanguage へ委譲する", () => {
		changeLanguage("fr")
		expect(stub.changeLanguage).toHaveBeenCalledWith("fr")
	})

	it("getCurrentLanguage は現在の言語を返す", () => {
		stub.language = "en"
		expect(getCurrentLanguage()).toBe("en")
	})

	it("t は i18next.t の戻り値をそのまま返す（オプション付き）", () => {
		const out = t("common:welcome", { name: "太郎" })
		expect(stub.t).toHaveBeenCalledWith("common:welcome", { name: "太郎" })
		expect(out).toBe("翻訳結果")
	})

	it("t はオプション無しでも呼べる（未翻訳キーでも落ちない）", () => {
		stub.t.mockReturnValue("missing.key")
		expect(t("missing.key")).toBe("missing.key")
		expect(stub.t).toHaveBeenCalledWith("missing.key", undefined)
	})

	it("default export は setup の i18next インスタンス", () => {
		expect(i18nDefault).toBe(stub)
	})
})
