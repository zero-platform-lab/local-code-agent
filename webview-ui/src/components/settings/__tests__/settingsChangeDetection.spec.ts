// npx vitest src/components/settings/__tests__/settingsChangeDetection.spec.ts

import { areValuesEqual, shouldMarkDirty } from "../settingsChangeDetection"

describe("areValuesEqual", () => {
	it("同一値は等しい", () => {
		expect(areValuesEqual("a", "a")).toBe(true)
		expect(areValuesEqual(1, 1)).toBe(true)
	})

	it("null と undefined はどちらも「未設定」として等しい", () => {
		expect(areValuesEqual(null, undefined)).toBe(true)
		expect(areValuesEqual(undefined, null)).toBe(true)
		expect(areValuesEqual(null, null)).toBe(true)
	})

	it("型が違えば等しくない", () => {
		expect(areValuesEqual(1, "1")).toBe(false)
		expect(areValuesEqual(0, false)).toBe(false)
	})

	it("オブジェクトは JSON 表現で比較する", () => {
		expect(areValuesEqual({ a: 1 }, { a: 1 })).toBe(true)
		expect(areValuesEqual({ a: 1 }, { a: 2 })).toBe(false)
		expect(areValuesEqual([1, 2], [1, 2])).toBe(true)
	})

	it("キー順が違うと別物と判定される（安全側に倒れる既知の性質）", () => {
		expect(areValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false)
	})

	it("空文字と未設定は等しくない（初期同期側で扱う関心事）", () => {
		expect(areValuesEqual("", undefined)).toBe(false)
		expect(areValuesEqual("", null)).toBe(false)
	})
})

describe("shouldMarkDirty", () => {
	// 非 secret の代表。空値の種類は区別しない。
	const PLAIN = "openAiBaseUrl"
	// secret の代表。`ContextProxy.storeSecret` が undefined=削除 / ""=空文字保存 と扱うので
	// 空値の種類を潰してはいけない。
	const SECRET = "openAiApiKey"

	describe("ユーザー操作", () => {
		it("常に変更として数える", () => {
			expect(shouldMarkDirty(PLAIN, "old", "new", true)).toBe(true)
		})

		it("未設定から実値でも数える（ユーザーが入力したのだから）", () => {
			expect(shouldMarkDirty(PLAIN, "", "typed", true)).toBe(true)
			expect(shouldMarkDirty(PLAIN, undefined, "typed", true)).toBe(true)
		})

		it("意味的に同じ値でも数える", () => {
			expect(shouldMarkDirty(PLAIN, { a: 1 }, { a: 1 }, true)).toBe(true)
		})

		it("secret でも同じ（ユーザー操作は常に数える）", () => {
			expect(shouldMarkDirty(SECRET, undefined, "", true)).toBe(true)
		})
	})

	describe("自動同期", () => {
		// 元の spec が expect(true).toBe(true) のまま検証できずコメントに書き写していた規則。
		it.each([
			["undefined から実値", undefined],
			["空文字から実値", ""],
			["null から実値", null],
		])("初期同期は変更として数えない: %s", (_label, previous) => {
			expect(shouldMarkDirty(PLAIN, previous, "value", false)).toBe(false)
		})

		it("意味的に同じ値の書き戻しは数えない", () => {
			expect(shouldMarkDirty(PLAIN, { a: 1 }, { a: 1 }, false)).toBe(false)
			expect(shouldMarkDirty(PLAIN, null, undefined, false)).toBe(false)
		})

		it("実値から別の実値へは数える（初期化ではない）", () => {
			expect(shouldMarkDirty(PLAIN, "old", "new", false)).toBe(true)
		})

		it("実値から未設定へは数える（初期同期の向きではない）", () => {
			expect(shouldMarkDirty(PLAIN, "old", "", false)).toBe(true)
			expect(shouldMarkDirty(PLAIN, "old", undefined, false)).toBe(true)
		})

		it("同じ種類の未設定どうしは数えない", () => {
			expect(shouldMarkDirty(PLAIN, undefined, undefined, false)).toBe(false)
			expect(shouldMarkDirty(PLAIN, null, undefined, false)).toBe(false)
		})
	})

	describe("空値の正規化（非 secret）", () => {
		// これがこの変更の目的: 自動同期が空文字を書き戻しても未保存にならない。
		it.each([
			['undefined → ""', undefined, ""],
			['"" → undefined', "", undefined],
			['null → ""', null, ""],
			['"" → null', "", null],
			["undefined → null", undefined, null],
		])("空値どうしの往復は数えない: %s", (_label, previous, next) => {
			expect(shouldMarkDirty(PLAIN, previous, next, false)).toBe(false)
		})
	})

	describe("空値の区別（secret）", () => {
		// secret は「未設定に戻す」と「空にする」が別の操作なので、握り潰すと
		// ユーザーの実変更が保存ボタンに現れなくなる。
		it.each([
			['undefined → ""（削除済み → 空文字を保存）', undefined, ""],
			['"" → undefined（空文字保存 → 削除）', "", undefined],
			['null → ""', null, ""],
		])("空値どうしでも種類が変われば数える: %s", (_label, previous, next) => {
			expect(shouldMarkDirty(SECRET, previous, next, false)).toBe(true)
		})

		it("同じ種類の未設定どうしは secret でも数えない", () => {
			expect(shouldMarkDirty(SECRET, undefined, undefined, false)).toBe(false)
			expect(shouldMarkDirty(SECRET, "", "", false)).toBe(false)
			expect(shouldMarkDirty(SECRET, null, undefined, false)).toBe(false)
		})

		it("初期同期（未設定 → 実値）は secret でも数えない", () => {
			expect(shouldMarkDirty(SECRET, undefined, "sk-live-xxx", false)).toBe(false)
		})

		it("secret 判定はフィールド名で切り替わる（同じ値でも結果が違う）", () => {
			expect(shouldMarkDirty(SECRET, undefined, "", false)).toBe(true)
			expect(shouldMarkDirty(PLAIN, undefined, "", false)).toBe(false)
		})
	})

	it("画面を開いただけで未保存にならない（自動同期の一括初期化）", () => {
		const autoSyncOnMount = [
			[undefined, "openai"],
			["", "gpt-4"],
			[null, 0.5],
		] as const

		for (const [previous, next] of autoSyncOnMount) {
			expect(shouldMarkDirty(PLAIN, previous, next, false)).toBe(false)
		}
	})
})
