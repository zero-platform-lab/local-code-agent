import type { ModeConfig, PromptComponent } from "@openai-agent/types"

/**
 * mode をエクスポートするときに「ユーザーの上書き」を重ねる規則。
 *
 * `exportModeWithRules` の中の 4 行（`if (customPrompts.X) exportMode.X = ...`）を
 * 名前のある純関数にしたもの。元は 60 行のメソッドの途中にあり、fs と vscode を
 * まるごと mock しないと 1 ケースも確かめられなかった。
 *
 * ## エクスポートは「差分」ではなく「完全なスナップショット」
 *
 * 土台は組み込み（または custom）mode の全フィールドで、上書きがあるフィールドだけを
 * 差し替える。つまり **4 フィールドは常に出力に含まれる**。上書きが無い場合も
 * 組み込みの値が入る。
 *
 * この性質から、**組み込み既定と同じ値の上書きは出力に影響しない**（同じ値で上書きする
 * ので no-op）。`customModePrompts` に既定と同じ値が誤って保存されていても、
 * エクスポート結果は上書きが無い場合と**バイト単位で同一**になる。
 * ここに scrub は不要、という判断の根拠。
 *
 * 空文字と undefined も上書きとして扱わない（`if (value)` の falsy 判定）。
 */
export function applyPromptOverrides<T extends ModeConfig>(mode: T, customPrompts?: PromptComponent): T {
	if (!customPrompts) {
		return mode
	}

	const merged = { ...mode }

	if (customPrompts.roleDefinition) {
		merged.roleDefinition = customPrompts.roleDefinition
	}

	if (customPrompts.description) {
		merged.description = customPrompts.description
	}

	if (customPrompts.whenToUse) {
		merged.whenToUse = customPrompts.whenToUse
	}

	if (customPrompts.customInstructions) {
		merged.customInstructions = customPrompts.customInstructions
	}

	return merged
}
