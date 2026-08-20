// npx vitest run src/components/modes/__tests__/modePromptOverrides.spec.ts

import type { PromptComponent } from "@openai-agent/types"

import {
	defaultPrompts,
	getCustomInstructions,
	getDescription,
	getRoleDefinition,
	getWhenToUse,
	type Mode,
} from "@agent/modes"

import { buildPromptOverrideForEdit, buildPromptOverrideForReset, dropDefaultOverrides } from "../modePromptOverrides"

/** 組み込み既定を事前投入した webview state（修正 1 より前の初期値）。 */
const SEEDED = defaultPrompts as Record<string, PromptComponent>
/** 修正 1 適用後の初期値。 */
const EMPTY: Record<string, PromptComponent> = {}

/** `customInstructions` の既定を持つ組み込み mode（5 つ中 4 つ）。 */
const WITH_DEFAULT_INSTRUCTIONS: Mode[] = ["architect", "ask", "debug", "orchestrator"]

/** 保存値のうち、組み込み既定と一致してしまっているフィールド。 */
const leakedFields = (persisted: PromptComponent, mode: Mode): string[] =>
	(["roleDefinition", "description", "whenToUse", "customInstructions"] as const).filter((field) => {
		const value = (persisted as Record<string, unknown>)[field]
		if (value === undefined) return false
		const builtIn = {
			roleDefinition: getRoleDefinition,
			description: getDescription,
			whenToUse: getWhenToUse,
			customInstructions: getCustomInstructions,
		}[field](mode)
		return value === builtIn && builtIn !== ""
	})

/**
 * 修正 2 より前の編集経路（scrub が customInstructions を対象にしていなかった）。
 * 2 段構えの説明のため、旧挙動を再現して比較に使う。
 */
const legacyEdit = (mode: Mode, existing: PromptComponent | undefined, changes: PromptComponent) => {
	const updated: Record<string, unknown> = { ...existing, ...changes }
	if (updated.roleDefinition === getRoleDefinition(mode)) delete updated.roleDefinition
	if (updated.description === getDescription(mode)) delete updated.description
	if (updated.whenToUse === getWhenToUse(mode)) delete updated.whenToUse
	return updated as PromptComponent
}

/** 修正 2 より前の「既定に戻す」経路（scrub が一切無かった）。 */
const legacyReset = (existing: PromptComponent | undefined, field: string) => {
	const remaining: Record<string, unknown> = { ...existing }
	delete remaining[field]
	return remaining as PromptComponent
}

describe("段階 1: 初期値が {} なら、scrub の穴があっても既定は保存されない", () => {
	it.each(WITH_DEFAULT_INSTRUCTIONS)("編集経路（旧 scrub）でも %s の既定が漏れない", (mode) => {
		const persisted = legacyEdit(mode, EMPTY[mode], { roleDefinition: "MY ROLE" })

		expect(leakedFields(persisted, mode)).toEqual([])
		expect(persisted).toEqual({ roleDefinition: "MY ROLE" })
	})

	it.each(WITH_DEFAULT_INSTRUCTIONS)("「既定に戻す」（scrub 無し）でも %s の既定が漏れない", (mode) => {
		const persisted = legacyReset(EMPTY[mode], "roleDefinition")

		expect(leakedFields(persisted, mode)).toEqual([])
		expect(persisted).toEqual({})
	})

	it("事前投入があると旧 scrub は実際に漏らしていた（修正 1 が効いている証拠）", () => {
		// この期待値が「直す前は壊れていた」ことの記録。
		const persisted = legacyEdit("architect", SEEDED.architect, { roleDefinition: "MY ROLE" })

		expect(leakedFields(persisted, "architect")).toEqual(["customInstructions"])
	})

	it("事前投入があると「既定に戻す」は既定 3 つを書き込んでいた", () => {
		const persisted = legacyReset(SEEDED.architect, "roleDefinition")

		expect(leakedFields(persisted, "architect").sort()).toEqual(
			["customInstructions", "description", "whenToUse"].sort(),
		)
	})
})

describe("段階 2: scrub を直せば、事前投入があっても既定は保存されない", () => {
	it.each(WITH_DEFAULT_INSTRUCTIONS)("編集経路: %s を事前投入しても漏れない", (mode) => {
		const persisted = buildPromptOverrideForEdit(mode, SEEDED[mode], { roleDefinition: "MY ROLE" })

		expect(leakedFields(persisted, mode)).toEqual([])
		expect(persisted).toEqual({ roleDefinition: "MY ROLE" })
	})

	it.each(WITH_DEFAULT_INSTRUCTIONS)("「既定に戻す」: %s を事前投入しても漏れない", (mode) => {
		const persisted = buildPromptOverrideForReset(mode, SEEDED[mode], "roleDefinition")

		expect(leakedFields(persisted, mode)).toEqual([])
		expect(persisted).toEqual({})
	})

	it("両方の修正が入った状態が最終形（初期値 {} かつ scrub 済み）", () => {
		expect(buildPromptOverrideForEdit("architect", EMPTY.architect, { whenToUse: "MINE" })).toEqual({
			whenToUse: "MINE",
		})
		expect(buildPromptOverrideForReset("architect", EMPTY.architect, "whenToUse")).toEqual({})
	})
})

describe("dropDefaultOverrides", () => {
	it("ユーザーが本当に変えた値は残す", () => {
		expect(dropDefaultOverrides({ roleDefinition: "MINE", whenToUse: "ALSO MINE" }, "architect")).toEqual({
			roleDefinition: "MINE",
			whenToUse: "ALSO MINE",
		})
	})

	it("既定と一致する値を落とす", () => {
		expect(dropDefaultOverrides({ roleDefinition: getRoleDefinition("architect") }, "architect")).toEqual({})
	})

	it("undefined と空文字も落とす", () => {
		// どちらも「上書きなし」と同義。残すと空でないオブジェクトになり
		// エクスポート経路が「カスタマイズ済み」と誤認する。
		expect(dropDefaultOverrides({ roleDefinition: undefined, whenToUse: "" }, "architect")).toEqual({})
	})

	it("既定を持たないフィールドでも空文字を落とす（code の customInstructions）", () => {
		expect(getCustomInstructions("code")).toBe("")
		expect(dropDefaultOverrides({ customInstructions: "" }, "code")).toEqual({})
	})

	it("既定を持たない mode でユーザーが入れた customInstructions は残す", () => {
		expect(dropDefaultOverrides({ customInstructions: "MINE" }, "code")).toEqual({ customInstructions: "MINE" })
	})

	it("入力を書き換えない", () => {
		const input = { roleDefinition: getRoleDefinition("architect"), whenToUse: "MINE" }
		const snapshot = { ...input }

		dropDefaultOverrides(input, "architect")

		expect(input).toEqual(snapshot)
	})

	it("空の上書きは空のまま", () => {
		expect(dropDefaultOverrides({}, "architect")).toEqual({})
	})
})

describe("buildPromptOverrideForEdit", () => {
	it("既存の上書きへ変更を重ねる", () => {
		const existing: PromptComponent = { roleDefinition: "OLD ROLE", whenToUse: "KEEP" }

		expect(buildPromptOverrideForEdit("architect", existing, { roleDefinition: "NEW ROLE" })).toEqual({
			roleDefinition: "NEW ROLE",
			whenToUse: "KEEP",
		})
	})

	it("既定に戻す値を渡したらそのフィールドは消える", () => {
		const existing: PromptComponent = { roleDefinition: "MINE" }

		expect(
			buildPromptOverrideForEdit("architect", existing, { roleDefinition: getRoleDefinition("architect") }),
		).toEqual({})
	})

	it("customInstructions をユーザーが編集したら残す", () => {
		expect(buildPromptOverrideForEdit("architect", SEEDED.architect, { customInstructions: "MY OWN" })).toEqual({
			customInstructions: "MY OWN",
		})
	})

	it("既存の上書きが無い場合も扱える", () => {
		expect(buildPromptOverrideForEdit("architect", undefined, { whenToUse: "MINE" })).toEqual({ whenToUse: "MINE" })
	})
})

describe("buildPromptOverrideForReset", () => {
	it("対象フィールドだけを消し、他のユーザー上書きは残す", () => {
		const existing: PromptComponent = { roleDefinition: "MINE", whenToUse: "ALSO MINE" }

		expect(buildPromptOverrideForReset("architect", existing, "roleDefinition")).toEqual({
			whenToUse: "ALSO MINE",
		})
	})

	it("最後の上書きを戻したら空になる（＝カスタマイズ解除）", () => {
		expect(buildPromptOverrideForReset("architect", { roleDefinition: "MINE" }, "roleDefinition")).toEqual({})
	})

	it("customInstructions を戻せる", () => {
		expect(buildPromptOverrideForReset("architect", { customInstructions: "MINE" }, "customInstructions")).toEqual(
			{},
		)
	})

	it("既存の上書きが無い場合も空を返す", () => {
		expect(buildPromptOverrideForReset("architect", undefined, "roleDefinition")).toEqual({})
	})
})

/**
 * エクスポート経路の契約テスト。
 *
 * 実際の合成は拡張側 `src/core/config/CustomModesManager.ts` の `exportModeWithRules`
 * （`if (customPrompts.X) exportMode.X = customPrompts.X` を 4 フィールド分）で、
 * webview からは呼べない。ここでは**その規則を再現**して「我々が保存する上書きなら
 * 組み込みテキストがエクスポートに混ざらない」ことを固定する。
 *
 * 権威あるテストは `exportModeWithRules` の隣に置くべきで、その旨は報告に含めている。
 */
describe("エクスポート契約: 保存した上書きが YAML に何を持ち込むか", () => {
	/** CustomModesManager.ts:624-629 の合成を再現。 */
	const mergeForExport = (builtIn: PromptComponent, customPrompts: PromptComponent | undefined) => {
		const exported: Record<string, unknown> = { ...builtIn }
		if (customPrompts) {
			if (customPrompts.roleDefinition) exported.roleDefinition = customPrompts.roleDefinition
			if (customPrompts.description) exported.description = customPrompts.description
			if (customPrompts.whenToUse) exported.whenToUse = customPrompts.whenToUse
			if (customPrompts.customInstructions) exported.customInstructions = customPrompts.customInstructions
		}
		return exported
	}

	const builtInArchitect = (): PromptComponent => ({
		roleDefinition: getRoleDefinition("architect"),
		description: getDescription("architect"),
		whenToUse: getWhenToUse("architect"),
		customInstructions: getCustomInstructions("architect"),
	})

	it("修正前: 事前投入のせいで組み込み customInstructions が上書きとして書き出されていた", () => {
		const leaked = legacyEdit("architect", SEEDED.architect, { roleDefinition: "MY ROLE" })

		expect(leaked.customInstructions).toBe(getCustomInstructions("architect"))
		// エクスポートは「ユーザーが指定した上書き」として同じ文面を書き出す。
		expect(mergeForExport(builtInArchitect(), leaked).customInstructions).toBe(getCustomInstructions("architect"))
	})

	it("修正後: 上書きは空なので、エクスポートは組み込みのまま（余計な上書きを持ち込まない）", () => {
		const persisted = buildPromptOverrideForReset("architect", SEEDED.architect, "roleDefinition")

		expect(persisted).toEqual({})
		expect(mergeForExport(builtInArchitect(), persisted)).toEqual(builtInArchitect())
	})

	it("修正後: ユーザーが本当に変えたフィールドだけがエクスポートに反映される", () => {
		const persisted = buildPromptOverrideForEdit("architect", SEEDED.architect, { roleDefinition: "MY ROLE" })
		const exported = mergeForExport(builtInArchitect(), persisted)

		expect(exported.roleDefinition).toBe("MY ROLE")
		// 他は組み込みのまま。上書き由来ではない。
		expect(exported.customInstructions).toBe(getCustomInstructions("architect"))
		expect(exported.whenToUse).toBe(getWhenToUse("architect"))
	})

	it("上書きが無い mode は customPrompts が undefined で渡り、エクスポートは組み込みのまま", () => {
		expect(mergeForExport(builtInArchitect(), undefined)).toEqual(builtInArchitect())
	})
})
