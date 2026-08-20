import { ModeConfig, GroupEntry, ToolGroup, modeConfigSchema } from "@openai-agent/types"

import { TOOL_GROUPS } from "@agent/tools"

/**
 * モード編集 UI に出すツールグループ。
 * 常時利用可能なグループは選択の意味が無いので除く。
 */
export const availableGroups = (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter(
	(group) => !TOOL_GROUPS[group].alwaysAvailable,
)

export type ModeSource = "global" | "project"

/** 作成フォームが保持する下書き。まだ検証されていない生の入力。 */
export interface ModeDraft {
	name: string
	slug: string
	description: string
	roleDefinition: string
	whenToUse: string
	customInstructions: string
	groups: GroupEntry[]
	source: ModeSource
}

/** フィールドごとのエラー文言。空文字は「エラー無し」。 */
export interface ModeFieldErrors {
	name: string
	slug: string
	description: string
	roleDefinition: string
	groups: string
}

export const emptyFieldErrors: ModeFieldErrors = {
	name: "",
	slug: "",
	description: "",
	roleDefinition: "",
	groups: "",
}

/** エラー表示の対象になるフィールド（zod の path 先頭がこれらのときだけ拾う）。 */
const ERROR_FIELDS = ["name", "slug", "description", "roleDefinition", "groups"] as const

/** グループ指定は `"read"` か `["read", {...}]` の 2 形式を取る。 */
export function getGroupName(group: GroupEntry): ToolGroup {
	return Array.isArray(group) ? group[0] : group
}

/**
 * 表示名から slug を作る。
 *
 * 英数字とハイフン以外を全てハイフンに畳み、前後のハイフンを落とす。
 * `attempt` は名前が衝突したときの連番で、0 のときは付けない。
 */
export function generateSlug(name: string, attempt = 0): string {
	const baseSlug = name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")

	return attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`
}

/** 名前か slug のどちらかが既存モードと衝突しているか。 */
export function isNameOrSlugTaken(modes: readonly ModeConfig[], name: string, slug: string): boolean {
	return modes.some((m) => m.slug === slug || m.name === name)
}

/**
 * 未使用の「新規モード名 + slug」を決める。
 *
 * `New Custom Mode` → 衝突したら `New Custom Mode 2`, `New Custom Mode 3`… と繰り上げる
 * （表示番号は attempt + 1 なので 1 は飛ばす）。
 */
export function buildUniqueModeIdentity(
	modes: readonly ModeConfig[],
	baseNamePrefix: string,
): { name: string; slug: string } {
	let attempt = 0
	let name = baseNamePrefix
	let slug = generateSlug(name)

	while (isNameOrSlugTaken(modes, name, slug)) {
		attempt++
		name = `${baseNamePrefix} ${attempt + 1}`
		slug = generateSlug(name)
	}

	return { name, slug }
}

/**
 * 下書きから保存用の `ModeConfig` を組み立てる。
 *
 * 任意項目は trim して空なら `undefined` にする（空文字を保存すると
 * 「設定されている空の値」として扱われてしまうため）。
 */
export function buildModeConfig(draft: ModeDraft): ModeConfig {
	return {
		slug: draft.slug,
		name: draft.name,
		description: draft.description.trim() || undefined,
		roleDefinition: draft.roleDefinition.trim(),
		whenToUse: draft.whenToUse.trim() || undefined,
		customInstructions: draft.customInstructions.trim() || undefined,
		groups: draft.groups,
		source: draft.source,
	}
}

export type ModeValidationResult =
	| { ok: true; mode: ModeConfig }
	| { ok: false; mode: ModeConfig; errors: ModeFieldErrors }

/**
 * 下書きを検証し、失敗時は zod のエラーをフィールド別の文言に振り分ける。
 *
 * 表示対象外のフィールド（source など）のエラーは既存挙動どおり握り潰される
 * ＝ どこにも出ないので、スキーマを変えるときは {@link ERROR_FIELDS} も見直すこと。
 */
export function validateModeDraft(draft: ModeDraft): ModeValidationResult {
	const mode = buildModeConfig(draft)
	const result = modeConfigSchema.safeParse(mode)

	if (result.success) {
		return { ok: true, mode }
	}

	const errors = { ...emptyFieldErrors }

	for (const issue of result.error.errors) {
		const field = issue.path[0] as string

		if ((ERROR_FIELDS as readonly string[]).includes(field)) {
			errors[field as keyof ModeFieldErrors] = issue.message
		}
	}

	return { ok: false, mode, errors }
}

/**
 * ツールグループのチェックを切り替えた結果のグループ一覧を返す。
 *
 * 追加は末尾に足し、解除は形式（文字列 / タプル）を問わず同名のものを取り除く。
 */
export function toggleGroup(groups: readonly GroupEntry[], group: ToolGroup, checked: boolean): GroupEntry[] {
	if (checked) {
		return [...groups, group]
	}

	return groups.filter((g) => getGroupName(g) !== group)
}

/**
 * ローカルのリネーム（保存前の暫定名）をモード一覧に反映する。
 *
 * 保存が確定するまでは元の `modes` を書き換えたくないので、表示用のコピーを作る。
 */
export function applyLocalRenames(
	modes: readonly ModeConfig[] | undefined,
	localRenames: Record<string, string>,
): ModeConfig[] {
	return (modes || []).map((m) => (localRenames[m.slug] ? { ...m, name: localRenames[m.slug] } : m))
}

/**
 * 検索文字列でモードを絞り込む。
 *
 * 突き合わせるのは表示名のみ（slug は対象外）。大文字小文字は無視する。
 * 空の検索文字列は「絞り込み無し」。
 */
export function filterModesBySearch(modes: readonly ModeConfig[], searchValue: string): ModeConfig[] {
	if (!searchValue) {
		return [...modes]
	}

	const needle = searchValue.toLowerCase()
	return modes.filter((modeConfig) => modeConfig.name.toLowerCase().includes(needle))
}
