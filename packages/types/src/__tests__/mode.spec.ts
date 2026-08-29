// npx vitest run src/__tests__/mode.spec.ts
//
// mode.ts のスキーマ検証分岐。PR #21 で DEFAULT_MODES を code 1 件へ減らした際に
// カバー済み行（モード定義のデータ）が減り、この検証分岐の未カバーが露出して
// パッケージの網羅率が床（78%）を割った。分岐そのものを検証してカバーする。

import { groupEntryArraySchema, modeConfigSchema, DEFAULT_MODES } from "../mode.js"

describe("groupEntryArraySchema", () => {
	it("正当なグループの配列を受理する", () => {
		expect(groupEntryArraySchema.parse(["read", "edit"])).toEqual(["read", "edit"])
	})

	it("旧タプル形式はグループ名へ正規化して受理する", () => {
		// fileRegex 付きのタプルはカスタムモード（撤去済み）の名残。旧設定を
		// 落とさないよう、オプション部を捨ててグループ名だけを残す。
		const entry = [["edit", { fileRegex: "\\.md$", description: "Markdown files only" }]]

		expect(groupEntryArraySchema.parse(entry)).toEqual(["edit"])
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
})

describe("DEFAULT_MODES", () => {
	it("組み込みは code と research の 2 件（コードを書く仕事と、調査・運用の仕事を分ける）", () => {
		expect(DEFAULT_MODES.map((m: (typeof DEFAULT_MODES)[number]) => m.slug)).toEqual(["code", "research"])
	})

	it("全モードが schema を通り、全ツールグループを持ち、customInstructions を持たない", () => {
		for (const mode of DEFAULT_MODES) {
			expect(modeConfigSchema.parse(mode).slug).toBe(mode.slug)
			// 2 モードの差は役割文のみ。groups を分けたくなったら意図してここを更新する。
			expect(mode.groups).toEqual(["read", "edit", "command", "mcp"])
			expect(mode.customInstructions).toBeUndefined()
		}
	})

	it("research の役割文は調査・運用に向き、コードを書く仕事を含まない", () => {
		const research = DEFAULT_MODES.find((m: (typeof DEFAULT_MODES)[number]) => m.slug === "research")

		if (!research) {
			throw new Error("research mode is missing")
		}

		expect(research.roleDefinition).toContain("do not write application code")
		expect(research.whenToUse).toMatch(/investigation or operations/)
	})

	it("research の役割文は外部文書の調査と手順の検証に言及する", () => {
		const research = DEFAULT_MODES.find((m: (typeof DEFAULT_MODES)[number]) => m.slug === "research")

		if (!research) {
			throw new Error("research mode is missing")
		}

		// マニュアル・GitHub を調べ、手順は適用前に文書と突き合わせる、という仕事を含む。
		expect(research.roleDefinition).toMatch(/manuals and GitHub/)
		expect(research.roleDefinition).toMatch(/verify it against the documentation/)
	})
})
