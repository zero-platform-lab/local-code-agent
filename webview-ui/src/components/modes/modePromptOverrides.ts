import type { PromptComponent } from "@openai-agent/types"

import { getCustomInstructions, getDescription, getRoleDefinition, getWhenToUse, type Mode } from "@agent/modes"

/**
 * `customModePrompts` に保存する「組み込みプロンプトの上書き」を組み立てる純関数。
 *
 * このフィールドは**差分だけ**を持つ。組み込み既定と同じ値を入れてはいけない。入れると
 * 将来 既定を変更しても古い文面が上書きとして残り続け、エクスポートした mode の YAML にも
 * 混ざる。
 *
 * 分割前は `ModesView` の中に 2 経路が別々に書かれていて、それぞれ穴があった:
 *
 * - 編集経路: `roleDefinition` / `description` / `whenToUse` は既定と一致したら捨てていたが
 *   **`customInstructions` は捨てていなかった**。組み込み 5 mode のうち 4 つは既定の
 *   `customInstructions` を持つので、他のフィールドを編集しただけで既定文面が保存された。
 * - 「既定に戻す」経路: **捨てる処理が一切無かった**。戻す対象のキーを消すだけなので、
 *   残りのフィールドがそのまま保存された（上書きを消すための操作が上書きを増やしていた）。
 *
 * 呼び出し側の state が既定を事前投入していても安全になるよう、両経路が同じ scrub を通る。
 */

/** 上書きとして意味を持つフィールド。`description` も含む（ModeSelector が表示に使う）。 */
const OVERRIDABLE_FIELDS = ["roleDefinition", "description", "whenToUse", "customInstructions"] as const

type OverridableField = (typeof OVERRIDABLE_FIELDS)[number]

/** 組み込み既定の値。custom mode は対象外なので customModes は渡さない。 */
function builtInValue(mode: Mode, field: OverridableField): string {
	switch (field) {
		case "roleDefinition":
			return getRoleDefinition(mode)
		case "description":
			return getDescription(mode)
		case "whenToUse":
			return getWhenToUse(mode)
		case "customInstructions":
			return getCustomInstructions(mode)
	}
}

/**
 * 組み込み既定と一致するフィールドを落とす。
 *
 * `undefined` / 空文字も落とす。どちらも「上書きなし」と同じ意味で、保存すると
 * `customModePrompts[slug]` が空でないオブジェクトになり「カスタマイズ済み」に見えてしまう
 * （エクスポート経路がこの有無を見ている）。
 */
export function dropDefaultOverrides(prompt: PromptComponent, mode: Mode): PromptComponent {
	const scrubbed: Record<string, unknown> = { ...prompt }

	for (const field of OVERRIDABLE_FIELDS) {
		const value = scrubbed[field]

		if (value === undefined || value === "" || value === builtInValue(mode, field)) {
			delete scrubbed[field]
		}
	}

	return scrubbed as PromptComponent
}

/**
 * フィールドを編集したときに保存する上書き。
 * 既存の上書きへ変更を重ね、既定と同じになったものは落とす。
 */
export function buildPromptOverrideForEdit(
	mode: Mode,
	existingPrompt: PromptComponent | undefined,
	changes: PromptComponent,
): PromptComponent {
	return dropDefaultOverrides({ ...existingPrompt, ...changes }, mode)
}

/**
 * 「既定に戻す」を押したときに保存する上書き。
 *
 * 対象フィールドを消したうえで、**残りも** scrub する。事前投入された既定が
 * 巻き込まれて保存されるのを防ぐため（元の実装に無かった部分）。
 */
export function buildPromptOverrideForReset(
	mode: Mode,
	existingPrompt: PromptComponent | undefined,
	field: OverridableField,
): PromptComponent {
	const remaining = { ...existingPrompt }
	delete remaining[field]

	return dropDefaultOverrides(remaining, mode)
}
