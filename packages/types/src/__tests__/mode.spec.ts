// npx vitest run src/__tests__/mode.spec.ts
//
// mode.ts のスキーマ検証分岐。PR #21 で DEFAULT_MODES を code 1 件へ減らした際に
// カバー済み行（モード定義のデータ）が減り、この検証分岐の未カバーが露出して
// パッケージの網羅率が床（78%）を割った。分岐そのものを検証してカバーする。

import { customModesSettingsSchema, groupEntryArraySchema, modeConfigSchema, DEFAULT_MODES } from "../mode.js"

describe("groupEntryArraySchema", () => {
	it("正当なグループの配列を受理する", () => {
		expect(groupEntryArraySchema.parse(["read", "edit"])).toEqual(["read", "edit"])
	})

	it("オプション付きのタプル形式を受理する", () => {
		const entry = [["edit", { fileRegex: "\\.md$", description: "Markdown files only" }]]

		expect(groupEntryArraySchema.parse(entry)).toEqual(entry)
	})

	it("廃止済みグループ（browser）を文字列形式でもタプル形式でも除去する", () => {
		// 旧設定との互換。検証前の preprocess で黙って取り除く。
		expect(groupEntryArraySchema.parse(["read", "browser"])).toEqual(["read"])
		expect(groupEntryArraySchema.parse([["browser", { fileRegex: ".*" }], "read"])).toEqual(["read"])
	})

	it("重複したグループを拒否する", () => {
		expect(() => groupEntryArraySchema.parse(["read", "read"])).toThrow(/Duplicate groups/)
	})

	it("タプルと文字列で同じグループ名が重複しても拒否する", () => {
		expect(() => groupEntryArraySchema.parse(["edit", ["edit", { fileRegex: "\\.md$" }]])).toThrow(
			/Duplicate groups/,
		)
	})

	it("配列でない入力は preprocess を素通りして型エラーになる", () => {
		expect(() => groupEntryArraySchema.parse("read")).toThrow()
	})
})

describe("modeConfigSchema", () => {
	const valid = {
		slug: "my-mode",
		name: "My Mode",
		roleDefinition: "You do my work",
		groups: ["read"],
	}

	it("最小構成を受理する", () => {
		expect(modeConfigSchema.parse(valid).slug).toBe("my-mode")
	})

	it("slug に使えない文字を拒否する", () => {
		expect(() => modeConfigSchema.parse({ ...valid, slug: "bad slug!" })).toThrow(/Slug/)
	})

	it("空の name と roleDefinition を拒否する", () => {
		expect(() => modeConfigSchema.parse({ ...valid, name: "" })).toThrow(/Name is required/)
		expect(() => modeConfigSchema.parse({ ...valid, roleDefinition: "" })).toThrow(/Role definition is required/)
	})

	it("source は global / project のみ受理する", () => {
		expect(modeConfigSchema.parse({ ...valid, source: "project" }).source).toBe("project")
		expect(() => modeConfigSchema.parse({ ...valid, source: "elsewhere" })).toThrow()
	})
})

describe("customModesSettingsSchema", () => {
	const mode = (slug: string) => ({
		slug,
		name: slug,
		roleDefinition: "You work",
		groups: ["read"],
	})

	it("slug が一意なら受理する", () => {
		expect(customModesSettingsSchema.parse({ customModes: [mode("a"), mode("b")] }).customModes).toHaveLength(2)
	})

	it("slug の重複を拒否する", () => {
		expect(() => customModesSettingsSchema.parse({ customModes: [mode("a"), mode("a")] })).toThrow(
			/Duplicate mode slugs/,
		)
	})
})

describe("DEFAULT_MODES", () => {
	it("組み込みは code の 1 件だけ（PR #21 の集約を固定する）", () => {
		expect(DEFAULT_MODES.map((m: (typeof DEFAULT_MODES)[number]) => m.slug)).toEqual(["code"])
	})

	it("code は全ツールグループを持ち、customInstructions を持たない", () => {
		const code = DEFAULT_MODES[0]

		if (!code) {
			throw new Error("DEFAULT_MODES is empty")
		}

		expect(code.groups).toEqual(["read", "edit", "command", "mcp"])
		expect(code.customInstructions).toBeUndefined()
	})
})
