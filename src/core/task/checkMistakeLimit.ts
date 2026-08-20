import type { ContentBlockParam } from "@openai-agent/types"
import type { ClineAskResponse } from "@openai-agent/types"

import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"

/**
 * 直近の consecutive mistake 回数がユーザー設定の上限に達していたら、
 * mistake_limit_reached ダイアログを webview に投げ、ユーザーからの追加指示を
 * 受け取って userContent への追加ブロックにして返す。
 *
 * Task の中核ループから切り出した純粋関数版。fired フラグでダイアログを
 * 実際に発火したかを呼び出し側に伝え、呼び出し側は `consecutiveMistakeCount`
 * を 0 にリセットするかどうかを判断する（現行動作: 発火したらリセット、
 * 追加コンテンツはユーザーが応答した時のみ）。
 */
export interface CheckMistakeLimitStateHost {
	mistakeTracker: { count: number; limit: number }
}

export interface CheckMistakeLimitDeps {
	host: CheckMistakeLimitStateHost
	ask: (
		type: "mistake_limit_reached",
		text?: string,
	) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>
	say: (type: "user_feedback", text: string, images?: string[]) => Promise<unknown>
}

export interface CheckMistakeLimitResult {
	/** currentUserContent に concat すべき追加ブロック（応答が無ければ空）。 */
	additionalContent: ContentBlockParam[]
	/** ダイアログを実際に投げたか。true なら呼び出し側で count をリセットする。 */
	fired: boolean
}

export async function checkMistakeLimit(deps: CheckMistakeLimitDeps): Promise<CheckMistakeLimitResult> {
	const { host } = deps
	if (!(host.mistakeTracker.limit > 0 && host.mistakeTracker.count >= host.mistakeTracker.limit)) {
		return { additionalContent: [], fired: false }
	}

	const { response, text, images } = await deps.ask(
		"mistake_limit_reached",
		t("common:errors.mistake_limit_guidance"),
	)

	if (response !== "messageResponse") {
		return { additionalContent: [], fired: true }
	}

	await deps.say("user_feedback", text ?? "", images)

	return {
		additionalContent: [
			{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
			...formatResponse.imageBlocks(images),
		],
		fired: true,
	}
}
