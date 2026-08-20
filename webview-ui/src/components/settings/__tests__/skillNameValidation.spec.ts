// npx vitest src/components/settings/__tests__/skillNameValidation.spec.ts

import { describeSkillNameProblem, validateSkillName } from "../skillNameValidation"

const REQUIRED = "settings:skills.validation.nameRequired"
const TOO_LONG = "settings:skills.validation.nameTooLong"
const INVALID = "settings:skills.validation.nameInvalid"
const HYPHEN = "settings:skills.validation.nameHyphenPlacement"

/** 入力ハンドラが適用しているのと同じ文字種フィルタ。 */
const inputFilter = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9-]/g, "")

describe("validateSkillName", () => {
	it("正しい名前は null", () => {
		expect(validateSkillName("my-skill")).toBeNull()
		expect(validateSkillName("skill1")).toBeNull()
	})

	it("空は必須エラー", () => {
		expect(validateSkillName("")).toBe(REQUIRED)
	})

	it("64 文字超は長さエラー", () => {
		expect(validateSkillName("a".repeat(65))).toBe(TOO_LONG)
	})

	it("64 文字ちょうどは通る", () => {
		expect(validateSkillName("a".repeat(64))).toBeNull()
	})

	it("使えない文字は形式エラー", () => {
		expect(validateSkillName("My_Skill")).toBe(INVALID)
		expect(validateSkillName("my skill")).toBe(INVALID)
	})
})

describe("describeSkillNameProblem", () => {
	it("未入力は指摘しない（まだ間違えていない）", () => {
		expect(describeSkillNameProblem("")).toBeNull()
	})

	it("正しい名前は指摘しない", () => {
		expect(describeSkillNameProblem("my-skill")).toBeNull()
		expect(describeSkillNameProblem("a")).toBeNull()
	})

	it.each([
		["先頭ハイフン", "-foo"],
		["末尾ハイフン", "foo-"],
		["連続ハイフン", "foo--bar"],
		["ハイフンのみ", "--"],
		["単独ハイフン", "-"],
	])("ハイフンの位置は専用メッセージで指摘する: %s", (_label, name) => {
		expect(describeSkillNameProblem(name)).toBe(HYPHEN)
	})

	it("長さ超過はハイフンより優先せず、長さのメッセージを出す", () => {
		expect(describeSkillNameProblem("a".repeat(65))).toBe(TOO_LONG)
	})

	it("ハイフン以外の形式違反は汎用メッセージ（フィルタを通らない経路の保険）", () => {
		expect(describeSkillNameProblem("my_skill")).toBe(INVALID)
	})

	// これがこの変更の目的: 途中経過を潰さずに、確定形だけを通す。
	it("`foo-bar` を打つ途中の状態を消さずに指摘できる", () => {
		const keystrokes = ["f", "fo", "foo", "foo-", "foo-b", "foo-ba", "foo-bar"]
		const results = keystrokes.map((k) => describeSkillNameProblem(k))

		expect(results).toEqual([null, null, null, HYPHEN, null, null, null])
	})

	it("入力フィルタを通した値の形式違反はハイフン位置に限られる", () => {
		const raw = ["-foo", "foo-", "foo--bar", "My_Skill", "my skill", "!!!", "a-b"]

		for (const value of raw.map(inputFilter)) {
			const problem = describeSkillNameProblem(value)
			expect(problem === null || problem === HYPHEN || problem === REQUIRED).toBe(true)
		}
	})
})
