import { validateSkillName as validateSkillNameShared, SkillNameValidationError } from "@openai-agent/types"

/**
 * スキル名の検証結果を翻訳キーに落とす。
 *
 * 権威は `@openai-agent/types` の `validateSkillName`（`SKILL_NAME_REGEX`）。
 * ここは「どのエラーをどう説明するか」だけを持つ。
 */
export function getSkillNameErrorTranslationKey(error: SkillNameValidationError): string {
	switch (error) {
		case SkillNameValidationError.Empty:
			return "settings:skills.validation.nameRequired"
		case SkillNameValidationError.TooLong:
			return "settings:skills.validation.nameTooLong"
		case SkillNameValidationError.InvalidFormat:
			return "settings:skills.validation.nameInvalid"
	}
}

/**
 * スキル名を検証し、エラーの翻訳キー（正しければ null）を返す。
 */
export function validateSkillName(name: string): string | null {
	const result = validateSkillNameShared(name)
	return result.valid ? null : getSkillNameErrorTranslationKey(result.error!)
}

/** ハイフンの位置が不正か（先頭・末尾・連続）。 */
function hasHyphenPlacementProblem(name: string): boolean {
	return /^-|-$|--/.test(name)
}

/**
 * 入力途中の名前に出す検証メッセージ。空欄は「まだ入力していない」だけなので出さない。
 *
 * 入力ハンドラが `[^a-z0-9-]` を除去しているため、ここに来る値は必ず小文字英数字と
 * ハイフンだけで構成される。したがって形式エラーの原因はハイフンの位置に限られるが、
 * 決め打ちにせず実際の並びを見て判定し、専用の文言に振り分ける
 * （汎用の「小文字英数字とハイフン」だけでは `foo-` の何が悪いのか伝わらない）。
 *
 * @returns エラーの翻訳キー。問題なし・未入力なら null。
 */
export function describeSkillNameProblem(name: string): string | null {
	if (!name) {
		return null
	}

	const error = validateSkillName(name)

	if (error === "settings:skills.validation.nameInvalid" && hasHyphenPlacementProblem(name)) {
		return "settings:skills.validation.nameHyphenPlacement"
	}

	return error
}
