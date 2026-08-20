// npx vitest src/components/modes/__tests__/modeFormLogic.spec.ts

import type { ModeConfig, GroupEntry } from "@openai-agent/types"

import {
	applyLocalRenames,
	buildModeConfig,
	buildUniqueModeIdentity,
	generateSlug,
	getGroupName,
	filterModesBySearch,
	isNameOrSlugTaken,
	toggleGroup,
	validateModeDraft,
	type ModeDraft,
} from "../modeFormLogic"

const draft = (overrides: Partial<ModeDraft> = {}): ModeDraft => ({
	name: "My Mode",
	slug: "my-mode",
	description: "",
	roleDefinition: "You are a helpful assistant.",
	whenToUse: "",
	customInstructions: "",
	groups: ["read"],
	source: "global",
	...overrides,
})

const mode = (slug: string, name: string): ModeConfig => ({ slug, name, roleDefinition: "r", groups: [] }) as ModeConfig

describe("generateSlug", () => {
	it("小文字化して空白をハイフンに畳む", () => {
		expect(generateSlug("My New Mode")).toBe("my-new-mode")
	})

	it("英数字とハイフン以外を落とす", () => {
		expect(generateSlug("C++ & Rust!")).toBe("c-rust")
	})

	it("連続した記号は 1 つのハイフンにまとめる", () => {
		expect(generateSlug("a   ///   b")).toBe("a-b")
	})

	it("前後のハイフンを落とす", () => {
		expect(generateSlug("  !leading and trailing!  ")).toBe("leading-and-trailing")
	})

	it("既存のハイフンは保つ", () => {
		expect(generateSlug("front-end")).toBe("front-end")
	})

	it("attempt が 0 なら連番を付けない", () => {
		expect(generateSlug("mode", 0)).toBe("mode")
	})

	it("attempt が 1 以上なら連番を付ける", () => {
		expect(generateSlug("mode", 2)).toBe("mode-2")
	})

	it("記号だけの名前は空 slug になる（呼び出し側の検証で弾かれる）", () => {
		expect(generateSlug("!!!")).toBe("")
	})
})

describe("isNameOrSlugTaken", () => {
	const modes = [mode("code", "Code"), mode("architect", "Architect")]

	it("slug が一致すれば取られている", () => {
		expect(isNameOrSlugTaken(modes, "Anything", "code")).toBe(true)
	})

	it("name が一致すれば取られている", () => {
		expect(isNameOrSlugTaken(modes, "Code", "anything")).toBe(true)
	})

	it("どちらも一致しなければ空いている", () => {
		expect(isNameOrSlugTaken(modes, "New", "new")).toBe(false)
	})

	it("モードが無ければ常に空いている", () => {
		expect(isNameOrSlugTaken([], "Code", "code")).toBe(false)
	})
})

describe("buildUniqueModeIdentity", () => {
	it("衝突しなければ基本名をそのまま使う", () => {
		expect(buildUniqueModeIdentity([], "New Custom Mode")).toEqual({
			name: "New Custom Mode",
			slug: "new-custom-mode",
		})
	})

	it("衝突したら 2 から採番する（1 は飛ばす）", () => {
		const modes = [mode("new-custom-mode", "New Custom Mode")]

		expect(buildUniqueModeIdentity(modes, "New Custom Mode")).toEqual({
			name: "New Custom Mode 2",
			slug: "new-custom-mode-2",
		})
	})

	it("連続して衝突しても空きが見つかるまで進む", () => {
		const modes = [
			mode("new-custom-mode", "New Custom Mode"),
			mode("new-custom-mode-2", "New Custom Mode 2"),
			mode("new-custom-mode-3", "New Custom Mode 3"),
		]

		expect(buildUniqueModeIdentity(modes, "New Custom Mode").name).toBe("New Custom Mode 4")
	})

	it("name だけの衝突でも次へ進む", () => {
		const modes = [mode("unrelated-slug", "New Custom Mode")]

		expect(buildUniqueModeIdentity(modes, "New Custom Mode").name).toBe("New Custom Mode 2")
	})
})

describe("buildModeConfig", () => {
	it("必須項目は trim して保持する", () => {
		const config = buildModeConfig(draft({ roleDefinition: "  You are helpful.  " }))

		expect(config.roleDefinition).toBe("You are helpful.")
	})

	it("空の任意項目は undefined にする（空文字を保存しない）", () => {
		const config = buildModeConfig(draft({ description: "   ", whenToUse: "", customInstructions: "  " }))

		expect(config.description).toBeUndefined()
		expect(config.whenToUse).toBeUndefined()
		expect(config.customInstructions).toBeUndefined()
	})

	it("値のある任意項目は trim して保持する", () => {
		const config = buildModeConfig(draft({ description: "  desc  ", whenToUse: " when " }))

		expect(config.description).toBe("desc")
		expect(config.whenToUse).toBe("when")
	})

	it("slug / name / groups / source をそのまま載せる", () => {
		const groups: GroupEntry[] = ["read", "edit"]
		const config = buildModeConfig(draft({ slug: "s", name: "N", groups, source: "project" }))

		expect(config).toMatchObject({ slug: "s", name: "N", groups, source: "project" })
	})
})

describe("validateModeDraft", () => {
	it("妥当な下書きは ok で ModeConfig を返す", () => {
		const result = validateModeDraft(draft())

		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.mode.slug).toBe("my-mode")
		}
	})

	it("空の roleDefinition を弾き、該当フィールドにエラーを載せる", () => {
		const result = validateModeDraft(draft({ roleDefinition: "   " }))

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.errors.roleDefinition).not.toBe("")
			expect(result.errors.name).toBe("")
		}
	})

	it("不正な slug を弾く", () => {
		const result = validateModeDraft(draft({ slug: "not a slug!" }))

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.errors.slug).not.toBe("")
		}
	})

	it("空の name を弾く", () => {
		const result = validateModeDraft(draft({ name: "" }))

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.errors.name).not.toBe("")
		}
	})

	it("複数フィールドのエラーを同時に返す", () => {
		const result = validateModeDraft(draft({ name: "", slug: "bad slug", roleDefinition: "" }))

		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.errors.name).not.toBe("")
			expect(result.errors.slug).not.toBe("")
			expect(result.errors.roleDefinition).not.toBe("")
		}
	})

	it("失敗時も組み立てた mode を返す（呼び出し側が再利用できる）", () => {
		const result = validateModeDraft(draft({ roleDefinition: "" }))

		expect(result.mode.slug).toBe("my-mode")
	})
})

describe("getGroupName", () => {
	it("文字列形式をそのまま返す", () => {
		expect(getGroupName("read")).toBe("read")
	})

	it("タプル形式は先頭を返す", () => {
		expect(getGroupName(["edit", { fileRegex: "\\.ts$" }] as GroupEntry)).toBe("edit")
	})
})

describe("toggleGroup", () => {
	it("チェックすると末尾に追加する", () => {
		expect(toggleGroup(["read"], "edit", true)).toEqual(["read", "edit"])
	})

	it("外すと取り除く", () => {
		expect(toggleGroup(["read", "edit"], "edit", false)).toEqual(["read"])
	})

	it("タプル形式のグループも名前で外せる", () => {
		const groups: GroupEntry[] = ["read", ["edit", { fileRegex: "\\.ts$" }] as GroupEntry]

		expect(toggleGroup(groups, "edit", false)).toEqual(["read"])
	})

	it("入力配列を破壊しない", () => {
		const groups: GroupEntry[] = ["read"]

		toggleGroup(groups, "edit", true)

		expect(groups).toEqual(["read"])
	})

	it("空から始めても追加できる", () => {
		expect(toggleGroup([], "read", true)).toEqual(["read"])
	})
})

describe("applyLocalRenames", () => {
	const modes = [mode("code", "Code"), mode("architect", "Architect")]

	it("リネームのあるモードだけ表示名を差し替える", () => {
		const renamed = applyLocalRenames(modes, { code: "My Code" })

		expect(renamed.map((m) => m.name)).toEqual(["My Code", "Architect"])
	})

	it("元の配列とモードを書き換えない（保存確定まで元を保つ）", () => {
		applyLocalRenames(modes, { code: "My Code" })

		expect(modes[0].name).toBe("Code")
	})

	it("リネームが無ければ内容はそのまま", () => {
		expect(applyLocalRenames(modes, {}).map((m) => m.name)).toEqual(["Code", "Architect"])
	})

	it("modes が undefined でも空配列を返す", () => {
		expect(applyLocalRenames(undefined, {})).toEqual([])
	})

	it("slug など他のフィールドは保つ", () => {
		expect(applyLocalRenames(modes, { code: "My Code" })[0].slug).toBe("code")
	})
})

describe("filterModesBySearch", () => {
	const modes = [mode("code", "Code"), mode("architect", "Architect"), mode("debug", "Debug")]

	it("検索が空なら全部返す", () => {
		expect(filterModesBySearch(modes, "")).toHaveLength(3)
	})

	it("表示名の部分一致で絞り込む", () => {
		expect(filterModesBySearch(modes, "de").map((m) => m.slug)).toEqual(["code", "debug"])
	})

	it("大文字小文字を無視する", () => {
		expect(filterModesBySearch(modes, "ARCH").map((m) => m.slug)).toEqual(["architect"])
	})

	it("slug は検索対象にしない（名前のみ）", () => {
		const renamed = [mode("debug", "Fehlersuche")]

		expect(filterModesBySearch(renamed, "debug")).toEqual([])
	})

	it("一致が無ければ空配列", () => {
		expect(filterModesBySearch(modes, "zzz")).toEqual([])
	})

	it("入力配列を破壊しない", () => {
		filterModesBySearch(modes, "de")

		expect(modes).toHaveLength(3)
	})
})
