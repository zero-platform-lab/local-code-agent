// npx vitest src/components/settings/__tests__/diagnosticMessagesLimit.spec.ts

import {
	DEFAULT_MAX_DIAGNOSTIC_MESSAGES,
	MAX_SLIDER_VALUE,
	UNLIMITED_STORED_VALUE,
	fromSliderValue,
	isUnlimited,
	toSliderValue,
} from "../diagnosticMessagesLimit"

describe("toSliderValue", () => {
	it("通常の値はそのままスライダー位置になる", () => {
		expect(toSliderValue(25)).toBe(25)
	})

	it("未設定は既定値に寄せる", () => {
		expect(toSliderValue(undefined)).toBe(DEFAULT_MAX_DIAGNOSTIC_MESSAGES)
	})

	it("センチネル（-1）は上限に寄せる", () => {
		expect(toSliderValue(UNLIMITED_STORED_VALUE)).toBe(MAX_SLIDER_VALUE)
	})

	it("0 も無制限として上限に寄せる", () => {
		expect(toSliderValue(0)).toBe(MAX_SLIDER_VALUE)
	})

	it("任意の負値も無制限として扱う", () => {
		expect(toSliderValue(-999)).toBe(MAX_SLIDER_VALUE)
	})

	it("ちょうど上限の保存値はそのまま", () => {
		expect(toSliderValue(MAX_SLIDER_VALUE)).toBe(MAX_SLIDER_VALUE)
	})
})

describe("fromSliderValue", () => {
	it("通常の位置はそのまま保存される", () => {
		expect(fromSliderValue(25)).toBe(25)
	})

	it("上限まで動かすとセンチネルで保存される", () => {
		expect(fromSliderValue(MAX_SLIDER_VALUE)).toBe(UNLIMITED_STORED_VALUE)
	})

	it("下限はそのまま保存される", () => {
		expect(fromSliderValue(1)).toBe(1)
	})
})

describe("isUnlimited", () => {
	it("センチネルと 0 以下は無制限", () => {
		expect(isUnlimited(UNLIMITED_STORED_VALUE)).toBe(true)
		expect(isUnlimited(0)).toBe(true)
		expect(isUnlimited(-5)).toBe(true)
	})

	it("ちょうど上限の保存値も無制限として表示する", () => {
		expect(isUnlimited(MAX_SLIDER_VALUE)).toBe(true)
	})

	it("通常値と未設定は無制限ではない", () => {
		expect(isUnlimited(50)).toBe(false)
		expect(isUnlimited(1)).toBe(false)
		expect(isUnlimited(undefined)).toBe(false)
	})
})

describe("変換の整合性", () => {
	it("スライダー位置が上限かどうかと isUnlimited が一致する（表示が食い違わない）", () => {
		const stored = [undefined, -999, -1, 0, 1, 25, 50, 99, 100]

		for (const value of stored) {
			expect(isUnlimited(value)).toBe(toSliderValue(value) === MAX_SLIDER_VALUE)
		}
	})

	it("スライダーを動かして保存した値は、同じ位置に復元される（往復で動かない）", () => {
		for (let position = 1; position <= MAX_SLIDER_VALUE; position++) {
			expect(toSliderValue(fromSliderValue(position))).toBe(position)
		}
	})
})
