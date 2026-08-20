import { useCallback, useState } from "react"

import { availableGroups, emptyFieldErrors, type ModeDraft, type ModeFieldErrors } from "./modeFormLogic"

const emptyDraft = (): ModeDraft => ({
	name: "",
	slug: "",
	description: "",
	roleDefinition: "",
	whenToUse: "",
	customInstructions: "",
	groups: availableGroups,
	source: "global",
})

export interface ModeFormState {
	draft: ModeDraft
	/** 1 フィールドだけ差し替える。 */
	setField: <K extends keyof ModeDraft>(key: K, value: ModeDraft[K]) => void
	/** 複数フィールドをまとめて差し替える（名前入力から slug を同時に決める場合など）。 */
	patch: (values: Partial<ModeDraft>) => void
	errors: ModeFieldErrors
	setErrors: (errors: ModeFieldErrors) => void
	/** 下書きとエラーを初期状態へ戻す。 */
	reset: () => void
}

/**
 * 「モードを新規作成する」フォームの状態を所有する。
 *
 * ModesView が下書き 8 個とエラー 5 個を個別の `useState` で持っていたものを 1 つにまとめた。
 * 13 個が常に一緒に初期化され一緒に破棄される（ダイアログを開くたび reset される）ので、
 * 所有者を 1 つにするとリセット漏れが構造的に起きなくなる。
 */
export function useModeFormState(): ModeFormState {
	const [draft, setDraft] = useState<ModeDraft>(emptyDraft)
	const [errors, setErrors] = useState<ModeFieldErrors>(emptyFieldErrors)

	const patch = useCallback((values: Partial<ModeDraft>) => {
		setDraft((current) => ({ ...current, ...values }))
	}, [])

	const setField = useCallback<ModeFormState["setField"]>(
		(key, value) => {
			patch({ [key]: value } as Partial<ModeDraft>)
		},
		[patch],
	)

	const reset = useCallback(() => {
		setDraft(emptyDraft())
		setErrors(emptyFieldErrors)
	}, [])

	return { draft, setField, patch, errors, setErrors, reset }
}
